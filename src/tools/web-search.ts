import { getConfig } from "../config.js";
import { getSearchRunner, parseSearchInput, WEB_SEARCH_TOOL } from "../search/tool.js";
import type { SearchInput } from "../search/types.js";
import { ToolInputError, type ToolDefinition } from "./types.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function queryOf(raw: unknown): string {
  return raw && typeof raw === "object" && typeof (raw as { query?: unknown }).query === "string"
    ? (raw as { query: string }).query
    : "";
}

/** web_search: Tavily with a keyless Bing fallback (see src/search). Citation numbers come from ctx.registry. */
export const webSearchTool: ToolDefinition<SearchInput> = {
  name: "web_search",
  schema: WEB_SEARCH_TOOL,
  isSearch: true,
  approval: "network",
  effect: "read",
  actionLabel: "Web search",
  maxPerTurn: () => getConfig().MAX_SEARCHES_PER_TURN,
  // Providers apply their own SEARCH_TIMEOUT_MS; this is the outer bound for the whole call incl. fallback.
  timeoutMs: 20_000,
  retry: { retries: 1, backoffMs: 400 },
  label: (raw) => queryOf(raw) || "web search",
  validate: (raw) => {
    const parsed = parseSearchInput(raw);
    if (!parsed) throw new ToolInputError("invalid web_search input");
    return parsed;
  },
  run: async (input, ctx) => {
    const res = await getSearchRunner(ctx.searchProvider).run(input, ctx.registry, ctx.signal);
    return {
      content: res.xml,
      label: res.query,
      error: res.error,
      search: {
        query: res.query,
        count: res.count,
        cached: res.cached,
        results: (res.sources ?? []).map((s) => ({ title: s.title, url: s.url })),
        error: res.error,
      },
    };
  },
  declined: (label) =>
    `<search_results query="${esc(label)}" error="the user declined this web search; answer from what you know and say so"/>`,
  errorContent: (label, error) => `<search_results query="${esc(label)}" error="${esc(error)}"/>`,
};
