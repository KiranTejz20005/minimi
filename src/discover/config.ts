/**
 * Discover settings. Read straight from process.env (not src/config.ts) so the feature stays self-contained:
 *   DISCOVER_ENABLED=0        disables the background refresh scheduler (the API still serves what is stored)
 *   DISCOVER_REFRESH_MIN=30   minutes between scheduled refreshes (min 5, max 1440)
 *   DISCOVER_LLM_REFINE=0     turns off the optional LLM clean-up of extracted funding rows (only used when an LLM key exists)
 */

export type DiscoverConfig = {
  enabled: boolean;
  refreshMin: number;
  llmRefine: boolean;
};

type Env = Record<string, string | undefined>;

export const DEFAULT_REFRESH_MIN = 30;
export const MIN_REFRESH_MIN = 5;
export const MAX_REFRESH_MIN = 1440;

/** First scheduled refresh after boot (non-blocking). */
export const FIRST_REFRESH_DELAY_MS = 3_000;
/** Feeds fetched at the same time. */
export const FEED_CONCURRENCY = 4;
/** Per-feed wall-clock limit (DNS + connect + body). */
export const FEED_TIMEOUT_MS = 12_000;
/** Per-feed body cap. The largest verified feed is ~250 KB; this leaves headroom without allowing abuse. */
export const FEED_MAX_BYTES = 3_000_000;
/** Items kept per feed per refresh (feeds list newest first). */
export const MAX_ITEMS_PER_FEED = 60;

export const NEWS_MAX_AGE_DAYS = 30;
export const NEWS_MAX_ROWS = 3_000;
export const FUNDING_MAX_AGE_DAYS = 365;
export const FUNDING_MAX_ROWS = 3_000;

/** Minimum gap between refreshes started from POST /api/discover/refresh. */
export const MANUAL_REFRESH_GAP_MS = 60_000;

export function isTestEnv(env: Env = process.env): boolean {
  return Boolean(env.VITEST) || env.NODE_ENV === "test";
}

export function discoverConfig(env: Env = process.env): DiscoverConfig {
  const raw = Number.parseInt(String(env.DISCOVER_REFRESH_MIN ?? ""), 10);
  const refreshMin = Number.isFinite(raw) ? Math.min(MAX_REFRESH_MIN, Math.max(MIN_REFRESH_MIN, raw)) : DEFAULT_REFRESH_MIN;
  return {
    enabled: String(env.DISCOVER_ENABLED ?? "1").trim() !== "0",
    refreshMin,
    llmRefine: String(env.DISCOVER_LLM_REFINE ?? "1").trim() !== "0",
  };
}
