import { createHash } from "node:crypto";
import { getDb } from "../db.js";
import { getConfig } from "../config.js";
import { getClock } from "../clock.js";
import type { SearchInput, TrimmedResult } from "./types.js";

function normalizeDomains(domains: string[] | undefined): string[] {
  if (!domains?.length) return [];
  return [...domains]
    .map((d) =>
      d
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .split("/")[0]!,
    )
    .filter(Boolean)
    .sort();
}

/** Cache key: hash(query, start_date, domains, topic) per schema.sql */
export function cacheKey(input: SearchInput): string {
  const payload = {
    query: input.query.trim().toLowerCase(),
    start_date: input.start_date ?? "",
    domains: normalizeDomains(input.domains),
    topic: input.topic ?? "general",
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export const searchCacheKey = cacheKey;

export function getCached(key: string): TrimmedResult[] | null {
  const cfg = getConfig();
  const row = getDb()
    .prepare(`SELECT response, created_at FROM search_cache WHERE key = ?`)
    .get(key) as { response: string; created_at: string } | undefined;
  if (!row) return null;

  const age =
    (getClock().now().getTime() - new Date(row.created_at).getTime()) / 1000;
  if (age > cfg.SEARCH_CACHE_TTL_SEC) {
    getDb().prepare(`DELETE FROM search_cache WHERE key = ?`).run(key);
    return null;
  }

  try {
    const parsed = JSON.parse(row.response) as TrimmedResult[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export const getSearchCache = getCached;

export function setCached(key: string, results: TrimmedResult[]): void {
  getDb()
    .prepare(
      `INSERT INTO search_cache (key, response, created_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET response = excluded.response, created_at = excluded.created_at`,
    )
    .run(key, JSON.stringify(results), getClock().now().toISOString());
}

export const setSearchCache = setCached;
