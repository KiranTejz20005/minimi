import { z } from "zod";
import { DateTime } from "luxon";
import type { DatabaseSync } from "node:sqlite";
import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import type { Clock } from "../clock.js";
import { getConfig } from "../config.js";
import { getClock } from "../clock.js";
import { cacheKey, getCached, setCached } from "./cache.js";
import { tavilySearch } from "./tavily.js";
import { createDefaultSearchProvider } from "./free.js";
import { trimSearchResults } from "./trim.js";
import type {
  CitationRegistry,
  CitationSource,
  SearchInput,
  SearchProvider,
  SearchRunResult,
  SearchTopic,
  TrimmedResult,
} from "./types.js";

const searchInputSchema = z.object({
  query: z.string().min(1),
  start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  domains: z.array(z.string()).optional(),
  topic: z.enum(["general", "news"]).optional(),
});

export const WEB_SEARCH_TOOL: Tool = {
  name: "web_search",
  description:
    "Search the live web. Returns numbered results with page extracts. Call several times in parallel for independent lookups. For current pricing use official domains without start_date; for 'what changed since X' use start_date and topic news.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Specific search query, 3-10 words.",
      },
      start_date: {
        type: "string",
        description:
          "YYYY-MM-DD. Only results published on or after this date. Use for 'what changed since X'.",
      },
      domains: {
        type: "array",
        items: { type: "string" },
        description:
          "Restrict to these domains, e.g. the vendor's official site for pricing.",
      },
      topic: {
        type: "string",
        enum: ["general", "news"],
      },
    },
    required: ["query"],
  },
  cache_control: { type: "ephemeral" },
};

export const webSearchToolSchema = WEB_SEARCH_TOOL;

export class TurnCitationRegistry implements CitationRegistry {
  private next = 1;
  readonly sources = new Map<number, CitationSource>();

  assign(results: TrimmedResult[], retrievedAt: string): number[] {
    const nums: number[] = [];
    for (const r of results) {
      const n = this.next++;
      this.sources.set(n, {
        n,
        url: r.url,
        title: r.title,
        publishedAt: r.publishedAt ?? null,
        retrievedAt,
      });
      nums.push(n);
    }
    return nums;
  }
}

export class SearchRegistry extends TurnCitationRegistry {}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatDisplayDate(iso: string): string {
  const cfg = getConfig();
  const dt = DateTime.fromISO(iso, { zone: "utc" }).setZone(cfg.DEFAULT_TZ);
  return dt.isValid
    ? dt.toFormat("d MMM yyyy")
    : DateTime.fromJSDate(getClock().now(), { zone: cfg.DEFAULT_TZ }).toFormat(
        "d MMM yyyy",
      );
}

function formatPublished(publishedAt?: string | null): string {
  if (!publishedAt?.trim()) return "unknown";
  const d = DateTime.fromISO(publishedAt, { setZone: true });
  if (d.isValid) return d.toFormat("d MMM yyyy");
  const loose = DateTime.fromFormat(publishedAt, "yyyy-MM-dd");
  return loose.isValid ? loose.toFormat("d MMM yyyy") : publishedAt;
}

export function formatSearchResultsXml(
  query: string,
  items: { n: number; result: TrimmedResult; retrievedAt: string }[],
  opts?: { error?: string },
): string {
  const q = escapeXmlAttr(query);
  if (opts?.error) {
    return `<search_results query="${q}" error="${escapeXmlAttr(opts.error)}"/>`;
  }
  const lines: string[] = [
    `<search_results query="${q}" note="untrusted web content">`,
  ];
  for (const { n, result, retrievedAt } of items) {
    lines.push(
      `[${n}] ${escapeXmlText(result.title)} — ${escapeXmlText(result.url)}`,
      `    published: ${escapeXmlText(formatPublished(result.publishedAt))} | retrieved: ${escapeXmlText(formatDisplayDate(retrievedAt))}`,
      `    ${escapeXmlText(result.content)}`,
    );
  }
  lines.push("</search_results>");
  return lines.join("\n");
}

export function parseSearchInput(raw: unknown): SearchInput | null {
  const parsed = searchInputSchema.safeParse(raw);
  if (!parsed.success) return null;
  const v = parsed.data;
  return {
    query: v.query.trim(),
    start_date: v.start_date,
    domains: v.domains?.map((d) => d.trim()).filter(Boolean),
    topic: v.topic as SearchTopic | undefined,
  };
}

