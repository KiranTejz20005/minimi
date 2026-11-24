import { tokenize } from "../memory/bm25.js";
import type { Doc } from "./doc.js";

export type Chunk = {
  text: string;
  page?: number;
  sheet?: string;
  rowStart?: number;
  rowEnd?: number;
  /** char offset into the plain-text document */
  offset?: number;
};

const CHUNK_CHARS = 1000;

/** Split a block of text into <= CHUNK_CHARS pieces on line / sentence / space boundaries. */
export function splitText(text: string, size = CHUNK_CHARS): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + size);
    if (end < text.length) {
      const window = text.slice(i, end);
      const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(". "), window.lastIndexOf(" "));
      if (cut > size * 0.5) end = i + cut + 1;
    }
    const piece = text.slice(i, end).trim();
    if (piece) out.push({ text: piece, offset: i });
    i = end;
  }
  return out;
}

export function chunkDoc(doc: Doc): Chunk[] {
  const chunks: Chunk[] = [];
  if (doc.type === "pdf") {
    doc.pages.forEach((p, i) => {
      for (const c of splitText(p)) chunks.push({ text: c.text, page: i + 1, offset: c.offset });
    });
  } else if (doc.type === "text") {
    for (const c of splitText(doc.text)) chunks.push({ text: c.text, offset: c.offset });
  } else {
    for (const sh of doc.sheets) {
      let buf: string[] = [];
      let start = 2;
      let len = 0;
      const header = sh.rows[0] ?? [];
      const flush = (end: number) => {
        if (buf.length) chunks.push({ text: buf.join("\n"), sheet: sh.name, rowStart: start, rowEnd: end });
        buf = [];
        len = 0;
      };
      for (let r = 1; r < sh.rows.length; r++) {
        const line = sh.rows[r].map((v, c) => (v === "" ? "" : `${header[c] || `col${c + 1}`}: ${v}`)).filter(Boolean).join(" | ");
        if (!buf.length) start = r + 1;
        buf.push(line);
        len += line.length + 1;
        if (len >= CHUNK_CHARS || buf.length >= 25) flush(r + 1);
      }
      flush(sh.rows.length);
    }
  }
  return chunks;
}

export type Scored = { chunk: Chunk; score: number };

/**
 * BM25 over chunks. Same tokenizer and formula as src/memory/bm25.ts, but the corpus statistics are computed once
 * (bm25Score() re-tokenizes the corpus per document, which is quadratic for a 1000-chunk file). Falls back to a
 * case-insensitive substring match when the query has no indexable tokens (e.g. a single character or an id).
 */
export function searchChunks(chunks: Chunk[], query: string, k1 = 1.2, b = 0.75): Scored[] {
  const q = tokenize(query);
  if (!q.length) {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    return chunks.filter((c) => c.text.toLowerCase().includes(needle)).map((chunk) => ({ chunk, score: 1 }));
  }
  const docs = chunks.map((c) => tokenize(c.text));
  const N = docs.length;
  const avg = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, N);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const scored: Scored[] = [];
  docs.forEach((d, i) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const term of new Set(q)) {
      const f = tf.get(term) ?? 0;
      if (!f) continue;
      const n = df.get(term) ?? 0;
      score += Math.log(1 + (N - n + 0.5) / (n + 0.5)) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / Math.max(1, avg))));
    }
    if (score > 0) scored.push({ chunk: chunks[i], score });
  });
  return scored.sort((a, b2) => b2.score - a.score);
}
