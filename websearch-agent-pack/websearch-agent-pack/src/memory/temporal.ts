import * as chrono from "chrono-node";
import { DateTime } from "luxon";
import type { Clock } from "../clock.js";

export type DateWindow = { start: string; end: string };
export type TimeRef = {
  text: string;
  kind: "point" | "range" | "since";
  candidates: DateWindow[];
};

export function resolveTimeRefs(
  message: string,
  clock: Clock,
  tz: string,
): TimeRef[] {
  const now = DateTime.fromJSDate(clock.now(), { zone: tz });
  const refs: TimeRef[] = [];
  const parsed = chrono.parse(message, clock.now(), {
    forwardDate: false,
  });

  const lower = message.toLowerCase();

  if (/\byesterday\b/.test(lower)) {
    refs.push(pointRef("yesterday", [dayWindow(now.minus({ days: 1 }))]));
  }
  if (/\btoday\b/.test(lower) || /\bthis morning\b/.test(lower)) {
    refs.push(pointRef("today", [dayWindow(now)]));
  }

  const lastWeekday = lower.match(/\blast\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (lastWeekday) {
    const wd = weekdayIndex(lastWeekday[1]);
    refs.push(
      pointRef(lastWeekday[0], lastWeekdayCandidates(now, wd)),
    );
  }

  const bareWeekday = lower.match(
    /\b(on\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
  );
  if (bareWeekday && !lastWeekday) {
    const wd = weekdayIndex(bareWeekday[2]!);
    refs.push(pointRef(bareWeekday[0]!, bareWeekdayCandidates(now, wd)));
  }

  const daysAgo = lower.match(/\b(\d+)\s+days?\s+ago\b/);
  if (daysAgo) {
    const n = parseInt(daysAgo[1]!, 10);
    refs.push(pointRef(daysAgo[0]!, [dayWindow(now.minus({ days: n }))]));
  }

  const weeksAgo = lower.match(/\b(\d+)\s+weeks?\s+ago\b/);
  if (weeksAgo) {
    const n = parseInt(weeksAgo[1]!, 10);
    const center = now.minus({ weeks: n });
    refs.push(
      pointRef(weeksAgo[0]!, [
        {
          start: center.minus({ days: 1 }).toFormat("yyyy-MM-dd"),
          end: center.plus({ days: 1 }).toFormat("yyyy-MM-dd"),
        },
      ]),
    );
  }

  const sinceMatch = lower.match(/\bsince\s+(.+?)(?:\?|$|,|\s+has|\s+any)/);
  if (sinceMatch) {
    const anchor = resolveTimeRefs(sinceMatch[1]!, clock, tz)[0];
    if (anchor?.candidates[0]) {
      refs.push({
        text: sinceMatch[0],
        kind: "since",
        candidates: [
          { start: anchor.candidates[0].start, end: now.toFormat("yyyy-MM-dd") },
        ],
      });
    }
  }

  if (/\blast week\b/.test(lower)) {
    const end = now.startOf("week").minus({ days: 1 });
    const start = end.startOf("week");
    refs.push({
      text: "last week",
      kind: "range",
      candidates: [
        {
          start: start.toFormat("yyyy-MM-dd"),
          end: end.toFormat("yyyy-MM-dd"),
        },
      ],
    });
  }

  for (const r of parsed) {
    const start = DateTime.fromJSDate(r.start.date(), { zone: tz });
    if (r.start.isCertain("year")) {
      refs.push(
        pointRef(r.text, [dayWindow(start)]),
      );
    } else {
      let d = start.set({ year: now.year });
      if (d > now) d = d.set({ year: now.year - 1 });
      refs.push(pointRef(r.text, [dayWindow(d)]));
    }
  }

  const seen = new Set<string>();
  return refs.filter((r) => {
    const key = r.text + JSON.stringify(r.candidates);
    if (seen.has(key)) return false;
    seen.add(key);
    return r.candidates.length > 0;
  });
}

function pointRef(text: string, candidates: DateWindow[]): TimeRef {
  return { text, kind: "point", candidates };
}

function dayWindow(dt: DateTime): DateWindow {
  const d = dt.toFormat("yyyy-MM-dd");
  return { start: d, end: d };
}

function weekdayIndex(name: string): number {
  const map: Record<string, number> = {
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
    sunday: 7,
  };
  return map[name] ?? 1;
}

function lastWeekdayCandidates(now: DateTime, targetIso: number): DateWindow[] {
  const candidates: DateWindow[] = [];
  let d = now.startOf("day");
  for (let i = 0; i < 14; i++) {
    d = d.minus({ days: 1 });
    if (d.weekday === targetIso) {
      candidates.push(dayWindow(d));
      if (candidates.length >= 2) break;
    }
  }
  if (now.weekday === targetIso) {
    const today = dayWindow(now);
    const prev = dayWindow(now.minus({ days: 7 }));
    return [today, prev];
  }
  return candidates.length ? candidates : [dayWindow(now.minus({ days: 7 }))];
}

function bareWeekdayCandidates(now: DateTime, targetIso: number): DateWindow[] {
  if (now.weekday === targetIso) {
    return [dayWindow(now), dayWindow(now.minus({ days: 7 }))];
  }
  let d = now.startOf("day");
  for (let i = 0; i < 7; i++) {
    d = d.minus({ days: 1 });
    if (d.weekday === targetIso) return [dayWindow(d)];
  }
  return [dayWindow(now.minus({ days: 7 }))];
}

export function formatDisplayDate(ymd: string, tz: string): string {
  const dt = DateTime.fromISO(ymd, { zone: tz });
  return dt.isValid ? dt.toFormat("ccc d LLL yyyy") : ymd;
}

export function stripDateExpressions(message: string): string {
  const refs = chrono.parse(message);
  let out = message;
  for (const r of refs) {
    out = out.replace(r.text, " ");
  }
  return out.replace(/\b(yesterday|today|last week|last \w+day)\b/gi, " ");
}

export function resolveTemporal(message: string, now: Date, tz: string): TimeRef[] {
  return resolveTimeRefs(message, { now: () => now }, tz);
}
