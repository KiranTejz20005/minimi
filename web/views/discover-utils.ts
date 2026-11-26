/* Pure helpers for the Discover view (web/views/DiscoverView.tsx). No DOM or React imports, so they run in
   vitest under node (test/discover-utils.test.ts) and type-check under both tsconfigs. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Milliseconds since epoch, or null for a missing / unparsable timestamp. */
export function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Whole local calendar days between two instants (b - a): 1 means "b is the day after a". */
function calendarDayDiff(a: number, b: number): number {
  const da = new Date(a);
  const db = new Date(b);
  const ua = Date.UTC(da.getFullYear(), da.getMonth(), da.getDate());
  const ub = Date.UTC(db.getFullYear(), db.getMonth(), db.getDate());
  return Math.round((ub - ua) / DAY);
}

/** "Nov 3", or "Nov 3, 2025" when the year differs from `now`'s. */
export function shortDate(iso: string | null | undefined, now: number = Date.now()): string {
  const t = parseTime(iso);
  if (t === null) return "";
  const d = new Date(t);
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

/**
 * Human relative time for feed items: "just now", "4 min ago", "3 hr ago", "yesterday", "3 days ago", then a date.
 * Timestamps slightly in the future (clock skew between feeds and this machine) read as "just now".
 */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  const t = parseTime(iso);
  if (t === null) return "";
  const diff = now - t;
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} hr ago`;
  const days = calendarDayDiff(t, now);
  if (days <= 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return shortDate(iso, now);
}

/** "in 12 min" / "in 2 hr" / "soon" for a time ahead of now (next scheduled refresh). */
export function relativeUntil(iso: string | null | undefined, now: number = Date.now()): string {
  const t = parseTime(iso);
  if (t === null) return "";
  const diff = t - now;
  if (diff < MINUTE) return "soon";
  if (diff < HOUR) return `in ${Math.round(diff / MINUTE)} min`;
  if (diff < DAY) return `in ${Math.round(diff / HOUR)} hr`;
  return `on ${shortDate(iso, now)}`;
}

/** Full, unambiguous timestamp for tooltips: "Wednesday, Nov 25, 2026 at 14:05". */
export function fullDate(iso: string | null | undefined): string {
  const t = parseTime(iso);
  if (t === null) return "";
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} at ${hh}:${mm}`;
}

/** Header status: "Refreshing sources…", "Updated 4 min ago", "Not refreshed yet". */
export function statusText(s: { refreshing?: boolean; lastRefreshAt?: string | null } | null, now: number = Date.now()): string {
  if (!s) return "Checking sources…";
  if (s.refreshing) return "Refreshing sources…";
  const rel = relativeTime(s.lastRefreshAt, now);
  return rel ? `Updated ${rel}` : "Not refreshed yet";
}

/* ── Money ─────────────────────────────────────────────────────────────── */

export type AmountParts = { symbol: string; value: string; unit: "" | "K" | "M" | "B" | "T" };
const UNITS: { unit: AmountParts["unit"]; size: number; word: string }[] = [
  { unit: "T", size: 1e12, word: "trillion" },
  { unit: "B", size: 1e9, word: "billion" },
  { unit: "M", size: 1e6, word: "million" },
  { unit: "K", size: 1e3, word: "thousand" },
];

