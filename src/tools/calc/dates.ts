import * as chrono from "chrono-node";
import { DateTime, FixedOffsetZone, IANAZone, type Zone } from "luxon";
import { getClock } from "../../clock.js";
import { CalcError, excerpt, formatNumber, type CalcOutput } from "./errors.js";

/**
 * Date arithmetic and time-zone conversion on top of luxon. "now"/"today" always come from the app clock
 * (getClock) so tests and CLOCK_OVERRIDE are honoured.
 *
 * Time-zone abbreviations are FIXED offsets (PST is always UTC-8, PDT UTC-7) - they are not the region's
 * current civil time. Use an IANA name (America/Los_Angeles) for DST-aware conversions.
 * IST is ambiguous (India / Ireland / Israel); we read it as India Standard Time (UTC+05:30) and say so in the output.
 * CST, BST, AST and similar are rejected as ambiguous.
 */

export type ResolvedZone = {
  zone: string | Zone;
  label: string;
  offsetMinutes?: number;
  note?: string;
};

const ABBREVIATIONS = new Map<string, { offset: number; note?: string }>([
  ["UTC", { offset: 0 }],
  ["GMT", { offset: 0 }],
  ["Z", { offset: 0 }],
  ["PST", { offset: -480 }],
  ["PDT", { offset: -420 }],
  ["MST", { offset: -420 }],
  ["MDT", { offset: -360 }],
  ["EST", { offset: -300 }],
  ["EDT", { offset: -240 }],
  ["CET", { offset: 60 }],
  ["CEST", { offset: 120 }],
  ["JST", { offset: 540 }],
  [
    "IST",
    {
      offset: 330,
      note: "IST read as India Standard Time (UTC+05:30); for Irish or Israel time use Europe/Dublin or Asia/Jerusalem",
    },
  ],
]);

const AMBIGUOUS = new Map<string, string>([
  ["CST", "US Central, China or Cuba: use America/Chicago, Asia/Shanghai or America/Havana"],
  ["CDT", "US Central or Cuba: use America/Chicago or America/Havana"],
  ["BST", "British Summer Time or Bangladesh: use Europe/London or Asia/Dhaka"],
  ["AST", "Atlantic or Arabia: use America/Halifax or Asia/Riyadh"],
  ["ADT", "Atlantic: use America/Halifax"],
  ["SST", "Samoa or Singapore: use Pacific/Pago_Pago or Asia/Singapore"],
  ["PKT", "ambiguous: use Asia/Karachi"],
]);

const OFFSET_RE = /^(?:UTC|GMT)([+-])(\d{1,2})(?::?(\d{2}))?$/i;