/** Used by PermissionGate to skip approval for cache hits. */
export function isSearchCached(rawInput: unknown): boolean {
  const parsed = parseSearchInput(rawInput);
  if (!parsed) return false;
  return getCached(cacheKey(parsed)) != null;
}

function timeoutMessage(ms: number): string {
  return `timeout after ${Math.round(ms / 1000)}s`;
}

function isTimeoutError(err: unknown, ms: number): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "TimeoutError") return true;
  return err.name === "AbortError" && err.message.includes(String(ms));
}

export class SearchRunner {
  constructor(
    private readonly provider: SearchProvider = createDefaultSearchProvider(),
  ) {}

  async run(
    rawInput: unknown,
    registry: CitationRegistry,
    parentSignal?: AbortSignal,
  ): Promise<SearchRunResult> {
    const t0 = getClock().now().getTime();
    const cfg = getConfig();
    const parsed = parseSearchInput(rawInput);
    if (!parsed) {
      const fallbackQuery =
        rawInput &&
        typeof rawInput === "object" &&
        "query" in rawInput &&
        typeof (rawInput as { query: unknown }).query === "string"
          ? (rawInput as { query: string }).query
          : "";
      const err = "invalid web_search input";
      return {
        query: fallbackQuery,
        xml: formatSearchResultsXml(fallbackQuery, [], { error: err }),
        count: 0,
        ms: getClock().now().getTime() - t0,
        cached: false,
        error: err,
      };
    }

    const key = cacheKey(parsed);
    const retrievedAt = getClock().now().toISOString();
    let trimmed: TrimmedResult[];
    let cached = false;

    const hit = getCached(key);
    if (hit) {
      trimmed = hit;
      cached = true;
    } else {
      const signal = parentSignal ?? AbortSignal.timeout(cfg.SEARCH_TIMEOUT_MS);
      try {
        const raw = await this.provider.search(parsed, signal);
        trimmed = trimSearchResults(parsed.query, raw);
        setCached(key, trimmed);
      } catch (err) {
        const msg = isTimeoutError(err, cfg.SEARCH_TIMEOUT_MS)
          ? timeoutMessage(cfg.SEARCH_TIMEOUT_MS)
          : err instanceof Error
            ? err.message
            : "search failed";
        return {
          query: parsed.query,
          xml: formatSearchResultsXml(parsed.query, [], { error: msg }),
          count: 0,
          ms: getClock().now().getTime() - t0,
          cached: false,
          error: msg,
        };
      }
    }

    const nums = registry.assign(trimmed, retrievedAt);
    const items = trimmed.map((result, i) => ({
      n: nums[i]!,
      result,
      retrievedAt,
    }));
    const sources = nums
      .map((n) => registry.sources.get(n))
      .filter((s): s is CitationSource => s !== undefined);

    return {
      query: parsed.query,
      xml: formatSearchResultsXml(parsed.query, items),
      count: items.length,
      ms: getClock().now().getTime() - t0,
      cached,
      sources,
    };
  }
}

let defaultRunner: SearchRunner | null = null;
let evalSearchProvider: SearchProvider | null = null;

/** Eval harness: inject mock Tavily before `npm run eval -- --mock-search`. */
export function setEvalSearchProvider(provider: SearchProvider | null): void {
  evalSearchProvider = provider;
}

export function getSearchRunner(provider?: SearchProvider): SearchRunner {
  const p = provider ?? evalSearchProvider ?? undefined;
  if (p) return new SearchRunner(p);
  if (!defaultRunner) defaultRunner = new SearchRunner();
  return defaultRunner;
}

export async function runWebSearch(
  input: SearchInput | unknown,
  registry: CitationRegistry,
  signal?: AbortSignal,
  provider?: SearchProvider,
): Promise<SearchRunResult> {
  return getSearchRunner(provider).run(input, registry, signal);
}

/** Agent loop entry: accepts db/clock for API stability; both are unused (cache uses singletons). */
export async function runSearch(
  _db: DatabaseSync,
  _clock: Clock,
  input: SearchInput,
  registry: CitationRegistry,
  signal: AbortSignal,
  provider?: SearchProvider,
): Promise<SearchRunResult> {
  return getSearchRunner(provider).run(input, registry, signal);
}

export function searchCapRemaining(used: number): number {
  return getConfig().MAX_SEARCHES_PER_TURN - used;
}

/** Direct Tavily access for tests and health probes. */
export { tavilySearch };