/** One decimal at most, trailing ".0" dropped: 12.5, 12, 1.2. */
function oneDecimal(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** Splits a USD amount for the card hero ("$", "12.5", "M"). Null for missing, negative or non-finite amounts. */
export function amountParts(usd: number | null | undefined): AmountParts | null {
  if (usd === null || usd === undefined || !Number.isFinite(usd) || usd < 0) return null;
  for (let i = 0; i < UNITS.length; i++) {
    const u = UNITS[i]!;
    if (usd >= u.size) {
      const v = Math.round((usd / u.size) * 10) / 10;
      // 999.96M rounds to "1000M": promote to the next unit up so it reads "$1B".
      if (v >= 1000 && i > 0) return { symbol: "$", value: oneDecimal(usd / UNITS[i - 1]!.size), unit: UNITS[i - 1]!.unit };
      return { symbol: "$", value: oneDecimal(usd / u.size), unit: u.unit };
    }
  }
  return { symbol: "$", value: String(Math.round(usd)), unit: "" };
}

/** "$12.5M", "$1.2B", "$850K", "$500"; "—" when the amount is unknown. */
export function formatAmount(usd: number | null | undefined): string {
  const p = amountParts(usd);
  return p ? `${p.symbol}${p.value}${p.unit}` : "—";
}

/** Screen-reader form: "$12.5 million". */
export function spokenAmount(usd: number | null | undefined): string {
  const p = amountParts(usd);
  if (!p) return "Amount not disclosed";
  const word = UNITS.find((u) => u.unit === p.unit)?.word;
  return word ? `$${p.value} ${word}` : `$${p.value}`;
}

/** What the card shows for a startup's raise: the USD amount when known, else the article's wording, else "Undisclosed". */
export function amountHeadline(s: { amountUsd: number | null; amountText: string | null }): { text: string; disclosed: boolean } {
  if (amountParts(s.amountUsd)) return { text: formatAmount(s.amountUsd), disclosed: true };
  const raw = (s.amountText ?? "").trim();
  if (raw) return { text: raw.length > 24 ? `${raw.slice(0, 23)}…` : raw, disclosed: true };
  return { text: "Undisclosed", disclosed: false };
}

/** "Reported as €20 million" when the article quoted a non-USD currency, so the converted figure is not mistaken for the original. */
export function originalAmountNote(s: { amountUsd: number | null; amountText: string | null; currency: string | null }): string | null {
  const cur = (s.currency ?? "").trim().toUpperCase();
  const raw = (s.amountText ?? "").trim();
  if (!raw || !cur || cur === "USD" || !amountParts(s.amountUsd)) return null;
  return `Reported as ${raw}`;
}

/* ── Labels ────────────────────────────────────────────────────────────── */

export const NEWS_DOMAINS = ["all", "ai", "startups", "technology", "business", "science", "health", "world"] as const;
export type NewsDomain = (typeof NEWS_DOMAINS)[number];

const DOMAIN_LABELS: Record<string, string> = {
  all: "All",
  ai: "AI",
  startups: "Startups",
  technology: "Technology",
  business: "Business",
  science: "Science",
  health: "Health",
  world: "World",
};
const ACRONYMS: Record<string, string> = {
  ai: "AI", ml: "ML", saas: "SaaS", b2b: "B2B", b2c: "B2C", ev: "EV", ar: "AR", vr: "VR", xr: "XR", hr: "HR", iot: "IoT",
  api: "API", devtools: "Devtools", fintech: "Fintech", insurtech: "Insurtech", proptech: "Proptech", edtech: "Edtech",
  healthtech: "Healthtech", biotech: "Biotech", medtech: "Medtech", deeptech: "Deeptech", cleantech: "Cleantech", us: "US", uk: "UK", eu: "EU",
};

/** "climate_tech" → "Climate tech", "ai-infra" → "AI infra", "b2b saas" → "B2B SaaS". Sentence case, known acronyms kept. */
export function humanize(id: string | null | undefined): string {
  const words = String(id ?? "").trim().split(/[\s_\-]+/).filter(Boolean);
  if (!words.length) return "";
  return words
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (ACRONYMS[lower]) return ACRONYMS[lower];
      // Keep words that already carry capitals ("OpenAI") as written.
      if (/[A-Z]/.test(w.slice(1))) return w;
      return i === 0 ? lower[0]!.toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}

type Facet = { id: string; label: string; count?: number };

/** Label for a news domain: the server's own label first, then the built-in names, then a humanized id. */
export function domainLabel(id: string, facets?: Facet[] | null): string {
  const f = facets?.find((x) => x.id === id);
  if (f?.label) return f.label;
  return DOMAIN_LABELS[id] ?? humanize(id);
}

/** Label for a startup sector (same lookup order as domains; "all" → "All"). */
export function sectorLabel(id: string, facets?: Facet[] | null): string {
  if (id === "all") return "All";
  const f = facets?.find((x) => x.id === id);
  if (f?.label) return f.label;
  return humanize(id);
}

/** "series_a" → "Series A", "pre-seed" → "Pre-seed", "seed" → "Seed", "series b extension" → "Series B extension". */
export function roundLabel(round: string | null | undefined): string {
  const raw = String(round ?? "").trim();
  if (!raw) return "";
  const m = /^series[\s_\-]*([a-z])(\b|[\s_\-]|$)(.*)$/i.exec(raw);
  if (m) {
    const rest = humanize(m[3] ?? "").toLowerCase();
    return `Series ${m[1]!.toUpperCase()}${rest ? ` ${rest}` : ""}`;
  }
  if (/^pre[\s_\-]?seed$/i.test(raw)) return "Pre-seed";
  if (/^pre[\s_\-]?series[\s_\-]*([a-z])$/i.test(raw)) return `Pre-Series ${raw.slice(-1).toUpperCase()}`;
  return humanize(raw);
}

/**
 * Chip list for the filter row: "All" first with the sum of counts, then the server's facets in its order.
 * Built-in ids that the server did not report are kept (count 0) so the row does not jump between polls.
 */
export function facetChips(facets: Facet[] | null | undefined, builtIn: readonly string[] = []): { id: string; label: string; count: number }[] {
  const list = (facets ?? []).filter((f) => f && f.id && f.id !== "all");
  const seen = new Set(list.map((f) => f.id));
  const total = list.reduce((n, f) => n + (Number.isFinite(f.count) ? (f.count as number) : 0), 0);
  const chips = list.map((f) => ({ id: f.id, label: f.label || DOMAIN_LABELS[f.id] || humanize(f.id), count: Number.isFinite(f.count) ? (f.count as number) : 0 }));
  for (const id of builtIn) if (id !== "all" && !seen.has(id)) chips.push({ id, label: DOMAIN_LABELS[id] ?? humanize(id), count: 0 });
  return [{ id: "all", label: "All", count: total }, ...chips];
}

/** "1 story" / "12 stories". */
export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** "Sequoia", "Sequoia and Accel", "Sequoia, Accel and 3 others". */
export function investorsLine(investors: string[] | null | undefined, max = 2): string {
  const list = (investors ?? []).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) return "";
  if (list.length === 1) return list[0]!;
  if (list.length <= max) return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  const rest = list.length - max;
  return `${list.slice(0, max).join(", ")} and ${rest} ${rest === 1 ? "other" : "others"}`;
}

