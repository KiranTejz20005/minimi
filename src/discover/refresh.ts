import type { DatabaseSync } from "node:sqlite";
import { getConfig } from "../config.js";
import { createLlm } from "../llm/anthropic.js";
import { safeFetch } from "../tools/safe-fetch.js";
import { discoverConfig, FEED_CONCURRENCY, FEED_MAX_BYTES, FEED_TIMEOUT_MS, MAX_ITEMS_PER_FEED } from "./config.js";
import { extractFunding, refineFundingWithLlm, type RefineCandidate } from "./extract-funding.js";
import { FEEDS, FUNDING_SCAN_DOMAINS } from "./feeds.js";
import { parseFeed } from "./rss.js";
import { knownStartupIds, prune, saveFeedStatus, setState, startupId, upsertNews, upsertStartups, type FundingRow } from "./store.js";
import type { FeedDef, FeedStatus, FundingExtraction } from "./types.js";

export type RefreshDeps = {
  /** Injectable for tests: returns the feed XML for a definition. */
  fetchFeed?: (def: FeedDef, signal?: AbortSignal) => Promise<string>;
  feeds?: readonly FeedDef[];
  now?: () => Date;
  /** Injectable refine step (tests); default uses the configured LLM when a key exists. */
  refine?: (cands: RefineCandidate[]) => Promise<(FundingExtraction | null)[]>;
  signal?: AbortSignal;
};

const VC_FUND_RE =
  /\b(vc|venture|venture capital|private equity|growth equity)\s+(firm|fund|investor)\b|\b(new|first|second|third|debut|latest|inaugural)\s+([$€£]?[\d.,]+\s*(million|billion|m|b|bn)?\s+)?((venture|growth|early-stage|seed|climate|impact)\s+)*(capital\s+)?fund\b|\bfund\s+(i{1,3}|iv|v|vi|[1-9])\b|\boperator-led\s+vc\b|\blimited partners\b|\bLPs\b|\bassets under management\b/i;

/** Headlines about an investor raising or closing a FUND (not a company raising a round). Rules only: no model needed. */
export function isVcFundRaise(title: string, summary = ""): boolean {
  return VC_FUND_RE.test(`${title} ${summary}`.slice(0, 600));
}

export type RefreshResult = { feeds: FeedStatus[]; news: number; startups: number; ms: number };

let running: Promise<RefreshResult> | null = null;
export const isRefreshing = () => running !== null;

async function defaultFetch(def: FeedDef, signal?: AbortSignal): Promise<string> {
  const res = await safeFetch(def.url, {
    timeoutMs: FEED_TIMEOUT_MS,
    maxBytes: FEED_MAX_BYTES,
    signal,
    headers: { Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5" },
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
  return res.body.toString("utf8");
}

async function pool<T, R>(items: readonly T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** One refresh run. Overlapping calls share the run in flight. One feed failing never stops the others. */
export function refreshNow(db: DatabaseSync, deps: RefreshDeps = {}): Promise<RefreshResult> {
  if (running) return running;
  running = doRefresh(db, deps).finally(() => {
    running = null;
  });
  return running;
}

async function doRefresh(db: DatabaseSync, deps: RefreshDeps): Promise<RefreshResult> {
  const t0 = Date.now();
  const nowIso = (deps.now?.() ?? new Date()).toISOString();
  const fetchFeed = deps.fetchFeed ?? defaultFetch;
  const feeds = deps.feeds ?? FEEDS;
  let newsTotal = 0;
  const candidates: FundingRow[] = [];

  const statuses = await pool(feeds, FEED_CONCURRENCY, async (def): Promise<FeedStatus> => {
    const f0 = Date.now();
    try {
      const xml = await fetchFeed(def, deps.signal);
      const parsed = parseFeed(xml, { baseUrl: def.url, fetchedAt: nowIso, maxItems: MAX_ITEMS_PER_FEED });
      if (!parsed.format) throw new Error("not a valid RSS/Atom feed");
      newsTotal += upsertNews(db, parsed.items, def.name, def.domain, nowIso);
      if (def.kind === "funding" || FUNDING_SCAN_DOMAINS.includes(def.domain)) {
        for (const item of parsed.items) {
          if (isVcFundRaise(item.title, item.summary)) continue; // an investor closing a fund is not a startup round
          const x = extractFunding(item.title, item.summary);
          if (x) candidates.push({ extraction: x, item, source: def.name });
        }
      }
      const s: FeedStatus = { name: def.name, kind: def.kind, ok: true, items: parsed.items.length, ms: Date.now() - f0 };
      saveFeedStatus(db, s, nowIso);
      return s;
    } catch (e) {
      const msg = (e instanceof Error ? e.message : "failed").replace(/\s+/g, " ").slice(0, 160);
      const s: FeedStatus = { name: def.name, kind: def.kind, ok: false, items: 0, ms: Date.now() - f0, error: msg };
      saveFeedStatus(db, s, nowIso);
      return s;
    }
  });

  // Optional LLM clean-up, only for rows not stored yet (bounds cost) and only when a key exists.
  let rows = candidates;
  try {
    const idOf = (c: FundingRow) => startupId(c.extraction.company, c.extraction.round, c.item.publishedAt);
    const known = knownStartupIds(db, candidates.map(idOf));
    const fresh = candidates.filter((c) => !known.has(idOf(c))).slice(0, 15); // keeps the model's JSON reply inside the 2048-token llm.json limit
    const useLlm = !deps.refine && getConfig().hasLlm && discoverConfig().llmRefine;
    if ((deps.refine || useLlm) && fresh.length) {
      const cands = fresh.map((c) => ({ title: c.item.title, summary: c.item.summary, extraction: c.extraction }));
      const refined = deps.refine ? await deps.refine(cands) : await refineFundingWithLlm(cands, await createLlm(), getConfig().MODEL_FAST, deps.signal ?? AbortSignal.timeout(30_000));
      const verdict = new Map<FundingRow, FundingExtraction | null>();
      fresh.forEach((c, i) => verdict.set(c, refined[i] ?? null));
      rows = candidates.flatMap((c) => {
        if (!verdict.has(c)) return [c];
        const r = verdict.get(c);
        return r ? [{ ...c, extraction: r }] : [];
      });
    }
  } catch {
    /* refinement is best-effort */
  }
  const startups = upsertStartups(db, rows, nowIso);

  prune(db, Date.parse(nowIso));
  setState(db, "last_refresh_at", nowIso);
  return { feeds: statuses, news: newsTotal, startups, ms: Date.now() - t0 };
}
