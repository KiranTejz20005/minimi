import type {
  CitationRegistry,
  CitationSource,
} from "../search/types.js";

const CITE_RE = /\[(\d+)\]/g;

export function citedNumbers(text: string): number[] {
  const seen = new Set<number>();
  for (const m of text.matchAll(CITE_RE)) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

/** Remove citation markers that do not exist in the turn registry. */
export function stripInvalidCitations(
  text: string,
  valid: ReadonlySet<number>,
): string {
  return text.replace(CITE_RE, (_full, raw: string) => {
    const n = Number(raw);
    return valid.has(n) ? `[${n}]` : "";
  });
}

export function collectSources(
  registry: CitationRegistry,
  cited: number[],
): CitationSource[] {
  const citedSet = new Set(cited);
  const out: CitationSource[] = [];
  for (const [n, src] of registry.sources) {
    if (citedSet.has(n)) out.push(src);
  }
  out.sort((a, b) => a.n - b.n);
  return out;
}

export type SourcesPayload = Record<
  string,
  { url: string; title: string; publishedAt: string | null }
>;

export function sourcesToPayload(
  sources: CitationSource[],
): SourcesPayload {
  const out: SourcesPayload = {};
  for (const s of sources) {
    out[String(s.n)] = {
      url: s.url,
      title: s.title,
      publishedAt: s.publishedAt,
    };
  }
  return out;
}
