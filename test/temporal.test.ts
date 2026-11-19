import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { FixedClock } from "../src/clock.js";
import { resolveTimeRefs, resolveTemporal } from "../src/memory/temporal.js";

const tz = "Asia/Kolkata";

function clockAt(ymd: string, hm = "19:00") {
  const dt = DateTime.fromISO(`${ymd}T${hm}`, { zone: tz });
  return new FixedClock(dt.toJSDate());
}

function starts(refs: ReturnType<typeof resolveTimeRefs>): string[] {
  return refs.flatMap((r) => r.candidates.map((c) => c.start));
}

describe("resolveTimeRefs", () => {
  it("yesterday on Tue 10 Nov → Mon 9 Nov", () => {
    const refs = resolveTimeRefs(
      "What did I ask you yesterday?",
      clockAt("2026-11-10"),
      tz,
    );
    expect(starts(refs)).toContain("2026-11-09");
  });

  it("today resolves to same local date", () => {
    const refs = resolveTimeRefs(
      "What is on the agenda today?",
      clockAt("2026-11-10"),
      tz,
    );
    expect(starts(refs)).toContain("2026-11-10");
  });

  it("Monday reference resolves to a Monday window", () => {
    const refs = resolveTimeRefs(
      "On Monday we shortlisted tools",
      clockAt("2026-11-10"),
      tz,
    );
    expect(starts(refs)).toContain("2026-11-09");
  });

  it("Monday on Tuesday resolves near prior Monday", () => {
    const refs = resolveTimeRefs("On Monday we talked", clockAt("2026-11-11"), tz);
    expect(starts(refs).some((d) => d.startsWith("2026-11-"))).toBe(true);
  });

  it("last Tuesday on Wed 11 Nov includes recent Tuesdays", () => {
    const refs = resolveTimeRefs(
      "Last Tuesday I asked about Postgres",
      clockAt("2026-11-11"),
      tz,
    );
    expect(starts(refs)).toContain("2026-11-10");
    expect(starts(refs)).toContain("2026-11-03");
  });

  it("last week is Mon–Sun of previous week", () => {
    const refs = resolveTimeRefs(
      "What did we discuss last week?",
      clockAt("2026-11-10"),
      tz,
    );
    const win = refs.find((r) => r.kind === "range")?.candidates[0];
    expect(win).toEqual({ start: "2026-11-02", end: "2026-11-08" });
  });

  it("3 November without year → 2026-11-03 when now is Nov 10", () => {
    const refs = resolveTimeRefs(
      "On 3 November what did I ask?",
      clockAt("2026-11-10"),
      tz,
    );
    expect(starts(refs)).toContain("2026-11-03");
  });

  it("3 November when now is December still picks Nov 3 same year", () => {
    const refs = resolveTimeRefs("On 3 November", clockAt("2026-12-05"), tz);
    expect(starts(refs)).toContain("2026-11-03");
  });

  it("2 days ago", () => {
    const refs = resolveTimeRefs("2 days ago I asked", clockAt("2026-11-10"), tz);
    expect(starts(refs)).toContain("2026-11-08");
  });

  it("since Monday uses since kind", () => {
    const refs = resolveTimeRefs(
      "Has pricing changed since Monday?",
      clockAt("2026-11-12"),
      tz,
    );
    expect(refs.some((r) => r.kind === "since")).toBe(true);
  });

  it("unrelated message returns empty", () => {
    const refs = resolveTimeRefs("Explain MVCC", clockAt("2026-11-10"), tz);
    expect(refs.length).toBe(0);
  });

  it("resolveTemporal wrapper matches clock API", () => {
    const c = clockAt("2026-11-10");
    const a = resolveTimeRefs("yesterday", c, tz);
    const b = resolveTemporal("yesterday", c.now(), tz);
    expect(a).toEqual(b);
  });

  /** Plan §4.1 — table-driven (frozen clock, Asia/Kolkata) */
  const table: {
    name: string;
    now: string;
    query: string;
    includes: string[];
    kind?: string;
  }[] = [
    {
      name: "PRD last Tuesday on Tue 10 Nov → 3 Nov",
      now: "2026-11-10",
      query: "Last Tuesday I asked about Postgres",
      includes: ["2026-11-03"],
    },
    {
      name: "this morning",
      now: "2026-11-10",
      query: "What did we cover this morning?",
      includes: ["2026-11-10"],
    },
    {
      name: "On Friday",
      now: "2026-11-10",
      query: "On Friday we compared tools",
      includes: ["2026-11-06"],
    },
    {
      name: "9 October absolute",
      now: "2026-11-10",
      query: "On 9 October I asked about baggage",
      includes: ["2026-10-09"],
    },
    {
      name: "Nov 3 shorthand",
      now: "2026-11-10",
      query: "What on Nov 3?",
      includes: ["2026-11-03"],
    },
    {
      name: "1 week ago",
      now: "2026-11-10",
      query: "1 week ago we talked",
      includes: ["2026-11-02", "2026-11-03"],
    },
    {
      name: "last Thursday",
      now: "2026-11-10",
      query: "last Thursday pricing",
      includes: ["2026-11-05"],
    },
    {
      name: "last Monday on Monday",
      now: "2026-11-09",
      query: "last Monday CRM",
      includes: ["2026-11-09", "2026-11-02"],
    },
    {
      name: "3 days ago",
      now: "2026-11-10",
      query: "3 days ago I asked",
      includes: ["2026-11-07"],
    },
    {
      name: "4 November",
      now: "2026-11-10",
      query: "On 4 November laptop",
      includes: ["2026-11-04"],
    },
    {
      name: "October year rollover",
      now: "2026-01-15",
      query: "On 3 November",
      includes: ["2025-11-03"],
    },
    {
      name: "bare Tuesday when today is Tuesday",
      now: "2026-11-10",
      query: "on Tuesday we discussed hosting",
      includes: ["2026-11-10", "2026-11-03"],
    },
    {
      name: "last Saturday",
      now: "2026-11-10",
      query: "last Saturday",
      includes: ["2026-11-07"],
    },
    {
      name: "last Sunday",
      now: "2026-11-10",
      query: "last Sunday",
      includes: ["2026-11-08"],
    },
    {
      name: "2 weeks ago window",
      now: "2026-11-10",
      query: "2 weeks ago vector DB",
      includes: ["2026-10-26", "2026-10-27"],
    },
    {
      name: "since Tuesday anchor",
      now: "2026-11-10",
      query: "Any changes since Tuesday?",
      includes: [],
      kind: "since",
    },
    {
      name: "last Wednesday candidates",
      now: "2026-11-10",
      query: "Last Wednesday postgres",
      includes: ["2026-11-04"],
    },
    {
      name: "yesterday on Wed 11",
      now: "2026-11-11",
      query: "yesterday",
      includes: ["2026-11-10"],
    },
    {
      name: "today on Wed 11",
      now: "2026-11-11",
      query: "today",
      includes: ["2026-11-11"],
    },
  ];

  it.each(table)("$name", ({ now, query, includes, kind }) => {
    const refs = resolveTimeRefs(query, clockAt(now), tz);
    if (kind === "since") {
      expect(refs.some((r) => r.kind === "since")).toBe(true);
      return;
    }
  if (includes.length === 0) return;
    const got = starts(refs);
    for (const d of includes) {
      expect(got).toContain(d);
    }
  });
});