/* ── Grouping ──────────────────────────────────────────────────────────── */

/** Section heading for a news item's day: "Today", "Yesterday", weekday within the week, else a date. */
export function dayGroupLabel(iso: string | null | undefined, now: number = Date.now()): string {
  const t = parseTime(iso);
  if (t === null) return "Earlier";
  const days = calendarDayDiff(t, now);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return WEEKDAYS[new Date(t).getDay()]!;
  return shortDate(iso, now);
}

/** Consecutive items grouped under day headings, order preserved (the server sorts newest first). */
export function groupByDay<T extends { publishedAt: string }>(items: T[], now: number = Date.now()): { key: string; label: string; items: T[] }[] {
  const groups: { key: string; label: string; items: T[] }[] = [];
  for (const it of items) {
    const label = dayGroupLabel(it.publishedAt, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(it);
    else groups.push({ key: `${label}-${groups.length}`, label, items: [it] });
  }
  return groups;
}

/* ── Monograms (stand-in for remote thumbnails, which the CSP blocks) ─── */

export const MONOGRAM_TONES = ["accent", "green", "amber", "neutral"] as const;
export type MonogramTone = (typeof MONOGRAM_TONES)[number];

/** One letter for a source or company: "The Verge" → "V", "techcrunch.com" → "T", "42 Capital" → "4". */
export function monogram(name: string | null | undefined): string {
  let s = String(name ?? "").trim();
  s = s.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  s = s.replace(/^the\s+/i, "");
  const m = /[\p{L}\p{N}]/u.exec(s);
  return m ? m[0].toLocaleUpperCase("en-US") : "?";
}

/** FNV-1a 32-bit: a stable small hash so a source keeps its tone across reloads. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic tone (a theme token family) for a monogram, keyed case-insensitively. */
export function monogramTone(key: string | null | undefined): MonogramTone {
  const k = String(key ?? "").trim().toLowerCase();
  return MONOGRAM_TONES[hash(k) % MONOGRAM_TONES.length]!;
}

/* ── URLs ──────────────────────────────────────────────────────────────── */

/** The URL as an href only when it is absolute http(s); anything else (javascript:, data:, relative) is null. */
export function safeHttpUrl(url: string | null | undefined): string | null {
  const raw = String(url ?? "").trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  return u.href;
}

/** "www.techcrunch.com" → "techcrunch.com"; "" for unsafe or unparsable URLs. */
export function hostOf(url: string | null | undefined): string {
  const safe = safeHttpUrl(url);
  if (!safe) return "";
  return new URL(safe).hostname.replace(/^www\./i, "");
}

/* ── Lists, paging and polling ─────────────────────────────────────────── */

/** Appends a page, dropping ids already shown (offset paging can repeat items when new ones arrive on top). */
export function mergeUnique<T extends { id: string }>(current: T[], next: T[]): T[] {
  const seen = new Set(current.map((x) => x.id));
  const out = current.slice();
  for (const it of next) {
    if (it && !seen.has(it.id)) {
      seen.add(it.id);
      out.push(it);
    }
  }
  return out;
}

/** How many items of a freshly polled first page are not on screen yet (drives the "N new" pill). */
export function countUnseen<T extends { id: string }>(fresh: T[], shown: T[]): number {
  const ids = new Set(shown.map((x) => x.id));
  return fresh.reduce((n, x) => (ids.has(x.id) ? n : n + 1), 0);
}

/** Updates shown items in place from a polled page (same ids, same order), so a background poll never reorders or jumps. */
export function refreshInPlace<T extends { id: string }>(shown: T[], fresh: T[]): T[] {
  if (!fresh.length) return shown;
  const byId = new Map(fresh.map((x) => [x.id, x]));
  let changed = false;
  const out = shown.map((x) => {
    const f = byId.get(x.id);
    if (f && f !== x) {
      changed = true;
      return f;
    }
    return x;
  });
  return changed ? out : shown;
}

/** Whether more pages remain. */
export function hasMore(shown: number, total: number): boolean {
  return Number.isFinite(total) && shown < total;
}

/** Query string from params, skipping empty strings, null and undefined: "?domain=ai&limit=30". */
export function buildQuery(params: Record<string, string | number | null | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : v.trim();
    if (!s) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(s)}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

/** Seconds from a Retry-After header (delta-seconds or an HTTP date); null when absent or unusable. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  const v = String(value ?? "").trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return Math.min(Number(v), 3600);
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.min(Math.ceil((t - now) / 1000), 3600));
}

/** A readable sentence for a failed request, from its HTTP status (0 = network failure) and server message. */
export function describeError(status: number | null | undefined, message: string | null | undefined): string {
  const msg = String(message ?? "").trim();
  if (!status) return "Couldn't reach the server. Check your connection and try again.";
  if (status === 404) return msg && msg !== "Not found" ? msg : "Discover isn't available on this server yet.";
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  if (status === 401 || status === 403) return msg || "You don't have access to this.";
  if (status >= 500) return msg && msg !== "Internal server error" ? msg : "The server ran into a problem. Try again in a moment.";
  return msg || "Something went wrong.";
}

/* ── AI context ────────────────────────────────────────────────────────── */

export type ContextLike = {
  whatTheyDo?: unknown;
  funding?: unknown;
  investors?: unknown;
  whyItMatters?: unknown;
  market?: unknown;
  caveats?: unknown;
};

/** Text from a string or a list of strings ("- a", "• b" bullets become lines); anything else is empty. */
export function textLines(v: unknown): string[] {
  const raw: string[] = Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : "")) : typeof v === "string" ? v.split(/\r?\n/) : [];
  return raw.map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim()).filter(Boolean);
}

