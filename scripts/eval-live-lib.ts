/**
 * Pure scoring helpers for the live (real-model) eval: no network, no DB, no process state.
 * Unit-tested in test/eval-live-lib.test.ts. Used by scripts/eval-live.ts and scripts/eval-live-cases.ts.
 */

// ---- text measures ----------------------------------------------------------------------------------------

/** Words = runs of letters/digits (apostrophes and hyphens inside a word keep it whole). Markdown symbols do not count. */
export function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’\-]*/gu) ?? []).length;
}

/**
 * True when the text ends like a finished sentence. Trailing whitespace, markdown emphasis, closing quotes/brackets
 * and a trailing citation like "[3]" are ignored. A trailing code fence counts as finished.
 */
export function endsCleanly(text: string): boolean {
  let t = text.trimEnd();
  if (!t) return false;
  if (t.endsWith("```")) return true;
  for (let i = 0; i < 6; i++) {
    const before = t;
    t = t.replace(/(\s*\[\d+\])+$/, "").replace(/[\s*_~`"'”’)\]»]+$/u, "");
    if (t === before) break;
  }
  return /[.!?…。！？]$/u.test(t);
}

// ---- tool markup ------------------------------------------------------------------------------------------

/** Tool names the detector checks when the caller does not pass the live registry list. */
export const DEFAULT_TOOL_NAMES = [
  "web_search",
  "fetch_url",
  "memory_search",
  "lookup_claims",
  "calculate",
  "read_attachment",
  "save_memory",
  "get_weather",
  "convert_currency",
  "get_latest_news",
];

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Tool-call markup that leaked into user-visible text (a model writing a call as text instead of calling it):
 * `<calculate>`, `<read_attachment ...>`, `<function=...>`, `<tool_call>`, `<parameter=...>`, `<invoke ...>`,
 * `[TOOL_CALLS]`, or a JSON call object `{"name": "calculate", "arguments": ...}`. Returns the matched snippets.
 */
export function findToolMarkup(text: string, toolNames: string[] = DEFAULT_TOOL_NAMES): string[] {
  const hits: string[] = [];
  const generic = /<\/?(?:tool_call|tool_use|toolcall|function_call|function_calls)\b[^>]{0,40}>?|<function=[^>\s]{0,40}|<\/function>|<parameter=[^>\s]{0,40}|<invoke\b[^>]{0,40}|\[TOOL_CALLS\]|<\|tool_call[^>]{0,20}/gi;
  for (const m of text.matchAll(generic)) hits.push(m[0]);
  const names = [...new Set(toolNames)].filter(Boolean).map(escRe);
  if (names.length) {
    const tag = new RegExp(`</?(?:${names.join("|")})(?=[\\s>/])[^>]{0,40}>?`, "gi");
    for (const m of text.matchAll(tag)) hits.push(m[0]);
    const json = new RegExp(`\\{\\s*"name"\\s*:\\s*"(?:${names.join("|")})"\\s*,\\s*"(?:arguments|parameters|input)"`, "gi");
    for (const m of text.matchAll(json)) hits.push(m[0]);
  }
  return hits;
}

export function hasToolMarkup(text: string, toolNames: string[] = DEFAULT_TOOL_NAMES): boolean {
  return findToolMarkup(text, toolNames).length > 0;
}

/**
 * Leaked programming placeholders ("[object Object]", "undefined", "NaN"). Words inside backticks never count.
 * With allowWords (chat/explainer answers, where "undefined" can be legitimate prose) only "[object X]" counts.
 */
export function placeholderLeaks(text: string, opts: { allowWords?: boolean } = {}): string[] {
  const plain = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const out: string[] = [];
  for (const m of plain.matchAll(/\[object [A-Za-z]+\]/g)) out.push(m[0]);
  if (!opts.allowWords) for (const m of plain.matchAll(/\b(?:undefined|NaN)\b/g)) out.push(m[0]);
  return out;
}

// ---- numbers ----------------------------------------------------------------------------------------------

/**
 * Numbers written in the text: "1,234.5", Indian grouping "1,23,456.78", "36", "-4.5", "42.16". A "-" only counts
 * as a sign when it does not follow a letter/digit (so "2027-02-22" is 2027, 2, 22, never -2).
 */
export function extractNumbers(text: string): number[] {
  const out: number[] = [];
  // The lookbehind sits before the optional sign: "-3" after a space is negative, "-02" after "2027" is not.
  const re = /(?<![\p{L}\p{N}.,])(-(?=\d))?(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)/gu;
  for (const m of text.matchAll(re)) {
    const n = Number(m[2]!.replace(/,/g, "")) * (m[1] ? -1 : 1);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** True if some number in the text is within `tolerance` (absolute) of `target`. */
export function hasNumberNear(text: string, target: number, tolerance = 0): boolean {
  return extractNumbers(text).some((n) => Math.abs(n - target) <= tolerance + 1e-9);
}

/** True if some number in the text is within `relTol` (e.g. 0.02 = 2%) of `target`. */
export function hasNumberWithin(text: string, target: number, relTol: number): boolean {
  const tol = Math.abs(target) * relTol;
  return extractNumbers(text).some((n) => Math.abs(n - target) <= tol + 1e-9);
}

/** Numbers in the text that fall inside [min, max]. */
export function numbersInRange(text: string, min: number, max: number): number[] {
  return extractNumbers(text).filter((n) => n >= min && n <= max);
}

/** The converted amount for `to` from a convert_currency tool result ("250 USD = 21,370.25 INR (...)"). */
export function convertedAmount(toolContent: string, to: string): number | null {
  const m = toolContent.match(new RegExp(`=\\s*([\\d,]+(?:\\.\\d+)?)\\s*${escRe(to.toUpperCase())}\\b`));
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ---- dates, temperatures, recall -----------------------------------------------------------------------

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/**
 * Does the text name the calendar date `iso` (YYYY-MM-DD)? Accepts 2027-02-22, 22 February 2027, February 22, 2027,
 * Feb 22nd 2027, 22 Feb, 2027, 22/02/2027, 02/22/2027 and 22.02.2027.
 */
export function mentionsDate(text: string, iso: string): boolean {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`mentionsDate: not an ISO date: ${iso}`);
  const [y, mo, d] = [m[1]!, Number(m[2]), Number(m[3])];
  const t = text.toLowerCase().replace(/\*+/g, "");
  if (t.includes(iso)) return true;
  const full = MONTHS[mo - 1]!;
  const mon = `(?:${full}|${full.slice(0, 3)}\\.?)`;
  const day = `0?${d}(?:st|nd|rd|th)?`;
  const pats = [
    `\\b${day}\\s+(?:of\\s+)?${mon},?\\s+${y}\\b`,
    `\\b${mon}\\s+${day},?\\s+${y}\\b`,
    `\\b0?${d}[/.]0?${mo}[/.]${y}\\b`,
    `\\b0?${mo}/0?${d}/${y}\\b`,
  ];
  return pats.some((p) => new RegExp(p, "i").test(t));
}

/** A temperature reading: "28°C", "28 °C", "28℃", "82°F", "28 degrees", "28.4 C". */
export function mentionsTemperature(text: string): boolean {
  return /-?\d+(?:\.\d+)?\s*(?:°\s*[cf]?|℃|℉|degrees?\b|deg\b|[cf]\b)/i.test(text);
}

/** The answer says it has nothing on record about the user (the recall bug: "I don't have any information..."). */
export function claimsNoRecord(text: string): boolean {
  return /\b(?:i\s+)?(?:don'?t|do not|didn'?t|did not|can'?t|cannot|can not)\s+(?:have|find|see|know|recall|remember)\s+(?:any\s+)?(?:record|information|info|memory|memories|details|data)\b|\bno\s+(?:record|information|saved\s+(?:memory|information)|memory)\s+(?:of|about|on)\b|\b(?:you\s+)?haven'?t\s+(?:told|shared|mentioned)\b|\bi\s+don'?t\s+know\s+your\b|\bnot\s+(?:something\s+)?you'?ve\s+(?:told|shared)\b/i.test(
    text,
  );
}

// ---- citations, hosts --------------------------------------------------------------------------------------

export function citedNumbers(text: string): number[] {
  const seen = new Set<number>();
  for (const m of text.matchAll(/\[(\d+)\]/g)) seen.add(Number(m[1]));
  return [...seen].sort((a, b) => a - b);
}

/** Every [n] in the answer points at a registered source (1..sourceCount). */
export function citationsValid(text: string, sourceCount: number): boolean {
  return citedNumbers(text).every((n) => n >= 1 && n <= sourceCount);
}

/** URL/host that points at a loopback, link-local (cloud metadata), private or single-label host. */
export function isPrivateTarget(raw: string): boolean {
  let host: string;
  try {
    host = new URL(raw.includes("://") ? raw : `http://${raw}`).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return true;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return true;
  if (host.includes(":")) return host === "::1" || host === "::" || /^f[cd]/.test(host) || host.startsWith("fe80") || host.startsWith("::ffff:");
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return !host.includes(".");
}

// ---- redaction ---------------------------------------------------------------------------------------------

const KEY_PATTERNS: RegExp[] = [
  /\b(?:sk-ant-|sk-proj-|sk-|nvapi-|tvly-|ghp_|gho_|github_pat_|xox[abprs]-|AIza|hf_)[A-Za-z0-9_\-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=\-]{8,}/gi,
  /\b(?:api[_-]?key|x-api-key|authorization|access[_-]?token|secret|password)\b(\s*["']?\s*[:=]\s*["']?)[^\s"',;}]{6,}/gi,
  // long opaque tokens mixing letters and digits (keys, JWT parts); ordinary words never look like this
  /\b(?=[A-Za-z0-9_\-]*\d)(?=[A-Za-z0-9_\-]*[A-Za-z])[A-Za-z0-9_\-]{32,}\b/g,
];

/** Remove secrets: the exact `secrets` given (>= 6 chars) and anything shaped like an API key or bearer token. */
export function redact(text: string, secrets: (string | undefined | null)[] = []): string {
  let out = String(text ?? "");
  for (const s of secrets) {
    const v = s?.trim();
    if (v && v.length >= 6) out = out.split(v).join("[REDACTED]");
  }
  for (const re of KEY_PATTERNS) {
    out = out.replace(re, (full, sep?: string) => (typeof sep === "string" && /[:=]/.test(sep) ? `${full.slice(0, full.indexOf(sep))}${sep}[REDACTED]` : "[REDACTED]"));
  }
  return out;
}

/** Redacted, whitespace-collapsed first `n` characters (with an ellipsis when cut). */
export function excerpt(text: string, n = 300, secrets: (string | undefined | null)[] = []): string {
  const t = redact(text, secrets).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// ---- provider stream accounting ----------------------------------------------------------------------------

export type LlmUsage = { inputTokens: number; outputTokens: number };
export type StreamScan = { finishReasons: string[]; usage: LlmUsage | null };

/**
 * Finish/stop reasons and token usage from a provider response body: an SSE stream (OpenAI-compatible
 * `choices[].finish_reason` + `usage`, or Anthropic `message_start`/`message_delta`) or one JSON object.
 * Never returns text content, only counters.
 */
export function scanProviderBody(body: string): StreamScan {
  const finishReasons: string[] = [];
  let input = 0;
  let output = 0;
  let sawUsage = false;
  const take = (j: any) => {
    if (!j || typeof j !== "object") return;
    for (const c of Array.isArray(j.choices) ? j.choices : []) if (typeof c?.finish_reason === "string") finishReasons.push(c.finish_reason);
    if (typeof j.stop_reason === "string") finishReasons.push(j.stop_reason);
    if (typeof j.delta?.stop_reason === "string") finishReasons.push(j.delta.stop_reason);
    const usages = [j.usage, j.message?.usage].filter((u) => u && typeof u === "object");
    for (const u of usages) {
      const i = u.prompt_tokens ?? u.input_tokens;
      const o = u.completion_tokens ?? u.output_tokens;
      if (typeof i === "number") (input = Math.max(input, i), (sawUsage = true));
      if (typeof o === "number") (output = Math.max(output, o), (sawUsage = true));
    }
  };
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) {
    try {
      take(JSON.parse(trimmed));
      return { finishReasons, usage: sawUsage ? { inputTokens: input, outputTokens: output } : null };
    } catch {
      /* fall through to SSE */
    }
  }
  for (const line of body.split(/\r?\n/)) {
    const l = line.trim();
    if (!l.startsWith("data:")) continue;
    const data = l.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      take(JSON.parse(data));
    } catch {
      /* partial or non-JSON line */
    }
  }
  return { finishReasons, usage: sawUsage ? { inputTokens: input, outputTokens: output } : null };
}

// ---- grading ------------------------------------------------------------------------------------------------

export type Status = "PASS" | "FAIL" | "SKIP";
export type Assertion = { name: string; ok: boolean; detail?: string; /** "warn" never fails a case */ severity?: "fail" | "warn" };

export function check(name: string, ok: boolean, detail?: string): Assertion {
  return { name, ok, ...(detail ? { detail } : {}) };
}
export function warn(name: string, ok: boolean, detail?: string): Assertion {
  return { name, ok, severity: "warn", ...(detail ? { detail } : {}) };
}

/** PASS when every fail-severity assertion holds (an empty list is a FAIL: nothing was verified). */
export function grade(assertions: Assertion[]): { status: Exclude<Status, "SKIP">; reasons: string[]; warnings: string[] } {
  const fmt = (a: Assertion) => (a.detail ? `${a.name}: ${a.detail}` : a.name);
  const failed = assertions.filter((a) => !a.ok && a.severity !== "warn");
  const warnings = assertions.filter((a) => !a.ok && a.severity === "warn").map(fmt);
  if (assertions.filter((a) => a.severity !== "warn").length === 0) return { status: "FAIL", reasons: ["no assertions were evaluated"], warnings };
  return { status: failed.length ? "FAIL" : "PASS", reasons: failed.map(fmt), warnings };
}

export type Ambiguity = "asked-which-file" | "covered-both" | "read-both" | "covered-one" | "other";

/**
 * What the agent did with an ambiguous "what does the file say?" over two files. `readFiles` are the file names /
 * ids its read_attachment calls named ("*" = an unnamed outline/search over all files); `coverage` says whether
 * the answer reflects each file's content.
 */
export function classifyAmbiguity(opts: { answer: string; readFiles: string[]; fileNames: string[]; coverage: boolean[] }): Ambiguity {
  const a = opts.answer;
  const covered = opts.coverage.filter(Boolean).length;
  const asks = /\?/.test(a) && /\b(which|what)\b[^?]{0,80}\b(file|one|document)\b|\bwhich (?:file|one|document)\b|\bdo you mean\b|\bclarify\b|\bspecify\b/i.test(a);
  if (asks && covered < opts.fileNames.length) return "asked-which-file";
  if (covered >= opts.fileNames.length && opts.fileNames.length > 0) {
    const readAll = opts.readFiles.includes("*") || opts.fileNames.every((f) => opts.readFiles.some((r) => r.toLowerCase().includes(f.toLowerCase())));
    return readAll ? "read-both" : "covered-both";
  }
  if (asks) return "asked-which-file";
  if (covered > 0) return "covered-one";
  return "other";
}

// ---- summary + table ----------------------------------------------------------------------------------------

export type SummaryInput = { id: string; category: string; status: Status; ms: number };
export type Summary = {
  total: number;
  pass: number;
  fail: number;
  skip: number;
  /** PASS / (PASS + FAIL); null when nothing was graded. */
  passRate: number | null;
  byCategory: Record<string, { pass: number; fail: number; skip: number; passRate: number | null }>;
  totalMs: number;
};

const rate = (p: number, f: number) => (p + f ? Math.round((p / (p + f)) * 1000) / 1000 : null);

export function summarize(results: SummaryInput[]): Summary {
  const byCategory: Summary["byCategory"] = {};
  let pass = 0;
  let fail = 0;
  let skip = 0;
  let totalMs = 0;
  for (const r of results) {
    const c = (byCategory[r.category] ??= { pass: 0, fail: 0, skip: 0, passRate: null });
    if (r.status === "PASS") (pass++, c.pass++);
    else if (r.status === "FAIL") (fail++, c.fail++);
    else (skip++, c.skip++);
    totalMs += r.ms;
  }
  for (const c of Object.values(byCategory)) c.passRate = rate(c.pass, c.fail);
  return { total: results.length, pass, fail, skip, passRate: rate(pass, fail), byCategory, totalMs };
}

export function pct(r: number | null): string {
  return r === null ? "n/a" : `${Math.round(r * 100)}%`;
}

/** Left-aligned plain-text table; cells are cut to `maxCell` characters. */
export function formatTable(header: string[], rows: string[][], maxCell = 70): string {
  const cut = (s: string) => (s.length > maxCell ? `${s.slice(0, maxCell - 1)}…` : s);
  const all = [header, ...rows].map((r) => r.map((c) => cut(String(c ?? ""))));
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd();
  return [line(all[0]!), widths.map((w) => "-".repeat(w)).join("  "), ...all.slice(1).map(line)].join("\n");
}

/** File-system safe report name: data/eval-live/<ISO>-<model>.json (no ':' for Windows). */
export function reportFileName(isoNow: string, model: string): string {
  const ts = isoNow.replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
  const m = model.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "model";
  return `${ts}-${m}.json`;
}
