/** A user-facing calculation failure (bad syntax, unknown unit, domain error...). Message is safe to show the model. */
export class CalcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalcError";
  }
}

/** What every calc engine returns. `result` is the bare answer, `text` the readable one-liner. */
export type CalcOutput = { result: string; text: string };

/** Round away binary floating-point noise (0.1+0.2 -> 0.3) to 12 significant digits; exact for safe integers. */
export function cleanNumber(x: number): number {
  if (Object.is(x, -0)) return 0;
  if (Number.isInteger(x) && Math.abs(x) <= Number.MAX_SAFE_INTEGER + 1) return x;
  return Number(x.toPrecision(12));
}

export function formatNumber(x: number): string {
  if (!Number.isFinite(x)) throw new CalcError("result is too large or undefined");
  const c = cleanNumber(x);
  return Object.is(c, -0) ? "0" : String(c);
}

/** Short, printable excerpt of untrusted text for error messages. */
export function excerpt(s: string, n = 24): string {
  const t = s.replace(/[^\x20-\x7e]/g, "?");
  return t.length > n ? `${t.slice(0, n)}...` : t;
}
