import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { z } from "zod";
import { bm25Score, tokenize } from "../memory/bm25.js";
import { MemoryStore, type TurnWithContent } from "../memory/store.js";
import { ToolInputError, type ToolDefinition } from "./types.js";
import { getClock } from "../clock.js";

/** Called from src/tools/registry.ts. Reads turns via MemoryStore (schema.sql turns/messages); no writes. The model-invoked complement of the automatic <memory> recall. */
export const MEMORY_SEARCH_TOOL: Tool = {
  name: "memory_search",
  description:
    "Search the user's earlier conversations stored in this app (not the live web). Use when they refer to something discussed before without a clear date, or when <memory> was a miss and you need a broader topic search. Do not use for current facts.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Topic keywords to find in past questions/answers, 2-12 words.",
      },
      date: {
        type: "string",
        description: "Optional YYYY-MM-DD to restrict to that local calendar day.",
      },
      limit: {
        type: "number",
        description: "Max results (1-8). Default 5.",
      },
    },
    required: ["query"],
  },
};

/** Registry definition (src/tools/registry.ts). */
export const memorySearchTool: ToolDefinition<{ query: string; date?: string; limit?: number }> = {
  name: "memory_search",
  schema: MEMORY_SEARCH_TOOL,
  effect: "read",
  actionLabel: "Memory search",
  needs: ["db"],
  label: (raw) => (raw && typeof raw === "object" && typeof (raw as { query?: unknown }).query === "string" ? (raw as { query: string }).query : "") || "memory search",
  validate: (raw) => {
    const p = inputSchema.safeParse(raw);
    if (!p.success) throw new ToolInputError("invalid memory_search input");
    return p.data;
  },
  run: async (input, ctx) => {
    const res = runMemorySearch(ctx.store ?? new MemoryStore(ctx.db), input);
    return { content: res.xml, label: res.query, error: res.error };
  },
  errorContent: (_label, error) => `<memory_results error="${esc(error)}"/>`,
};

const inputSchema = z.object({
  query: z.string().min(1),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  limit: z.number().int().min(1).max(8).optional(),
});

export type MemorySearchResult = {
  query: string;
  xml: string;
  ms: number;
  count: number;
  error?: string;
};

export function runMemorySearch(
  store: MemoryStore,
  raw: unknown,
  opts: { excludeTurnId?: string; statementsOnly?: boolean } = {},
): MemorySearchResult {
  const t0 = getClock().now().getTime();
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      query: "",
      count: 0,
      ms: 0,
      error: "invalid memory_search input",
      xml: `<memory_results error="invalid memory_search input"/>`,
    };
  }
  const { query, date } = parsed.data;
  const limit = parsed.data.limit ?? 5;
  const topic = tokenize(query).join(" ");
  if (!topic) {
    return {
      query,
      count: 0,
      ms: getClock().now().getTime() - t0,
      xml: `<memory_results query="${esc(query)}" count="0"/>`,
    };
  }

  let candidates: TurnWithContent[];
  if (date) {
    candidates = store.turnsInDateRange(date, date);
  } else {
    candidates = store.allTurnsForRanking().slice(0, 400);
  }

  if (opts.excludeTurnId) candidates = candidates.filter((t) => t.id !== opts.excludeTurnId);
  if (opts.statementsOnly) {
    // Facts the user told us ("my favorite color is blue"), not their questions or our earlier "no record" replies.
    candidates = candidates.filter((t) => {
      const q = t.user_question.trim();
      return !q.endsWith("?") && !/^(what|who|when|where|why|how|do|does|did|can|could|is|are|tell|remind)\b/i.test(q);
    });
  }

  const docs = candidates.map(
    (t) => `${t.user_question}\n${t.assistant_answer ?? ""}\n${t.topic ?? ""}`,
  );
  const ranked = candidates
    .map((t, i) => ({ t, score: bm25Score(topic, docs[i]!, docs) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const lines = [
    `<memory_results query="${esc(query)}" count="${ranked.length}" note="past conversations, not live facts">`,
  ];
  for (const { t, score } of ranked) {
    const q = clip(t.user_question, 240);
    const a = clip(t.assistant_answer ?? "", 400);
    lines.push(
      `<turn date="${esc(t.local_date)}" score="${score.toFixed(2)}">`,
      `Q: ${esc(q)}`,
      a ? `A: ${esc(a)}` : "",
      `</turn>`,
    );
  }
  lines.push(`</memory_results>`);
  return {
    query,
    count: ranked.length,
    ms: getClock().now().getTime() - t0,
    xml: lines.filter(Boolean).join("\n"),
  };
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
