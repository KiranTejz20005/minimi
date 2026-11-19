import { rankBm25, tokenize } from "../memory/bm25.js";
import {
  MAX_CHARS_PER_RESULT,
  MAX_SEARCH_RESULTS,
  type RawResult,
  type TrimmedResult,
} from "./types.js";

const CHUNK_RE = /<chunk\s*\d+\s*>/gi;

/** Split Tavily-style extracts into passages for BM25 ranking. */
export function splitPassages(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const parts: string[] = [];
  const withoutChunks = normalized.replace(CHUNK_RE, "\n\n");
  for (const block of withoutChunks.split(/\n{2,}/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (trimmed.length > 400) {
      for (const line of trimmed.split(/\n/)) {
        const l = line.trim();
        if (l.length > 0) parts.push(l);
      }
    } else {
      parts.push(trimmed);
    }
  }
  return parts.length > 0 ? parts : [normalized];
}

function queryTerms(query: string): Set<string> {
  return new Set(tokenize(query));
}

function passageHasPriceSignal(passage: string): boolean {
  return /\$[\d,]+|\bUSD\b|\bprice\b/i.test(passage);
}

/** Keep top BM25 passages up to `maxChars` for one result. */
export function trimContent(
  query: string,
  content: string,
  maxChars = MAX_CHARS_PER_RESULT,
): string {
  const passages = splitPassages(content);
  if (passages.length === 0) return "";
  if (passages.length === 1 && passages[0]!.length <= maxChars) return passages[0]!;

  const { scores } = rankBm25(query, passages);
  const ranked = passages
    .map((p, i) => ({ p, score: scores[i] ?? 0, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i);

  const terms = queryTerms(query);
  const selected: string[] = [];
  let len = 0;

  for (const { p, score } of ranked) {
    if (len >= maxChars) break;
    if (score <= 0 && selected.length > 0) continue;
    const remaining = maxChars - len - (selected.length > 0 ? 2 : 0);
    if (remaining <= 0) break;
    const piece =
      p.length <= remaining ? p : `${p.slice(0, remaining).trimEnd()}…`;
    selected.push(piece);
    len += piece.length + (selected.length > 1 ? 2 : 0);
  }

  if (selected.length === 0) {
    return (
      content.slice(0, maxChars).trimEnd() + (content.length > maxChars ? "…" : "")
    );
  }

  const joined = selected.join("\n\n");
  if (joined.length <= maxChars) return joined;

  const withPrice = ranked.filter(
    (r) =>
      passageHasPriceSignal(r.p) &&
      [...terms].some((t) => r.p.toLowerCase().includes(t)),
  );
  if (withPrice.length > 0 && !selected.some((s) => passageHasPriceSignal(s))) {
    const extra = withPrice[0]!.p.slice(0, Math.min(withPrice[0]!.p.length, 200));
    return (joined.slice(0, maxChars - extra.length - 5) + "\n\n" + extra).slice(
      0,
      maxChars,
    );
  }

  return joined.slice(0, maxChars);
}

export function trimSearchResults(query: string, raw: RawResult[]): TrimmedResult[] {
  return raw.slice(0, MAX_SEARCH_RESULTS).map((r) => ({
    url: r.url,
    title: r.title,
    publishedAt: r.publishedAt ?? null,
    content: trimContent(query, r.content),
  }));
}

/** @deprecated use trimSearchResults */
export const trimResults = trimSearchResults;
