import { z } from "zod";
import { CalcError, type CalcOutput } from "./calc/errors.js";
import { evaluateDate, looksLikeDate, resolveZone } from "./calc/dates.js";
import { evaluateMath, MAX_INPUT_CHARS } from "./calc/parser.js";
import { convertUnits } from "./calc/units.js";
import { ToolInputError, type ToolDefinition } from "./types.js";

/**
 * calculate: exact, offline arithmetic / percentages / unit conversion / date arithmetic / time-zone conversion.
 * Everything runs through hand-written parsers (no eval, Function or vm) with hard input, token, depth and
 * magnitude caps. Dates use the app clock (src/clock.ts) for "today" / "now".
 */

const InputSchema = z
  .object({
    expression: z
      .string({ required_error: "expression is required", invalid_type_error: "expression must be a string" })
      .trim()
      .min(1, "expression must not be empty")
      .max(MAX_INPUT_CHARS, `expression is too long (limit ${MAX_INPUT_CHARS} characters)`),
    mode: z.enum(["math", "convert", "date"]).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export type CalculateInput = z.infer<typeof InputSchema>;

const DESCRIPTION = [
  "Exact, offline calculator. USE IT for: arithmetic and math (+ - * / % ^, parentheses, sqrt, ln, log, sin, round, min/max, factorial, pi, e),",
  "percentages, unit conversion, date arithmetic and time-zone conversion. Do the maths here instead of in your head, and do NOT call web_search for anything this tool computes.",
  "",
  "Examples by kind:",
  '- math: "(1250 * 1.18) - 40", "2^10", "sqrt(2) * 3", "15% of 240", "240 + 15%" (= 240 * 1.15), "what percent of 80 is 20", "20 is what percent of 80", "percent change from 50 to 75". Percent is postfix; "10 % 3" is modulo. Write * explicitly (no 2pi). Trig uses radians.',
  '- convert: "5 miles to km", "72 F to C", "100 km/h to m/s", "1 GiB to MB", "2 cups to ml". Supports length, mass, volume, temperature, speed, area, time, data size (decimal and binary), energy and pressure. Incompatible or unknown units return an error (never guessed).',
  '- date: "2026-11-24 + 90 days", "today + 2 weeks", "days until 2026-12-25", "days between 2026-01-01 and 2026-03-05", "day of week 2026-12-25", "9am IST in America/New_York", "14:30 PST to Asia/Tokyo". "today"/"now" come from the app clock in `timezone` (default UTC).',
  "",
  "Time zones: prefer IANA names (America/New_York, Asia/Kolkata). Abbreviations UTC, GMT, PST, PDT, EST, EDT, CET, CEST, JST are fixed offsets. IST is read as India Standard Time (UTC+05:30). CST and BST are ambiguous and rejected.",
  "Currency conversion is NOT supported (exchange rates change): use web_search for rates, then calculate the amounts with this tool.",
  "`mode` is optional; it is auto-detected from the expression. Set it only to force one interpretation.",
].join("\n");

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function exprOf(raw: unknown): string {
  return raw && typeof raw === "object" && typeof (raw as { expression?: unknown }).expression === "string"
    ? (raw as { expression: string }).expression.replace(/\s+/g, " ").trim()
    : "";
}

const CONVERT_SHAPE = /^[+-]?[\d.,]+(?:e[+-]?\d+)?\s*[^\d\s].*\s(?:to|in|into|as|->)\s+\S/i;

function detectMode(expr: string): "math" | "convert" | "date" {
  if (looksLikeDate(expr)) return "date";
  if (CONVERT_SHAPE.test(expr)) return "convert";
  return "math";
}

function errorElement(expression: string, message: string): string {
  return `<calculation expression="${esc(expression)}" error="${esc(message)}"/>`;
}

export const calculateTool: ToolDefinition<CalculateInput> = {
  name: "calculate",
  schema: {
    name: "calculate",
    description: DESCRIPTION,
    input_schema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          maxLength: MAX_INPUT_CHARS,
          description:
            'The expression to evaluate, e.g. "15% of 240", "5 miles to km", "2026-11-24 + 90 days", "9am IST in America/New_York".',
        },
        mode: {
          type: "string",
          enum: ["math", "convert", "date"],
          description: "Optional. Forces how the expression is read; auto-detected when omitted.",
        },
        timezone: {
          type: "string",
          description:
            'Optional IANA zone or abbreviation used for "today"/"now" and for times without a zone (default UTC), e.g. "Asia/Kolkata".',
        },
      },
      required: ["expression"],
      additionalProperties: false,
    },
  },
  effect: "read",
  actionLabel: "Calculate",
  maxPerTurn: 12,
  timeoutMs: 2000,
  label: (raw) => {
    const e = exprOf(raw);
    if (!e) return "calculate";
    return e.length > 80 ? `${e.slice(0, 79)}…` : e;
  },
  validate: (raw) => {
    const parsed = InputSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ToolInputError(`invalid calculate input: ${parsed.error.issues[0]?.message ?? "bad arguments"}`);
    }
    if (parsed.data.timezone) {
      try {
        resolveZone(parsed.data.timezone);
      } catch (e) {
        throw new ToolInputError(`invalid calculate input: ${e instanceof CalcError ? e.message : "bad timezone"}`);
      }
    }
    return parsed.data;
  },
  dedupeKey: (input) =>
    JSON.stringify([input.expression.replace(/\s+/g, " ").trim().toLowerCase(), input.mode ?? "", (input.timezone ?? "").toLowerCase()]),
  run: async (input) => {
    const expression = input.expression;
    const kind = input.mode ?? detectMode(expression);
    try {
      let out: CalcOutput;
      if (kind === "date") out = evaluateDate(expression, { timezone: input.timezone });
      else if (kind === "convert") out = convertUnits(expression);
      else out = evaluateMath(expression);
      return {
        content: `<calculation expression="${esc(expression)}" kind="${kind}" result="${esc(out.result)}">${esc(out.text)}</calculation>`,
      };
    } catch (e) {
      const message = e instanceof CalcError ? e.message : "could not evaluate this expression";
      return { content: errorElement(expression, message), error: message };
    }
  },
  declined: (label) => errorElement(label, "the user declined this calculation"),
  errorContent: (label, error) => errorElement(label, error),
};
