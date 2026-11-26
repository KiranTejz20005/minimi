import type { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { MANUAL_REFRESH_GAP_MS } from "./config.js";
import { getOrCreateContext } from "./enrich.js";
import { isRefreshing, refreshNow } from "./refresh.js";
import { nextRefreshAt } from "./scheduler.js";
import { counts, getState, lastRefreshAt, listNews, listStartups, loadFeedStatus, setState } from "./store.js";
import { NEWS_DOMAIN_IDS, SECTOR_IDS } from "./types.js";

const num = (v: string | undefined, def: number, min: number, max: number) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const text = (v: string | undefined) => (v ?? "").trim().slice(0, 100);

/** Tiny in-memory per-key limiter (single process). Returns seconds to wait, or 0 when allowed. */
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string): number => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) return Math.ceil((windowMs - (now - recent[0]!)) / 1000);
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 2000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    return 0;
  };
}

export function registerDiscoverRoutes(app: Hono, db: DatabaseSync): void {
  const contextLimit = limiter(10, 60_000);

  app.get("/api/discover/news", (c) => {
    const domain = text(c.req.query("domain")) || "all";
    const r = listNews(db, {
      domain: domain === "all" || NEWS_DOMAIN_IDS.includes(domain) ? domain : "all",
      q: text(c.req.query("q")),
      limit: num(c.req.query("limit"), 30, 1, 60),
      offset: num(c.req.query("offset"), 0, 0, 100_000),
    });
    return c.json({ ...r, updatedAt: lastRefreshAt(db) });
  });

  app.get("/api/discover/startups", (c) => {
    const sector = text(c.req.query("sector")) || "all";
    const r = listStartups(db, {
      sector: sector === "all" || SECTOR_IDS.includes(sector) ? sector : "all",
      q: text(c.req.query("q")),
      sort: c.req.query("sort") === "amount" ? "amount" : "recent",
      limit: num(c.req.query("limit"), 30, 1, 60),
      offset: num(c.req.query("offset"), 0, 0, 100_000),
    });
    return c.json({ ...r, updatedAt: lastRefreshAt(db) });
  });

  app.get("/api/discover/status", (c) =>
    c.json({ lastRefreshAt: lastRefreshAt(db), nextRefreshAt: nextRefreshAt(), refreshing: isRefreshing(), ...counts(db), sources: loadFeedStatus(db) }),
  );

  app.post("/api/discover/refresh", (c) => {
    if (isRefreshing()) return c.json({ started: false, reason: "already_running" });
    const last = Number(getState(db, "manual_refresh_at") ?? 0);
    if (Date.now() - last < MANUAL_REFRESH_GAP_MS) return c.json({ started: false, reason: "too_soon" });
    setState(db, "manual_refresh_at", String(Date.now()));
    void refreshNow(db).catch((e) => console.warn("[discover] manual refresh failed:", e instanceof Error ? e.message : e));
    return c.json({ started: true });
  });

  app.post("/api/discover/startups/:id/context", async (c) => {
    // Behind a proxy (Render sets TRUST_PROXY=1) the socket address is the proxy: use the LAST forwarded hop (earlier ones are spoofable).
    const fwd = process.env.TRUST_PROXY === "1" ? c.req.header("x-forwarded-for")?.split(",").pop()?.trim() : undefined;
    const ip = fwd || (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress || "local";
    const wait = contextLimit(ip);
    if (wait > 0) {
      c.header("Retry-After", String(wait));
      return c.json({ error: "Too many requests - try again shortly." }, 429);
    }
    const ac = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => ac.abort());
    try {
      const out = await getOrCreateContext(db, c.req.param("id"), { signal: ac.signal });
      return out ? c.json(out) : c.json({ error: "Startup not found" }, 404);
    } catch {
      return c.json({ error: "Could not generate context right now." }, 502);
    }
  });
}