export const CONTEXT_SECTIONS: { key: keyof ContextLike; title: string }[] = [
  { key: "whatTheyDo", title: "What they do" },
  { key: "funding", title: "Funding" },
  { key: "investors", title: "Investors" },
  { key: "whyItMatters", title: "Why it matters" },
  { key: "market", title: "Market" },
];

/** The five context sections in reading order, skipping any the model left empty. */
export function contextSections(ctx: ContextLike | null | undefined): { key: string; title: string; lines: string[] }[] {
  if (!ctx) return [];
  return CONTEXT_SECTIONS.map((s) => ({ key: s.key, title: s.title, lines: textLines(ctx[s.key]) })).filter((s) => s.lines.length > 0);
}

/* ── Source health ─────────────────────────────────────────────────────── */

export type SourceLike = { name: string; ok: boolean; items?: number; ms?: number; error?: string };

/** "12 sources", "11 of 12 sources working". */
export function sourceSummary(sources: SourceLike[] | null | undefined): { text: string; failing: number; total: number } {
  const list = sources ?? [];
  const failing = list.filter((s) => !s.ok).length;
  const total = list.length;
  if (!total) return { text: "No sources yet", failing: 0, total: 0 };
  if (!failing) return { text: plural(total, "source", "sources"), failing, total };
  return { text: `${total - failing} of ${plural(total, "source", "sources")} working`, failing, total };
}

/** Failing sources first, then by name, so problems are seen first in the health list. */
export function sortSources<T extends SourceLike>(sources: T[] | null | undefined): T[] {
  return (sources ?? []).slice().sort((a, b) => Number(a.ok) - Number(b.ok) || a.name.localeCompare(b.name));
}
