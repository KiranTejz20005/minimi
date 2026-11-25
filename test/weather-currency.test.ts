import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnCitationRegistry } from "../src/search/tool.js";
import { executeToolCall, getTool, type ToolContext } from "../src/tools/registry.js";
import { getJson } from "../src/tools/http-json.js";

const ctx = (): ToolContext => ({ db: {} as never, registry: new TurnCitationRegistry(), counts: {} });
const run = (name: string, input: unknown) => executeToolCall({ id: "c", name, input }, ctx(), true);

function mockFetch(routes: Record<string, unknown | number>) {
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => {
    const url = String(u);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("{}", { status: 404 });
    const v = routes[key];
    return typeof v === "number" ? new Response("{}", { status: v }) : new Response(JSON.stringify(v), { status: 200 });
  });
  return spy;
}
afterEach(() => vi.restoreAllMocks());

describe("registration", () => {
  it("both tools are registered, network-approved reads", () => {
    for (const n of ["get_weather", "convert_currency"]) {
      expect(getTool(n)?.approval).toBe("network");
      expect(getTool(n)?.effect).toBe("read");
    }
  });
});

describe("get_weather", () => {
  const geo = { results: [{ name: "Pune", admin1: "Maharashtra", country: "India", latitude: 18.5, longitude: 73.8 }] };
  const fc = {
    timezone: "Asia/Kolkata",
    current: { time: "2026-11-25T10:00", temperature_2m: 24.4, apparent_temperature: 24.1, relative_humidity_2m: 46, wind_speed_10m: 6.4, weather_code: 2, precipitation: 0 },
    daily: { time: ["2026-11-25"], temperature_2m_max: [30], temperature_2m_min: [17], precipitation_probability_max: [10], weather_code: [1] },
  };
  it("formats current weather and forecast", async () => {
    mockFetch({ "geocoding-api": geo, "api.open-meteo.com/v1/forecast": fc });
    const r = await run("get_weather", { location: "Pune", days: 1 });
    expect(r.error).toBeUndefined();
    expect(r.content).toContain("Pune, Maharashtra, India");
    expect(r.content).toContain("partly cloudy");
    expect(r.content).toContain("rain chance 10%");
  });
  it("reports an unknown place as an error", async () => {
    mockFetch({ "geocoding-api": {} });
    const r = await run("get_weather", { location: "Zzqxville" });
    expect(r.error).toMatch(/could not find/);
  });
  it("service failure becomes a readable error, not a throw", async () => {
    mockFetch({ "geocoding-api": 500 });
    expect((await run("get_weather", { location: "Pune" })).error).toBeTruthy();
  });
  it("rejects bad input", async () => {
    expect((await run("get_weather", { location: "x" })).error).toMatch(/invalid/);
    expect((await run("get_weather", { location: "Pune", days: 99 })).error).toMatch(/invalid/);
  });
});

describe("convert_currency", () => {
  it("converts to several currencies", async () => {
    const spy = mockFetch({ "frankfurter.dev/v1/latest": { date: "2026-11-24", rates: { INR: 92.92, EUR: 0.91216 } } });
    const r = await run("convert_currency", { amount: 100, from: "usd", to: "inr, eur" });
    expect(r.error).toBeUndefined();
    expect(r.content).toContain("100 USD = 9,292 INR");
    expect(r.content).toContain('rate_date="2026-11-24"');
    expect(String(spy.mock.calls[0]![0])).toContain("base=USD&symbols=INR,EUR");
  });
  it("uses the historical endpoint for a date", async () => {
    const spy = mockFetch({ "frankfurter.dev/v1/2024-01-02": { date: "2024-01-02", rates: { EUR: 0.9 } } });
    await run("convert_currency", { from: "USD", to: "EUR", date: "2024-01-02" });
    expect(String(spy.mock.calls[0]![0])).toContain("/v1/2024-01-02");
  });
  it("same currency needs no network", async () => {
    const spy = mockFetch({});
    const r = await run("convert_currency", { amount: 5, from: "USD", to: "USD" });
    expect(r.content).toContain("5 USD");
    expect(spy).not.toHaveBeenCalled();
  });
  it("unknown currency -> readable error", async () => {
    mockFetch({ "frankfurter.dev": 404 });
    expect((await run("convert_currency", { from: "USD", to: "XYZ" })).error).toMatch(/unknown currency/);
  });
  it("rejects malformed codes and amounts", async () => {
    for (const bad of [{ from: "US", to: "EUR" }, { from: "USD", to: "EURO" }, { from: "USD", to: "EUR", amount: -5 }, { from: "USD", to: "EUR", date: "yesterday" }]) {
      expect((await run("convert_currency", bad)).error, JSON.stringify(bad)).toMatch(/invalid/);
    }
  });
});

describe("http-json is locked to its allowlist", () => {
  it("refuses other hosts, http and IPs", async () => {
    await expect(getJson("https://evil.example/x")).rejects.toThrow(/not allowed/);
    await expect(getJson("http://api.open-meteo.com/x")).rejects.toThrow(/not allowed/);
    await expect(getJson("https://127.0.0.1/x")).rejects.toThrow(/not allowed/);
  });
});
