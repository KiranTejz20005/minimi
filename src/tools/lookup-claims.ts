import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getClock } from "../clock.js";
import { ToolInputError, type ToolDefinition } from "./types.js";

/** Called from src/tools/registry.ts. Reads schema.sql claims+turns; no writes. */
export const LOOKUP_CLAIMS_TOOL: Tool = {
  name: "lookup_claims",
  description:
    "Look up structured facts previously extracted from your answers (subject / attribute / value / as_of). Use before re-checking whether something from memory is still true, so you know exact claims to verify with web_search.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Subject or keywords, e.g. 'Postgres hosting price'.",
      },
      limit: {
        type: "number",
        description: "Max claims (1-20). Default 10.",
      },
    },
    required: ["query"],
  },
};

/** Registry definition (src/tools/registry.ts). */
export const lookupClaimsTool: ToolDefinition<{ query: string; limit?: number }> = {
  name: "lookup_claims",
  schema: LOOKUP_CLAIMS_TOOL,
  effect: "read",
  actionLabel: "Lookup claims",
  needs: ["db"],
  label: (raw) => (raw && typeof raw === "object" && typeof (raw as { query?: unknown }).query === "string" ? (raw as { query: string }).query : "") || "lookup claims",
  validate: (raw) => {
    const p = inputSchema.safeParse(raw);
    if (!p.success) throw new ToolInputError("invalid lookup_claims input");
    return p.data;
  },
  run: async (input, ctx) => {
    const res = runLookupClaims(ctx.db, input);
    return { content: res.xml, label: res.query, error: res.error };
  },
  errorContent: (_label, error) => `<claims error="${esc(error)}"/>`,
};

const inputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(20).optional(),
});

export type LookupClaimsResult = {
  query: string;
  xml: string;
  ms: number;
  count: number;
  error?: string;
};

export function runLookupClaims(db: DatabaseSync, raw: unknown): LookupClaimsResult {
  const t0 = getClock().now().getTime();
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      query: "",
      count: 0,
      ms: 0,
      error: "invalid lookup_claims input",
      xml: `<claims error="invalid lookup_claims input"/>`,
    };
  }
  const q = parsed.data.query.trim();
  const limit = parsed.data.limit ?? 10;
  const like = `%${q.replace(/[%_]/g, "")}%`;
  const rows = db
    .prepare(
      `SELECT c.subject, c.attribute, c.value, c.as_of, c.source_url, c.volatility, t.local_date
       FROM claims c
       JOIN turns t ON t.id = c.turn_id
       WHERE t.status = 'ok'
         AND (c.subject LIKE ? OR c.attribute LIKE ? OR c.value LIKE ? OR IFNULL(c.source_url,'') LIKE ?)
       ORDER BY t.created_at DESC
       LIMIT ?`,
    )
    .all(like, like, like, like, limit) as {
    subject: string;
    attribute: string;
    value: string;
    as_of: string;
    source_url: string | null;
    volatility: string;
    local_date: string;
  }[];

  const lines = [`<claims query="${esc(q)}" count="${rows.length}">`];
  for (const r of rows) {
    lines.push(
      `<claim date="${esc(r.local_date)}" as_of="${esc(r.as_of)}" volatility="${esc(r.volatility)}">`,
      `${esc(r.subject)} · ${esc(r.attribute)} = ${esc(r.value)}`,
      r.source_url ? `source: ${esc(r.source_url)}` : "",
      `</claim>`,
    );
  }
  lines.push(`</claims>`);
  return {
    query: q,
    count: rows.length,
    ms: getClock().now().getTime() - t0,
    xml: lines.filter(Boolean).join("\n"),
  };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