function fmtOffset(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

export function resolveZone(raw: string): ResolvedZone {
  const name = raw.trim();
  if (!name) throw new CalcError("time zone is empty");
  if (name.length > 64) throw new CalcError("unknown time zone (name too long)");
  const upper = name.toUpperCase();

  const abbr = ABBREVIATIONS.get(upper);
  if (abbr) {
    return { zone: FixedOffsetZone.instance(abbr.offset), label: upper, offsetMinutes: abbr.offset, note: abbr.note };
  }
  const amb = AMBIGUOUS.get(upper);
  if (amb) throw new CalcError(`time zone abbreviation ${upper} is ambiguous (${amb})`);

  const m = OFFSET_RE.exec(name);
  if (m) {
    const h = Number(m[2]);
    const mi = Number(m[3] ?? 0);
    if (h > 14 || mi > 59) throw new CalcError(`invalid UTC offset "${excerpt(name)}"`);
    const offset = (m[1] === "-" ? -1 : 1) * (h * 60 + mi);
    return { zone: FixedOffsetZone.instance(offset), label: `UTC${fmtOffset(offset)}`, offsetMinutes: offset };
  }

  if (name.includes("/") && IANAZone.isValidZone(name)) {
    const canonical = DateTime.fromMillis(0, { zone: name }).zoneName ?? name;
    return { zone: name, label: canonical };
  }
  if (/^[A-Za-z]{2,5}$/.test(name)) {
    throw new CalcError(
      `unknown time zone abbreviation "${excerpt(name)}"; use an IANA name such as America/New_York, or UTC/GMT/PST/PDT/EST/EDT/CET/CEST/JST/IST`,
    );
  }
  throw new CalcError(`unknown time zone "${excerpt(name)}"; use an IANA name such as America/New_York`);
}

// ---- date parsing -------------------------------------------------------------------------------------------------

type Parsed = { dt: DateTime; hasTime: boolean };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/;

function utcDate(y: number, m: number, d: number): DateTime {
  const dt = DateTime.utc(y, m, d);
  if (!dt.isValid) throw new CalcError(`invalid date ${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  return dt;
}

function nowIn(zone: ResolvedZone): DateTime {
  return DateTime.fromJSDate(getClock().now(), { zone: zone.zone });
}

function todayDate(zone: ResolvedZone): DateTime {
  const n = nowIn(zone);
  return DateTime.utc(n.year, n.month, n.day);
}

function parseDateToken(text: string, zone: ResolvedZone): Parsed {
  const s = text.trim();
  const lower = s.toLowerCase();
  if (lower === "now") return { dt: nowIn(zone), hasTime: true };
  if (lower === "today") return { dt: todayDate(zone), hasTime: false };
  if (lower === "tomorrow") return { dt: todayDate(zone).plus({ days: 1 }), hasTime: false };
  if (lower === "yesterday") return { dt: todayDate(zone).minus({ days: 1 }), hasTime: false };

  let m = ISO_DATE.exec(s);
  if (m) return { dt: utcDate(Number(m[1]), Number(m[2]), Number(m[3])), hasTime: false };

  m = ISO_DATETIME.exec(s);
  if (m) {
    const dt = DateTime.fromObject(
      { year: +m[1]!, month: +m[2]!, day: +m[3]!, hour: +m[4]!, minute: +m[5]!, second: m[6] ? +m[6] : 0 },
      { zone: zone.zone },
    );
    if (!dt.isValid) throw new CalcError(`invalid date-time "${excerpt(s)}"`);
    return { dt, hasTime: true };
  }

  if (s.length <= 60) {
    const ref = nowIn(zone);
    const res = chrono.parse(s, new Date(ref.year, ref.month - 1, ref.day, 12), { forwardDate: false });
    const r = res[0];
    if (r && res.length === 1 && r.index === 0 && r.text.length >= s.length - 1) {
      const y = r.start.get("year");
      const mo = r.start.get("month");
      const d = r.start.get("day");
      if (y && mo && d) {
        if (r.start.isCertain("hour")) {
          const dt = DateTime.fromObject(
            { year: y, month: mo, day: d, hour: r.start.get("hour") ?? 0, minute: r.start.get("minute") ?? 0 },
            { zone: zone.zone },
          );
          if (dt.isValid) return { dt, hasTime: true };
        }
        return { dt: utcDate(y, mo, d), hasTime: false };
      }
    }
  }
  throw new CalcError(`could not understand the date "${excerpt(s, 40)}" (use YYYY-MM-DD, today, tomorrow, or a written date)`);
}

// ---- formatting ---------------------------------------------------------------------------------------------------

const fmtDate = (dt: DateTime) => dt.toFormat("yyyy-MM-dd");
const fmtTime = (dt: DateTime) => dt.toFormat(dt.second ? "yyyy-MM-dd HH:mm:ss" : "yyyy-MM-dd HH:mm");
const weekday = (dt: DateTime) => dt.toFormat("cccc");
const plural = (n: number, unit: string) => `${n} ${Math.abs(n) === 1 ? unit : `${unit}s`}`;

// ---- arithmetic ---------------------------------------------------------------------------------------------------

const UNIT_ALIASES: Record<string, "seconds" | "minutes" | "hours" | "days" | "weeks" | "months" | "years"> = {
  s: "seconds", sec: "seconds", secs: "seconds", second: "seconds", seconds: "seconds",
  min: "minutes", mins: "minutes", minute: "minutes", minutes: "minutes",
  h: "hours", hr: "hours", hrs: "hours", hour: "hours", hours: "hours",
  d: "days", day: "days", days: "days",
  w: "weeks", wk: "weeks", wks: "weeks", week: "weeks", weeks: "weeks",
  mo: "months", month: "months", months: "months",
  y: "years", yr: "years", yrs: "years", year: "years", years: "years",
};
const UNIT_MAP = new Map(Object.entries(UNIT_ALIASES));
const MAX_AMOUNT = 1_000_000;

function parseDuration(text: string): Partial<Record<"seconds" | "minutes" | "hours" | "days" | "weeks" | "months" | "years", number>> {
  const out: Partial<Record<"seconds" | "minutes" | "hours" | "days" | "weeks" | "months" | "years", number>> = {};
  let rest = text.trim();
  let n = 0;
  while (rest) {
    const m = /^(\d+)\s*([A-Za-z]+)\s*(?:,|and)?\s*/i.exec(rest);
    if (!m || ++n > 8) throw new CalcError(`could not understand the duration "${excerpt(text, 40)}" (example: 90 days, 2 weeks 3 days)`);
    const amount = Number(m[1]);
    if (amount > MAX_AMOUNT) throw new CalcError(`duration amount too large (max ${MAX_AMOUNT})`);
    const unit = UNIT_MAP.get(m[2]!.toLowerCase());
    if (!unit) throw new CalcError(`unknown duration unit "${excerpt(m[2]!)}" (use seconds, minutes, hours, days, weeks, months, years)`);
    out[unit] = (out[unit] ?? 0) + amount;
    rest = rest.slice(m[0].length);
  }
  return out;
}

const ADD_PREFIXED = /^(now|today|tomorrow|yesterday|\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?)\s*([+-])\s*(\d.*)$/i;
const ADD_SPACED = /^(.+?)\s+([+-])\s+(\d.*)$/;

function doArithmetic(base: string, op: string, dur: string, zone: ResolvedZone): CalcOutput {
  const start = parseDateToken(base, zone);
  const duration = parseDuration(dur);
  const timeUnits = duration.seconds || duration.minutes || duration.hours;
  let dt = start.dt;
  let hasTime = start.hasTime;
  if (timeUnits && !hasTime) {
    dt = DateTime.fromObject({ year: dt.year, month: dt.month, day: dt.day }, { zone: zone.zone });
    hasTime = true;
  }
  const out = op === "+" ? dt.plus(duration) : dt.minus(duration);
  if (!out.isValid || Math.abs(out.year) > 9999) throw new CalcError("resulting date is out of the supported range");
  const label = zone.label;
  const startText = hasTime ? `${fmtTime(dt)} ${label}` : fmtDate(dt);
  const result = hasTime ? `${fmtTime(out)} ${label}` : fmtDate(out);
  return { result, text: `${startText} ${op} ${dur.trim()} = ${result} (${weekday(out)})` };
}

// ---- differences --------------------------------------------------------------------------------------------------

function ymd(a: DateTime, b: DateTime): { years: number; months: number; days: number } {
  const d = b.diff(a, ["years", "months", "days"]);
  return { years: d.years, months: d.months, days: Math.floor(d.days) };
}

function breakdown(y: number, m: number, d: number): string {
  const parts: string[] = [];
  if (y) parts.push(plural(y, "year"));
  if (m) parts.push(plural(m, "month"));
  if (d || parts.length === 0) parts.push(plural(d, "day"));
  return parts.join(" ");
}

function doDifference(
  unit: string | undefined,
  aText: string,
  bText: string,
  zone: ResolvedZone,
  opts: { until?: boolean } = {},
): CalcOutput {
  const a = parseDateToken(aText, zone);
  const b = parseDateToken(bText, zone);
  const anyTime = a.hasTime || b.hasTime;
  const toInstant = (p: Parsed) =>
    p.hasTime ? p.dt : DateTime.fromObject({ year: p.dt.year, month: p.dt.month, day: p.dt.day }, { zone: zone.zone });
  const A = anyTime ? toInstant(a) : a.dt;
  const B = anyTime ? toInstant(b) : b.dt;
  const sign = B.toMillis() >= A.toMillis() ? 1 : -1;
  const [lo, hi] = sign === 1 ? [A, B] : [B, A];

  const days = anyTime
    ? Number(formatNumber(((B.toMillis() - A.toMillis()) / 86_400_000)))
    : Math.round((B.toMillis() - A.toMillis()) / 86_400_000);
  const parts = ymd(lo, hi);
  const detail = `${breakdown(sign * parts.years, sign * parts.months, sign * parts.days)}`;
  const totalMonths = sign * (parts.years * 12 + parts.months);
  const u = (unit ?? "").toLowerCase().replace(/s$/, "");

  let result: string;
  let extra: string;
  if (u === "week") {
    const w = Math.trunc(days / 7);
    result = plural(w, "week");
    extra = `${plural(days, "day")} (${plural(w, "week")} ${plural(days - w * 7, "day")})`;
  } else if (u === "month") {
    result = plural(totalMonths, "month");
    extra = `${plural(totalMonths, "month")} ${plural(sign * parts.days, "day")}; ${plural(days, "day")} total`;
  } else if (u === "year") {
    result = plural(sign * parts.years, "year");
    extra = `${detail}; ${plural(days, "day")} total`;
  } else {
    result = plural(days, "day");
    extra = `${detail}`;
  }
  const label = (p: Parsed) => (p.hasTime ? `${fmtTime(p.dt)} ${zone.label}` : fmtDate(p.dt));
  const when = sign === -1 && opts.until ? " (already past)" : "";
  const dow = ` [${weekday(B)}]`;
  return { result, text: `${label(a)} -> ${label(b)}${dow}: ${result}; ${extra}${when}` };
}

// ---- time-zone conversion -----------------------------------------------------------------------------------------

const TIME_RE = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?(am|pm)?$/i;

function parseSource(spec: string, def: ResolvedZone): { dt: DateTime; zone: ResolvedZone; notes: string[] } {
  const tokens = spec.replace(/(\d)\s+(am|pm)\b/gi, "$1$2").trim().split(/\s+/).filter(Boolean);
  let dateTok: string | undefined;
  let time: { h: number; m: number; s: number } | undefined;
  let zoneTok: string | undefined;
  let isNow = false;

  for (const tok of tokens) {
    const lower = tok.toLowerCase();
    if (lower === "now") isNow = true;
    else if (lower === "today" || lower === "tomorrow" || lower === "yesterday" || ISO_DATE.test(tok)) dateTok = tok;
    else if (lower === "noon") time = { h: 12, m: 0, s: 0 };
    else if (lower === "midnight") time = { h: 0, m: 0, s: 0 };
    else if (TIME_RE.test(tok) && (tok.includes(":") || /am|pm/i.test(tok))) {
      const m = TIME_RE.exec(tok)!;
      let h = Number(m[1]);
      const mi = Number(m[2] ?? 0);
      const s = Number(m[3] ?? 0);
      const mer = m[4]?.toLowerCase();
      if (mer) {
        if (h < 1 || h > 12) throw new CalcError(`invalid time "${excerpt(tok)}" (12-hour clock needs 1-12)`);
        h = (h % 12) + (mer === "pm" ? 12 : 0);
      }
      if (h > 23 || mi > 59 || s > 59) throw new CalcError(`invalid time "${excerpt(tok)}"`);
      time = { h, m: mi, s };
    } else if (zoneTok === undefined) zoneTok = tok;
    else throw new CalcError(`could not understand "${excerpt(spec, 40)}" (expected e.g. "9am IST", "2026-03-08 14:30 America/New_York")`);
  }

  const zone = zoneTok ? resolveZone(zoneTok) : def;
  const notes: string[] = [];
  if (zone.note) notes.push(zone.note);

  if (isNow) return { dt: nowIn(zone), zone, notes };
  if (!time && !dateTok) throw new CalcError(`no time found in "${excerpt(spec, 40)}" (example: 9am IST, 14:30 UTC)`);

  const base = dateTok ? parseDateToken(dateTok, zone).dt : todayDate(zone);
  const t = time ?? { h: 0, m: 0, s: 0 };
  const dt = DateTime.fromObject(
    { year: base.year, month: base.month, day: base.day, hour: t.h, minute: t.m, second: t.s },
    { zone: zone.zone },
  );
  if (!dt.isValid) throw new CalcError("invalid date or time");
  if (dt.hour !== t.h || dt.minute !== t.m) {
    throw new CalcError(
      `${fmtDate(base)} ${String(t.h).padStart(2, "0")}:${String(t.m).padStart(2, "0")} does not exist in ${zone.label} (skipped by a DST change)`,
    );
  }
  // A repeated wall-clock time (DST fall-back): luxon may pick either occurrence; always use the first.
  const sameWall = (x: DateTime) => x.hour === dt.hour && x.minute === dt.minute && x.day === dt.day;
  const earlier = dt.minus({ hours: 1 });
  let final = dt;
  if (sameWall(earlier)) final = earlier;
  if (final !== dt || sameWall(dt.plus({ hours: 1 }))) {
    notes.push(`this local time is ambiguous (occurs twice in ${zone.label} due to a DST change); the first occurrence was used`);
  }
  return { dt: final, zone, notes };
}

const TZ_SPLIT = /^(.+)\s+(?:in|to|into|->)\s+(\S+)$/i;

function doZoneConversion(spec: string, targetTok: string, def: ResolvedZone): CalcOutput {
  const src = parseSource(spec, def);
  const target = resolveZone(targetTok);
  const out = src.dt.setZone(target.zone);
  const utcDay = (x: DateTime) => DateTime.utc(x.year, x.month, x.day);
  const shift = utcDay(out).diff(utcDay(src.dt), "days").days;
  const result = `${fmtTime(out)} ${target.label}`;
  const dayNote = shift > 0.5 ? " (next day)" : shift < -0.5 ? " (previous day)" : "";
  const abbr = target.offsetMinutes === undefined && out.offsetNameShort ? `${out.offsetNameShort}, ` : "";
  const notes = [...src.notes];
  if (target.note) notes.push(target.note);
  const text =
    `${fmtTime(src.dt)} ${src.zone.label} (UTC${src.dt.toFormat("ZZ")}) = ${result}${dayNote} (${abbr}UTC${out.toFormat("ZZ")})` +
    (notes.length ? `; note: ${notes.join("; ")}` : "");
  return { result, text };
}

// ---- entry point --------------------------------------------------------------------------------------------------

const R_UNTIL = /^(?:how many\s+|number of\s+)?(days?|weeks?|months?|years?)\s+(until|till|since)\s+(.+)$/i;
const R_BETWEEN = /^(?:how many\s+|number of\s+)?(?:(days?|weeks?|months?|years?)\s+)?(?:between|from)\s+(.+?)\s+(?:and|to|until)\s+(.+)$/i;
const R_DIFF = /^(?:the\s+)?diff(?:erence)?\s+between\s+(.+?)\s+and\s+(.+)$/i;
const R_DOW = /^(?:what\s+)?day(?:\s+of(?:\s+the)?\s+week)?(?:\s+(?:is|was|will\s+be|for|of|on))*\s+(.+)$/i;

/** Heuristic used by the tool when `mode` is omitted. */
export function looksLikeDate(expr: string): boolean {
  const s = expr.trim();
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(s)) return true;
  if (/^(?:how many\s+|number of\s+)?(?:days?|weeks?|months?|years?)\s+(?:until|till|since|between|from)\b/i.test(s)) return true;
  if (/^(?:the\s+)?diff(?:erence)?\s+between\b/i.test(s)) return true;
  if (/^(?:what\s+)?day(?:\s+of(?:\s+the)?\s+week)?\s+(?:is|was|will|for|of|on)\b/i.test(s)) return true;
  if (/^(?:now|today|tomorrow|yesterday)\b/i.test(s)) return true;
  if (/[+-]\s*\d+\s*(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b/i.test(s) && /[A-Za-z]{3,}.*\d|\d.*[A-Za-z]{3,}/.test(s) && /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.test(s)) return true;
  if (/\s(?:in|to|into)\s|->/i.test(s)) {
    if (/\d\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b|\b(?:noon|midnight)\b/i.test(s)) return true;
    if (/\b[A-Z][A-Za-z]+\/[A-Za-z_]+/.test(s)) return true;
  }
  return false;
}

export function evaluateDate(input: string, opts: { timezone?: string } = {}): CalcOutput {
  const src = input.replace(/\s+/g, " ").trim();
  if (!src) throw new CalcError("empty expression");
  if (src.length > 200) throw new CalcError("expression is too long for a date calculation");
  const zone = resolveZone(opts.timezone?.trim() || "UTC");

  let m = R_UNTIL.exec(src);
  if (m) {
    const since = m[2]!.toLowerCase() === "since";
    return since
      ? doDifference(m[1], m[3]!, "today", zone)
      : doDifference(m[1], "today", m[3]!, zone, { until: true });
  }
  m = R_BETWEEN.exec(src);
  if (m) return doDifference(m[1], m[2]!, m[3]!, zone);
  m = R_DIFF.exec(src);
  if (m) return doDifference(undefined, m[1]!, m[2]!, zone);

  m = R_DOW.exec(src);
  if (m) {
    const p = parseDateToken(m[1]!, zone);
    return { result: weekday(p.dt), text: `${fmtDate(p.dt)} is a ${weekday(p.dt)}` };
  }

  m = ADD_PREFIXED.exec(src) ?? ADD_SPACED.exec(src);
  if (m) return doArithmetic(m[1]!, m[2]!, m[3]!, zone);

  m = TZ_SPLIT.exec(src);
  if (m) return doZoneConversion(m[1]!, m[2]!, zone);

  const p = parseDateToken(src, zone);
  if (p.hasTime) return { result: `${fmtTime(p.dt)} ${zone.label}`, text: `${fmtTime(p.dt)} ${zone.label} (${weekday(p.dt)})` };
  return { result: fmtDate(p.dt), text: `${fmtDate(p.dt)} is a ${weekday(p.dt)}` };
}
