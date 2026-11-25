import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { z } from "zod";
import { ApiError, esc, getJson } from "./http-json.js";
import { ToolInputError, type ToolDefinition } from "./types.js";

/** Currency conversion at European Central Bank reference rates (Frankfurter API: free, no API key). */
export const CURRENCY_TOOL: Tool = {
  name: "convert_currency",
  description:
    "Convert an amount between currencies using European Central Bank reference rates (updated each working day; historical dates supported). " +
    "Use this for 'how much is 100 USD in INR' instead of web_search or calculate. Use 3-letter ISO codes (USD, EUR, INR, GBP, JPY...). " +
    "'to' may list up to 5 currencies separated by commas. These are reference rates, not bank or card rates: say so when it matters. " +
    "Say the rates come from the ECB via frankfurter.dev; do not add [n] citation numbers to them.",
  input_schema: {
    type: "object",
    properties: {
      amount: { type: "number", description: "Amount to convert. Default 1." },
      from: { type: "string", description: "Source currency code, e.g. USD." },
      to: { type: "string", description: "Target currency code(s), comma separated, e.g. 'INR' or 'EUR,GBP'." },
      date: { type: "string", description: "Optional YYYY-MM-DD for a historical rate (not before 1999-01-04)." },
    },
    required: ["from", "to"],
  },
};

const code = z.string().trim().regex(/^[A-Za-z]{3}$/, "currency codes are 3 letters").transform((s) => s.toUpperCase());
const inputSchema = z.object({
  amount: z.number().finite().positive().max(1e15).optional(),
  from: code,
  to: z
    .string()
    .transform((s) => s.split(/[,\s]+/).filter(Boolean))
    .pipe(z.array(code).min(1).max(5)),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
type Input = z.infer<typeof inputSchema>;

type Rates = { amount?: number; base?: string; date?: string; rates?: Record<string, number> };

function money(n: number): string {
  const abs = Math.abs(n);
  return n.toLocaleString("en-US", { maximumFractionDigits: abs >= 1 ? 2 : 6 });
}

export const currencyTool: ToolDefinition<Input> = {
  name: "convert_currency",
  schema: CURRENCY_TOOL,
  effect: "read",
  approval: "network",
  actionLabel: "Convert currency",
  maxPerTurn: 6,
  timeoutMs: 12_000,
  retry: { retries: 1, backoffMs: 400 },
  label: (raw) => {
    const r = (raw && typeof raw === "object" ? raw : {}) as { amount?: unknown; from?: unknown; to?: unknown };
    return r.from && r.to ? `${r.amount ?? 1} ${String(r.from).toUpperCase()} to ${String(r.to).toUpperCase()}` : "convert currency";
  },
  validate: (raw) => {
    const p = inputSchema.safeParse(raw);
    if (!p.success) throw new ToolInputError("invalid convert_currency input: from and to need 3-letter currency codes (up to 5 targets), amount must be positive, date is YYYY-MM-DD");
    return p.data;
  },
  dedupeKey: (i) => `${i.amount ?? 1}|${i.from}|${i.to.join(",")}|${i.date ?? "latest"}`,
  run: async (input, ctx) => {
    const amount = input.amount ?? 1;
    const targets = input.to.filter((t) => t !== input.from);
    const label = `${amount} ${input.from} to ${input.to.join(", ")}`;
    if (targets.length === 0) {
      return { content: `<currency_conversion from="${input.from}" amount="${amount}" note="same currency">${money(amount)} ${input.from}</currency_conversion>`, label };
    }
    try {
      const path = input.date ?? "latest";
      const data = await getJson<Rates>(
        `https://api.frankfurter.dev/v1/${path}?base=${input.from}&symbols=${targets.join(",")}`,
        ctx.signal,
      );
      const rates = data.rates ?? {};
      const lines = [
        `<currency_conversion from="${input.from}" amount="${amount}" rate_date="${esc(data.date ?? path)}" source="European Central Bank via frankfurter.dev" note="reference rates, not bank or card rates">`,
      ];
      const missing: string[] = [];
      for (const t of targets) {
        const rate = rates[t];
        if (typeof rate !== "number") missing.push(t);
        else lines.push(`${money(amount)} ${input.from} = ${money(amount * rate)} ${t} (1 ${input.from} = ${rate} ${t})`);
      }
      if (missing.length) lines.push(`not available: ${esc(missing.join(", "))}`);
      lines.push("</currency_conversion>");
      if (missing.length === targets.length) return { content: lines.join("\n"), label, error: `no rate for ${missing.join(", ")}` };
      return { content: lines.join("\n"), label };
    } catch (e) {
      const msg =
        e instanceof ApiError && (e.status === 404 || e.status === 422)
          ? `unknown currency code or date (${input.from} -> ${input.to.join(",")}${input.date ? ` on ${input.date}` : ""})`
          : e instanceof ApiError
            ? `exchange-rate service error: ${e.message}`
            : e instanceof Error
              ? e.message
              : "currency lookup failed";
      return { content: `<currency_conversion from="${input.from}" error="${esc(msg)}"/>`, label, error: msg };
    }
  },
  declined: (label) => `<currency_conversion error="the user declined this currency lookup (${esc(label)})"/>`,
  errorContent: (label, error) => `<currency_conversion error="${esc(error)}" request="${esc(label)}"/>`,
};
