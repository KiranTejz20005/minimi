import { getConfig } from "../config.js";
import { tavilySearch } from "./tavily.js";
import { MAX_SEARCH_RESULTS, type RawResult, type SearchInput, type SearchProvider } from "./types.js";

/**
 * Keyless fallback search (scrapes Bing's HTML results). Used when no TAVILY_API_KEY is set,
 * so the app works end to end without a paid search key. Quality is below Tavily.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#0*183;/g, "·")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Bing wraps result links in /ck/a?...&u=a1<base64url(real url)>. */
export function unwrapBingUrl(href: string): string {
  const url = decodeEntities(href);
  try {
    const u = new URL(url);
    if (u.hostname.endsWith("bing.com") && u.pathname.startsWith("/ck/")) {
      const enc = u.searchParams.get("u");
      if (enc?.startsWith("a1")) {
        const b64 = enc.slice(2).replace(/-/g, "+").replace(/_/g, "/");
        const decoded = Buffer.from(b64, "base64").toString("utf8");
        if (/^https?:\/\//i.test(decoded)) return decoded;
      }
    }
  } catch {
    /* fall through */
  }
  return url;
}

export function parseBingHtml(html: string): RawResult[] {
  const out: RawResult[] = [];
  for (const m of html.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/g)) {
    const block = m[0];
    const h = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!h) continue;
    const url = unwrapBingUrl(h[1]!);
    if (!/^https?:\/\//i.test(url)) continue;
    if (/(^|\.)bing\.com$/i.test(new URL(url).hostname)) continue;
    const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const snippet = p ? stripTags(p[1]!) : "";
    out.push({
      url,
      title: stripTags(h[2]!) || url,
      content: snippet || stripTags(h[2]!),
      publishedAt: null,
    });
    if (out.length >= MAX_SEARCH_RESULTS) break;
  }
  return out;
}

export async function freeSearch(input: SearchInput, signal: AbortSignal): Promise<RawResult[]> {
  const cfg = getConfig();
  const domains = input.domains?.filter(Boolean) ?? [];
  const site = domains.length ? ` (${domains.map((d) => `site:${d}`).join(" OR ")})` : "";
  // Extra locale params (mkt/cc/setlang) make Bing return off-topic results; keep it plain.
  const params = new URLSearchParams({ q: `${input.query}${site}`, count: "10" });
  const timeout = AbortSignal.timeout(Math.max(cfg.SEARCH_TIMEOUT_MS, 8000));
  const res = await fetch(`https://www.bing.com/search?${params}`, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.any([signal, timeout]),
  });
  if (!res.ok) throw new Error(`Search HTTP ${res.status}`);
  return parseBingHtml(await res.text());
}

export function searchProviderName(): "Tavily" | "Web (keyless)" {
  return getConfig().TAVILY_API_KEY?.trim() ? "Tavily" : "Web (keyless)";
}

/** Chosen per call, so a key added at runtime takes effect immediately. */
export function createDefaultSearchProvider(): SearchProvider {
  return {
    // Tavily first when a key exists; if it errors or returns nothing, fall back to keyless search (and back).
    search: async (input, signal) => {
      const hasKey = Boolean(getConfig().TAVILY_API_KEY?.trim());
      const first = hasKey ? tavilySearch : freeSearch;
      const second = hasKey ? freeSearch : null;
      try {
        const r = await first(input, signal);
        if (r.length || !second) return r;
      } catch (err) {
        if (!second || signal.aborted) throw err;
      }
      return second!(input, signal);
    },
  };
}
