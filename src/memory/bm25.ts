const STOP = new Set(
  "a an the and or but in on at to for of is are was were be been with from as by it this that what when where who how".split(
    " ",
  ),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export function bm25Score(
  query: string,
  doc: string,
  corpusDocs: string[],
  k1 = 1.2,
  b = 0.75,
): number {
  const qTerms = tokenize(query);
  if (qTerms.length === 0) return 0;
  const dTerms = tokenize(doc);
  const dl = dTerms.length;
  const avgLen =
    corpusDocs.reduce((s, d) => s + tokenize(d).length, 0) /
    Math.max(1, corpusDocs.length);

  const df = new Map<string, number>();
  for (const cd of corpusDocs) {
    const seen = new Set(tokenize(cd));
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = corpusDocs.length;

  let score = 0;
  const tf = new Map<string, number>();
  for (const t of dTerms) tf.set(t, (tf.get(t) ?? 0) + 1);

  for (const term of qTerms) {
    const f = tf.get(term) ?? 0;
    if (f === 0) continue;
    const n = df.get(term) ?? 0;
    const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
    score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * dl) / avgLen)));
  }
  return score;
}

export const BM25_MATCH_THRESHOLD = 0.8;
export const BM25_THRESHOLD = BM25_MATCH_THRESHOLD;

export function rankBm25(
  query: string,
  docs: string[],
): { scores: number[]; best: number } {
  const scores = docs.map((d) => bm25Score(query, d, docs));
  return { scores, best: Math.max(0, ...scores) };
}
