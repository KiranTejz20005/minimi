/**
 * Small RFC-4180 delimited-text parser (CSV / TSV / ;- and |-separated). No dependency.
 * Handles quoted fields, escaped quotes (""), embedded delimiters/newlines in quotes, CRLF/LF/CR line ends,
 * a UTF-8 BOM, ragged rows and an unterminated final quote (taken to end of input).
 */

export type Delimiter = "," | "\t" | ";" | "|";
const CANDIDATES: Delimiter[] = [",", "\t", ";", "|"];

export type ParseOptions = { delimiter?: Delimiter; maxRows?: number; maxCols?: number };
export type Parsed = { rows: string[][]; delimiter: Delimiter; truncated: boolean };

/** Pick the delimiter whose per-line count (outside quotes) is the most consistent and > 0 over the first lines. */
export function sniffDelimiter(text: string): Delimiter {
  const sample = text.replace(/^\uFEFF/, "").slice(0, 20_000);
  const lines: Record<string, number>[] = [];
  let counts: Record<string, number> = {};
  let inQ = false;
  for (let i = 0; i < sample.length && lines.length < 30; i++) {
    const ch = sample[i];
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch === "\n") {
      lines.push(counts);
      counts = {};
    } else if (!inQ && (CANDIDATES as string[]).includes(ch)) counts[ch] = (counts[ch] ?? 0) + 1;
  }
  if (Object.keys(counts).length) lines.push(counts);
  let best: Delimiter = ",";
  let bestScore = 0;
  for (const d of CANDIDATES) {
    const per = lines.map((l) => l[d] ?? 0);
    const nonzero = per.filter((n) => n > 0);
    if (!nonzero.length) continue;
    const mode = [...nonzero].sort((a, b) => nonzero.filter((x) => x === b).length - nonzero.filter((x) => x === a).length)[0];
    const consistent = per.filter((n) => n === mode).length;
    const score = consistent * 1000 + mode; // consistency first, then more columns
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

export function parseDelimited(input: string, opts: ParseOptions = {}): Parsed {
  const text = input.replace(/^\uFEFF/, "");
  const delimiter = opts.delimiter ?? sniffDelimiter(text);
  const maxRows = opts.maxRows ?? Infinity;
  const maxCols = opts.maxCols ?? Infinity;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  let truncated = false;
  let fieldStarted = false;

  const endField = () => {
    if (row.length < maxCols) row.push(field);
    else truncated = true;
    field = "";
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    // A completely blank line yields [""] - skip it (but keep rows that have any delimiter).
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && !fieldStarted && field === "") {
      inQ = true;
      fieldStarted = true;
    } else if (ch === delimiter) endField();
    else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else if (ch === "\n") endRow();
    else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (rows.length < maxRows && (field !== "" || row.length > 0 || inQ)) endRow();
  return { rows, delimiter, truncated };
}

/** Pad/trim ragged rows to a common width (the widest row, capped). */
export function squareRows(rows: string[][], width?: number): string[][] {
  const w = width ?? rows.reduce((m, r) => Math.max(m, r.length), 0);
  return rows.map((r) => (r.length === w ? r : r.length > w ? r.slice(0, w) : [...r, ...Array(w - r.length).fill("")]));
}
