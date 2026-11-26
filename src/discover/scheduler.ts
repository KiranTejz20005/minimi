import type { DatabaseSync } from "node:sqlite";
import { discoverConfig, FIRST_REFRESH_DELAY_MS, isTestEnv } from "./config.js";
import { refreshNow } from "./refresh.js";

let nextRefreshAtMs: number | null = null;
export const nextRefreshAt = (): string | null => (nextRefreshAtMs ? new Date(nextRefreshAtMs).toISOString() : null);

/**
 * Background refresh: first run shortly after boot (non-blocking), then every DISCOVER_REFRESH_MIN minutes.
 * Never starts under tests or with DISCOVER_ENABLED=0. Timers are unref()'d so they never hold the process open.
 * Returns a stop function.
 */
export function startDiscoverScheduler(db: DatabaseSync, env: Record<string, string | undefined> = process.env): () => void {
  const cfg = discoverConfig(env);
  if (isTestEnv(env) || !cfg.enabled) return () => {};
  const intervalMs = cfg.refreshMin * 60_000;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const schedule = (ms: number) => {
    if (stopped) return;
    nextRefreshAtMs = Date.now() + ms;
    timer = setTimeout(run, ms);
    timer.unref();
  };
  const run = () => {
    if (stopped) return;
    refreshNow(db)
      .then((r) => console.log(`[discover] refreshed: ${r.news} news, ${r.startups} startups, ${r.feeds.filter((f) => f.ok).length}/${r.feeds.length} feeds ok (${r.ms}ms)`))
      .catch((e) => console.warn("[discover] refresh failed:", e instanceof Error ? e.message : e))
      .finally(() => schedule(intervalMs));
  };
  schedule(FIRST_REFRESH_DELAY_MS);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    nextRefreshAtMs = null;
  };
}
