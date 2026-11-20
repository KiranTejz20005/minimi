import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import type { DatabaseSync } from "node:sqlite";
import type { SearchProvider } from "../search/types.js";
import {
  WEB_SEARCH_TOOL,
  TurnCitationRegistry,
  getSearchRunner,
  searchCapRemaining,
} from "../search/tool.js";
import { MemoryStore } from "../memory/store.js";
import { FETCH_URL_TOOL, runFetchUrl } from "./fetch-url.js";
import { MEMORY_SEARCH_TOOL, runMemorySearch } from "./memory-search.js";
import { LOOKUP_CLAIMS_TOOL, runLookupClaims } from "./lookup-claims.js";
import { getConfig } from "../config.js";

/** Called from src/agent/loop.ts. Replaces single SEARCH_TOOL list — no multi-tool registry exists. User: add more tools. */
export const AGENT_TOOLS: Tool[] = [
  WEB_SEARCH_TOOL,
  FETCH_URL_TOOL,
  MEMORY_SEARCH_TOOL,
  LOOKUP_CLAIMS_TOOL,
];

export type ToolContext = {
  db: DatabaseSync;
  store?: MemoryStore;
  searchProvider?: SearchProvider;
  registry: TurnCitationRegistry;
  signal?: AbortSignal;
  searchesUsed: number;
  fetchesUsed: number;
};

export type ToolExecResult = {
  id: string;
  name: string;
  label: string;
  content: string;
  ms: number;
  search?: {
    query: string;
    count: number;
    cached: boolean;
    results?: { title: string; url: string }[];
    error?: string;
  };
  error?: string;
  declined?: boolean;
};

const MAX_FETCHES_PER_TURN = 6;

export function labelForCall(name: string, input: unknown): string {
  if (name === "web_search") return field(input, "query") || "web search";
  if (name === "fetch_url") return field(input, "url") || "fetch page";
  if (name === "memory_search") return field(input, "query") || "memory search";
  if (name === "lookup_claims") return field(input, "query") || "lookup claims";
  return name;
}

function field(input: unknown, key: string): string {
  if (input && typeof input === "object" && key in input) {
    return String((input as Record<string, unknown>)[key] ?? "");
  }
  return "";
}

export async function executeToolCall(
  call: { id: string; name: string; input: unknown },
  ctx: ToolContext,
  allowed: boolean,
): Promise<ToolExecResult> {
  const label = labelForCall(call.name, call.input);

  if (!allowed) {
    return {
      id: call.id,
      name: call.name,
      label,
      ms: 0,
      declined: true,
      error: "declined by user",
      content: declinedXml(call.name, label),
      search:
        call.name === "web_search"
          ? { query: label, count: 0, cached: false, error: "declined by user", results: [] }
          : undefined,
    };
  }

  if (call.name === "web_search") {
    if (searchCapRemaining(ctx.searchesUsed) <= 0) {
      return {
        id: call.id,
        name: call.name,
        label,
        ms: 0,
        error: "search limit reached for this turn",
        content: `<search_results query="${esc(label)}" error="search limit reached for this turn"/>`,
        search: {
          query: label,
          count: 0,
          cached: false,
          error: "search limit reached for this turn",
          results: [],
        },
      };
    }
    const runner = getSearchRunner(ctx.searchProvider);
    const res = await runner.run(call.input, ctx.registry, ctx.signal);
    ctx.searchesUsed += 1;
    return {
      id: call.id,
      name: call.name,
      label: res.query || label,
      content: res.xml,
      ms: res.ms,
      error: res.error,
      search: {
        query: res.query,
        count: res.count,
        cached: res.cached,
        results: (res.sources ?? []).map((s) => ({ title: s.title, url: s.url })),
        error: res.error,
      },
    };
  }

  if (call.name === "fetch_url") {
    if (ctx.fetchesUsed >= MAX_FETCHES_PER_TURN) {
      return {
        id: call.id,
        name: call.name,
        label,
        ms: 0,
        error: "fetch limit reached for this turn",
        content: `<page url="${esc(label)}" error="fetch limit reached for this turn"/>`,
      };
    }
    const res = await runFetchUrl(call.input, ctx.signal);
    ctx.fetchesUsed += 1;
    return {
      id: call.id,
      name: call.name,
      label: res.url || label,
      content: res.xml,
      ms: res.ms,
      error: res.error,
    };
  }

  if (call.name === "memory_search") {
    const store = ctx.store ?? new MemoryStore(ctx.db);
    const res = runMemorySearch(store, call.input);
    return {
      id: call.id,
      name: call.name,
      label: res.query || label,
      content: res.xml,
      ms: res.ms,
      error: res.error,
    };
  }

  if (call.name === "lookup_claims") {
    const res = runLookupClaims(ctx.db, call.input);
    return {
      id: call.id,
      name: call.name,
      label: res.query || label,
      content: res.xml,
      ms: res.ms,
      error: res.error,
    };
  }

  return {
    id: call.id,
    name: call.name,
    label,
    ms: 0,
    error: `unknown tool ${call.name}`,
    content: `<tool_error name="${esc(call.name)}" error="unknown tool"/>`,
  };
}

function declinedXml(name: string, label: string): string {
  if (name === "web_search") {
    return `<search_results query="${esc(label)}" error="the user declined this web search; answer from what you know and say so"/>`;
  }
  if (name === "fetch_url") {
    return `<page url="${esc(label)}" error="the user declined this page fetch"/>`;
  }
  return `<tool_error name="${esc(name)}" error="declined by user"/>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function stepToolBudget(): number {
  const cfg = getConfig();
  return Math.max(cfg.MAX_SEARCHES_PER_STEP, 6);
}
