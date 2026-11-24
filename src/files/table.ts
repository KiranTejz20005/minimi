/** Server-side column statistics for table attachments, so the model never has to add up numbers itself. */

export type ColumnStats =
  | { name: string; type: "number"; count: number; empty: number; min: number; max: number; sum: number; mean: number }
  | { name: string; type: "text"; count: number; empty: number; distinct: number; top: { value: string; n: number }[] };

const NUM_RE = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;

/** Parse "1,234.5", "$12", "45%" (percent stays as the written number). Returns null when not numeric. */
export function toNumber(raw: string): number | null {
  let s = raw.trim();
  if (!s) return null;
  s = s.replace(/^[$€£]\s?/, "").replace(/\s?%$/, "");
  if (/^[-+]?\.\d+$/.test(s)) s = s.replace(".", "0.");
  if (!NUM_RE.test(s)) {
    if (/^[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(s)) return Number(s);
    return null;
  }
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

const round = (n: number) => Number(n.toPrecision(12));

export function columnStats(header: string[], rows: string[][]): ColumnStats[] {
  return header.map((name, c) => {
    const vals = rows.map((r) => (r[c] ?? "").trim());
    const nonEmpty = vals.filter((v) => v !== "");
    const empty = vals.length - nonEmpty.length;
    const nums = nonEmpty.map(toNumber);
    const numeric = nums.filter((n): n is number => n !== null);
    if (nonEmpty.length && numeric.length / nonEmpty.length >= 0.9) {
      const sum = numeric.reduce((a, b) => a + b, 0);
      return {
        name: name || `col${c + 1}`,
        type: "number" as const,
        count: numeric.length,
        empty: empty + (nonEmpty.length - numeric.length),
        min: round(Math.min(...numeric)),
        max: round(Math.max(...numeric)),
        sum: round(sum),
        mean: round(sum / numeric.length),
      };
    }
    const freq = new Map<string, number>();
    for (const v of nonEmpty) freq.set(v, (freq.get(v) ?? 0) + 1);
    const top = [...freq.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([value, n]) => ({ value: value.slice(0, 60), n }));
    return { name: name || `col${c + 1}`, type: "text" as const, count: nonEmpty.length, empty, distinct: freq.size, top };
  });
}

export type RowFilter = { column: string; equals?: string; contains?: string };

export function filterRows(header: string[], rows: string[][], f: RowFilter): { rows: string[][]; indexes: number[]; error?: string } {
  const want = f.column.trim().toLowerCase();
  const c = header.findIndex((h) => h.trim().toLowerCase() === want);
  if (c < 0) return { rows: [], indexes: [], error: `no column named "${f.column}"` };
  const eq = f.equals?.trim().toLowerCase();
  const has = f.contains?.trim().toLowerCase();
  const out: string[][] = [];
  const indexes: number[] = [];
  rows.forEach((r, i) => {
    const v = (r[c] ?? "").trim().toLowerCase();
    if ((eq === undefined || v === eq) && (has === undefined || v.includes(has))) {
      out.push(r);
      indexes.push(i);
    }
  });
  return { rows: out, indexes };
}
