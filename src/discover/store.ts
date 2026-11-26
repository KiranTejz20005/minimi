import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { FUNDING_MAX_AGE_DAYS, FUNDING_MAX_ROWS, NEWS_MAX_AGE_DAYS, NEWS_MAX_ROWS } from "./config.js";
import { NEWS_DOMAINS, SECTORS, type FeedStatus, type FundingExtraction, type NewsItem, type ParsedItem, type Startup, type StartupContext } from "./types.js";

type Row = Record<string, unknown>;

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export const newsId = (url: string) => `nws_${hash(url)}`;
// The round is NOT part of the key: outlets parse it differently (Seed / Pre-seed / none) for the same announcement,
// which produced 3 rows for one company. Same company + same month = one funding story; fields are merged below.
export const startupId = (company: string, _round: string | null, publishedAt: string) =>
  // A name with no a-z/0-9 (non-Latin) normalises to "": hash the raw name so such companies do not all collide.
  `stp_${hash(`${norm(company) || company.trim()}|${publishedAt.slice(0, 7)}`)}`;

/** Escape LIKE wildcards; queries use `LIKE ? ESCAPE '\'`. */
export function likeTerm(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

// ── writes ──────────────────────────────────────────────────────────────────
export function upsertNews(db: DatabaseSync, items: ParsedItem[], source: string, domain: string, fetchedAt: string): number {
  const st = db.prepare(
    `INSERT INTO news_items (id, title, url, source, domain, summary, image_url, published_at, fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(url) DO UPDATE SET title = excluded.title, summary = excluded.summary, image_url = COALESCE(excluded.image_url, image_url)`,
  );
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const it of items) {
      const r = st.run(newsId(it.url), it.title, it.url, source, domain, it.summary, it.imageUrl, it.publishedAt, fetchedAt);
      n += Number(r.changes) > 0 ? 1 : 0;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return n;
}

export type FundingRow = { extraction: FundingExtraction; item: ParsedItem; source: string };

export function upsertStartups(db: DatabaseSync, rows: FundingRow[], fetchedAt: string): number {
  const st = db.prepare(
    `INSERT INTO startup_fundings (id, company, amount_usd, amount_text, currency, round, sector, summary, investors, location, published_at, source, url, fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       amount_usd = COALESCE(amount_usd, excluded.amount_usd),
       amount_text = COALESCE(amount_text, excluded.amount_text),
       currency = COALESCE(currency, excluded.currency),
       round = COALESCE(round, excluded.round),
       location = COALESCE(location, excluded.location),
       investors = CASE WHEN investors = '[]' THEN excluded.investors ELSE investors END`,
  );
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const { extraction: x, item, source } of rows) {
      const id = startupId(x.company, x.round, item.publishedAt);
      // Names cut off by the feed ("Bharat…") are not investor names.
      const investors = x.investors
        .filter((v) => !v.includes("…") && !v.includes("..."))
        .map((v) => (v.includes("-based ") ? v.slice(v.indexOf("-based ") + 7) : v)); // "Geneva-based Foo Ventures" -> "Foo Ventures"
      const r = st.run(id, x.company, x.amountUsd, x.amountText, x.currency, x.round, x.sector, item.summary, JSON.stringify(investors), x.location, item.publishedAt, source, item.url, fetchedAt);
      n += Number(r.changes) > 0 ? 1 : 0;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return n;
}

export function knownStartupIds(db: DatabaseSync, ids: string[]): Set<string> {
  const out = new Set<string>();
  const st = db.prepare(`SELECT 1 FROM startup_fundings WHERE id = ?`);
  for (const id of ids) if (st.get(id)) out.add(id);
  return out;
}

export function saveContext(db: DatabaseSync, id: string, ctx: StartupContext): void {
  db.prepare(`UPDATE startup_fundings SET context_json = ?, context_at = ? WHERE id = ?`).run(JSON.stringify(ctx), ctx.generatedAt, id);
}

export function setState(db: DatabaseSync, key: string, value: string): void {
  db.prepare(`INSERT INTO discover_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}
export function getState(db: DatabaseSync, key: string): string | null {
  const r = db.prepare(`SELECT value FROM discover_state WHERE key = ?`).get(key) as Row | undefined;
  return r ? String(r.value) : null;
}

export function saveFeedStatus(db: DatabaseSync, s: FeedStatus, at: string): void {
  db.prepare(
    `INSERT INTO feed_status (name, kind, ok, items, ms, error, at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(name) DO UPDATE SET kind = excluded.kind, ok = excluded.ok, items = excluded.items, ms = excluded.ms, error = excluded.error, at = excluded.at`,
  ).run(s.name, s.kind, s.ok ? 1 : 0, s.items, s.ms, s.error ?? null, at);
}
export function loadFeedStatus(db: DatabaseSync): FeedStatus[] {
  return (db.prepare(`SELECT name, kind, ok, items, ms, error FROM feed_status ORDER BY kind, name`).all() as Row[]).map((r) => ({
    name: String(r.name),
    kind: r.kind === "funding" ? "funding" : "news",
    ok: Number(r.ok) === 1,
    items: Number(r.items),
    ms: Number(r.ms),
    ...(r.error ? { error: String(r.error) } : {}),
  }));
}

/** Drop old rows and keep the tables bounded. */
export function prune(db: DatabaseSync, nowMs = Date.now()): void {
  const newsCut = new Date(nowMs - NEWS_MAX_AGE_DAYS * 86_400_000).toISOString();
  const fundCut = new Date(nowMs - FUNDING_MAX_AGE_DAYS * 86_400_000).toISOString();
  db.prepare(`DELETE FROM news_items WHERE published_at < ?`).run(newsCut);
  db.prepare(`DELETE FROM news_items WHERE id NOT IN (SELECT id FROM news_items ORDER BY published_at DESC LIMIT ?)`).run(NEWS_MAX_ROWS);
  db.prepare(`DELETE FROM startup_fundings WHERE published_at < ?`).run(fundCut);
  db.prepare(`DELETE FROM startup_fundings WHERE id NOT IN (SELECT id FROM startup_fundings ORDER BY published_at DESC LIMIT ?)`).run(FUNDING_MAX_ROWS);
}

// ── reads ───────────────────────────────────────────────────────────────────
const toNews = (r: Row): NewsItem => ({
  id: String(r.id),
  title: String(r.title),
  url: String(r.url),
  source: String(r.source),
  domain: String(r.domain),
  summary: String(r.summary ?? ""),
  imageUrl: r.image_url ? String(r.image_url) : null,
  publishedAt: String(r.published_at),
  fetchedAt: String(r.fetched_at),
});

function parseContext(json: unknown): StartupContext | null {
  if (typeof json !== "string" || !json) return null;
  try {
    const c = JSON.parse(json) as StartupContext;
    return c && typeof c.whatTheyDo === "string" ? c : null;
  } catch {
    return null;
  }
}

const toStartup = (r: Row): Startup => {
  let investors: string[] = [];
  try {
    const v = JSON.parse(String(r.investors ?? "[]"));
    if (Array.isArray(v)) investors = v.filter((x): x is string => typeof x === "string");
  } catch {
    /* keep [] */
  }
  return {
    id: String(r.id),
    company: String(r.company),
    amountUsd: typeof r.amount_usd === "number" ? r.amount_usd : null,
    amountText: r.amount_text ? String(r.amount_text) : null,
    currency: r.currency ? String(r.currency) : null,
    round: r.round ? String(r.round) : null,
    sector: String(r.sector),
    summary: String(r.summary ?? ""),
    investors,
    location: r.location ? String(r.location) : null,
    publishedAt: String(r.published_at),
    source: String(r.source),
    url: String(r.url),
    context: parseContext(r.context_json),
  };
};

export type NewsQuery = { domain?: string; q?: string; limit?: number; offset?: number };

export function listNews(db: DatabaseSync, q: NewsQuery) {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (q.domain && q.domain !== "all") (where.push("domain = ?"), args.push(q.domain));
  if (q.q) (where.push(`(title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')`), args.push(likeTerm(q.q), likeTerm(q.q)));
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = Number((db.prepare(`SELECT COUNT(*) AS c FROM news_items ${w}`).get(...args) as Row).c);
  const rows = db.prepare(`SELECT * FROM news_items ${w} ORDER BY published_at DESC LIMIT ? OFFSET ?`).all(...args, q.limit ?? 30, q.offset ?? 0) as Row[];
  const counts = new Map((db.prepare(`SELECT domain, COUNT(*) AS c FROM news_items GROUP BY domain`).all() as Row[]).map((r) => [String(r.domain), Number(r.c)]));
  const all = [...counts.values()].reduce((a, b) => a + b, 0);
  return {
    items: rows.map(toNews),
    total,
    domains: [{ id: "all", label: "All", count: all }, ...NEWS_DOMAINS.map((d) => ({ id: d.id, label: d.label, count: counts.get(d.id) ?? 0 }))],
  };
}

export type StartupQuery = { sector?: string; q?: string; sort?: "recent" | "amount"; limit?: number; offset?: number };

export function listStartups(db: DatabaseSync, q: StartupQuery, nowMs = Date.now()) {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (q.sector && q.sector !== "all") (where.push("sector = ?"), args.push(q.sector));
  if (q.q) (where.push(`(company LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR investors LIKE ? ESCAPE '\\')`), args.push(likeTerm(q.q), likeTerm(q.q), likeTerm(q.q)));
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const order = q.sort === "amount" ? "amount_usd IS NULL, amount_usd DESC, published_at DESC" : "published_at DESC";
  const total = Number((db.prepare(`SELECT COUNT(*) AS c FROM startup_fundings ${w}`).get(...args) as Row).c);
  const rows = db.prepare(`SELECT * FROM startup_fundings ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, q.limit ?? 30, q.offset ?? 0) as Row[];
  const counts = new Map((db.prepare(`SELECT sector, COUNT(*) AS c FROM startup_fundings GROUP BY sector`).all() as Row[]).map((r) => [String(r.sector), Number(r.c)]));
  const all = [...counts.values()].reduce((a, b) => a + b, 0);
  const agg = db.prepare(`SELECT COUNT(*) AS c, SUM(amount_usd) AS s FROM startup_fundings`).get() as Row;
  const week = Number((db.prepare(`SELECT COUNT(*) AS c FROM startup_fundings WHERE published_at >= ?`).get(new Date(nowMs - 7 * 86_400_000).toISOString()) as Row).c);
  return {
    items: rows.map(toStartup),
    total,
    sectors: [{ id: "all", label: "All", count: all }, ...SECTORS.map((s) => ({ id: s.id, label: s.label, count: counts.get(s.id) ?? 0 }))],
    stats: { count: Number(agg.c), totalUsd: typeof agg.s === "number" ? agg.s : null, last7d: week },
  };
}

export function getStartup(db: DatabaseSync, id: string): Startup | null {
  const r = db.prepare(`SELECT * FROM startup_fundings WHERE id = ?`).get(id) as Row | undefined;
  return r ? toStartup(r) : null;
}

export function counts(db: DatabaseSync): { newsCount: number; startupCount: number } {
  return {
    newsCount: Number((db.prepare(`SELECT COUNT(*) AS c FROM news_items`).get() as Row).c),
    startupCount: Number((db.prepare(`SELECT COUNT(*) AS c FROM startup_fundings`).get() as Row).c),
  };
}

export function lastRefreshAt(db: DatabaseSync): string | null {
  return getState(db, "last_refresh_at");
}
