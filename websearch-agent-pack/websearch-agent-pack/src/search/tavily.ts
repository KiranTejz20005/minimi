import { getConfig } from "../config.js";
import type { RawResult, SearchInput, SearchProvider } from "./types.js";

export type { SearchInput } from "./types.js";
import { MAX_SEARCH_RESULTS } from "./types.js";

const TAVILY_URL = "https://api.tavily.com/search";

type TavilyHit = {
  url?: string;
  title?: string;
  content?: string;
  raw_content?: string;
  published_date?: string;
};

type TavilyResponse = {
  results?: TavilyHit[];
  detail?: string;
};

function normalizeDomains(domains: string[] | undefined): string[] | undefined {
  if (!domains?.length) return undefined;
  const out = domains
    .map((d) =>
      d
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .split("/")[0]!,
    )
    .filter(Boolean);
  return out.length ? out : undefined;
}

function mapResults(hits: TavilyHit[] | undefined): RawResult[] {
  if (!hits?.length) return [];
  return hits
    .filter((h) => h.url && (h.content || h.title || h.raw_content))
    .map((h) => ({
      url: h.url!,
      title: h.title?.trim() || h.url!,
      content: (h.content ?? h.raw_content ?? "").trim(),
      publishedAt: h.published_date?.trim() || null,
    }));
}

function buildBody(
  input: SearchInput,
  withDomains: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: input.query,
    search_depth: "basic",
    include_answer: false,
    max_results: MAX_SEARCH_RESULTS,
    include_raw_content: false,
    include_published_date: true,
    topic: input.topic ?? "general",
  };
  if (input.start_date) body.start_date = input.start_date;
  const domains = normalizeDomains(input.domains);
  if (withDomains && domains?.length) {
    body.include_domains = domains;
    body.include_domains_mode = "restrict";
  }
  return body;
}

async function postOnce(
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ status: number; data: TavilyResponse }> {
  const res = await fetch(TAVILY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  let data: TavilyResponse = {};
  try {
    data = (await res.json()) as TavilyResponse;
  } catch {
    data = {};
  }
  return { status: res.status, data };
}

export async function tavilySearch(
  input: SearchInput,
  signal: AbortSignal,
): Promise<RawResult[]> {
  const cfg = getConfig();
  const apiKey = cfg.TAVILY_API_KEY?.trim();
  if (!apiKey) throw new Error("Missing TAVILY_API_KEY");

  const timeout = AbortSignal.timeout(cfg.SEARCH_TIMEOUT_MS);
  const combined = AbortSignal.any([signal, timeout]);

  const hasDomains = Boolean(normalizeDomains(input.domains)?.length);

  const exec = async (body: Record<string, unknown>): Promise<RawResult[]> => {
    let lastStatus = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { status, data } = await postOnce(apiKey, body, combined);
        lastStatus = status;
        if (status >= 500 && attempt === 0) {
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        if (status < 200 || status >= 300) {
          throw new Error(data.detail ?? `Tavily HTTP ${status}`);
        }
        return mapResults(data.results);
      } catch (err) {
        if (combined.aborted) throw err;
        if (attempt === 0 && (lastStatus >= 500 || err instanceof TypeError)) {
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Tavily HTTP ${lastStatus}`);
  };

  let results = await exec(buildBody(input, hasDomains));
  if (!results.length && hasDomains) {
    results = await exec(buildBody(input, false));
  }
  return results;
}

export function createTavilyProvider(): SearchProvider {
  return { search: tavilySearch };
}
