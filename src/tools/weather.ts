import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { z } from "zod";
import { ApiError, esc, getJson } from "./http-json.js";
import { ToolInputError, type ToolDefinition } from "./types.js";

/** Current weather and a short forecast for a named place. Open-Meteo: free, no API key. */
export const WEATHER_TOOL: Tool = {
  name: "get_weather",
  description:
    "Get the current weather and a 1-7 day forecast for a city or place name (temperature, feels-like, humidity, wind, rain chance). " +
    "Use this for any weather or 'do I need an umbrella' question instead of web_search. Units default to metric; pass units='imperial' for °F/mph. " +
    "Say the data comes from Open-Meteo; do not add [n] citation numbers to it.",
  input_schema: {
    type: "object",
    properties: {
      location: { type: "string", description: "City or place, e.g. 'Pune' or 'Paris, France'." },
      days: { type: "number", description: "Forecast days, 1-7. Default 3." },
      units: { type: "string", enum: ["metric", "imperial"], description: "Default metric." },
    },
    required: ["location"],
  },
};

const inputSchema = z.object({
  location: z.string().trim().min(2).max(100),
  days: z.number().int().min(1).max(7).optional(),
  units: z.enum(["metric", "imperial"]).optional(),
});
type Input = z.infer<typeof inputSchema>;

type Geo = { results?: { name: string; admin1?: string; country?: string; latitude: number; longitude: number; timezone?: string }[] };
type Forecast = {
  timezone?: string;
  current?: { time?: string; temperature_2m?: number; apparent_temperature?: number; relative_humidity_2m?: number; wind_speed_10m?: number; weather_code?: number; precipitation?: number };
  daily?: { time?: string[]; temperature_2m_max?: number[]; temperature_2m_min?: number[]; precipitation_probability_max?: (number | null)[]; weather_code?: number[] };
};

/** WMO weather interpretation codes -> words. */
const WMO: Record<number, string> = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "rime fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "heavy freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "heavy freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains", 80: "light showers", 81: "showers", 82: "violent showers",
  85: "light snow showers", 86: "snow showers", 95: "thunderstorm", 96: "thunderstorm with hail", 99: "severe thunderstorm with hail",
};
const sky = (code: number | undefined) => (code === undefined ? "unknown" : (WMO[code] ?? `weather code ${code}`));

export const weatherTool: ToolDefinition<Input> = {
  name: "get_weather",
  schema: WEATHER_TOOL,
  effect: "read",
  approval: "network",
  actionLabel: "Check weather",
  maxPerTurn: 6,
  timeoutMs: 12_000,
  retry: { retries: 1, backoffMs: 400 },
  label: (raw) => (raw && typeof raw === "object" && typeof (raw as { location?: unknown }).location === "string" ? (raw as { location: string }).location.trim() : "") || "weather",
  validate: (raw) => {
    const p = inputSchema.safeParse(raw);
    if (!p.success) throw new ToolInputError("invalid get_weather input: location (2-100 chars) is required, days 1-7, units metric|imperial");
    return p.data;
  },
  dedupeKey: (i) => `${i.location.toLowerCase()}|${i.days ?? 3}|${i.units ?? "metric"}`,
  run: async (input, ctx) => {
    try {
      const geo = await getJson<Geo>(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(input.location)}&count=1&language=en&format=json`,
        ctx.signal,
      );
      const place = geo.results?.[0];
      if (!place) {
        const msg = `could not find a place called "${input.location}"`;
        return { content: `<weather location="${esc(input.location)}" error="${esc(msg)}"/>`, error: msg };
      }
      const imperial = input.units === "imperial";
      const days = input.days ?? 3;
      const q = new URLSearchParams({
        latitude: String(place.latitude),
        longitude: String(place.longitude),
        current: "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,precipitation",
        daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code",
        timezone: "auto",
        forecast_days: String(days),
        ...(imperial ? { temperature_unit: "fahrenheit", wind_speed_unit: "mph", precipitation_unit: "inch" } : {}),
      });
      const f = await getJson<Forecast>(`https://api.open-meteo.com/v1/forecast?${q}`, ctx.signal);
      const tu = imperial ? "°F" : "°C";
      const wu = imperial ? "mph" : "km/h";
      const where = [place.name, place.admin1, place.country].filter(Boolean).join(", ");
      const c = f.current;
      const lines = [`<weather location="${esc(where)}" timezone="${esc(f.timezone ?? place.timezone ?? "")}" source="Open-Meteo (open-meteo.com)" note="forecast model data, not a live observation">`];
      if (c) {
        lines.push(
          `now (${esc(c.time ?? "")}): ${esc(sky(c.weather_code))}, ${c.temperature_2m}${tu} (feels ${c.apparent_temperature}${tu}), humidity ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} ${wu}, precipitation ${c.precipitation} ${imperial ? "in" : "mm"}`,
        );
      }
      const d = f.daily;
      for (let i = 0; d?.time && i < d.time.length; i++) {
        const rain = d.precipitation_probability_max?.[i];
        lines.push(`${d.time[i]}: ${esc(sky(d.weather_code?.[i]))}, ${d.temperature_2m_min?.[i]}-${d.temperature_2m_max?.[i]}${tu}${rain == null ? "" : `, rain chance ${rain}%`}`);
      }
      lines.push("</weather>");
      return { content: lines.join("\n"), label: where };
    } catch (e) {
      const msg = e instanceof ApiError ? `weather service error: ${e.message}` : e instanceof Error ? e.message : "weather lookup failed";
      return { content: `<weather location="${esc(input.location)}" error="${esc(msg)}"/>`, error: msg };
    }
  },
  declined: (label) => `<weather location="${esc(label)}" error="the user declined this weather lookup"/>`,
  errorContent: (label, error) => `<weather location="${esc(label)}" error="${esc(error)}"/>`,
};
