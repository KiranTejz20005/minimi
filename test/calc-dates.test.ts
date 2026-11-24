import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FixedClock, SystemClock, setClock } from "../src/clock.js";
import { evaluateDate, resolveZone } from "../src/tools/calc/dates.js";
import { CalcError } from "../src/tools/calc/errors.js";

// Tuesday 2026-11-24 10:00 UTC (15:30 in India)
beforeEach(() => setClock(new FixedClock(new Date("2026-11-24T10:00:00.000Z"))));
afterEach(() => setClock(new SystemClock()));

const d = (e: string, tz?: string) => evaluateDate(e, { timezone: tz });

describe("date arithmetic", () => {
  it("adds days", () => {
    const r = d("2026-11-24 + 90 days");
    expect(r.result).toBe("2027-02-22");
    expect(r.text).toContain("Monday");
  });
  it("subtracts days", () => expect(d("2026-11-24 - 24 days").result).toBe("2026-10-31"));
  it("no spaces around operator", () => expect(d("2026-11-24+1 day").result).toBe("2026-11-25"));
  it("weeks, months, years", () => {
    expect(d("2026-11-24 + 2 weeks").result).toBe("2026-12-08");
    expect(d("2026-11-24 + 3 months").result).toBe("2027-02-24");
    expect(d("2026-11-24 + 1 year").result).toBe("2027-11-24");
  });
  it("month-end clamps", () => expect(d("2026-01-31 + 1 month").result).toBe("2026-02-28"));
  it("leap day", () => expect(d("2028-02-28 + 1 day").result).toBe("2028-02-29"));
  it("combined units", () => expect(d("2026-11-24 + 1 month 2 days").result).toBe("2026-12-26"));
  it("today / tomorrow use the app clock", () => {
    expect(d("today + 1 day").result).toBe("2026-11-25");
    expect(d("tomorrow").result).toBe("2026-11-25");
    expect(d("yesterday - 1 week").result).toBe("2026-11-16");
  });
  it("now + hours yields a datetime", () => {
    expect(d("now + 3 hours").result).toBe("2026-11-24 13:00 UTC");
  });
  it("now respects the timezone parameter", () => {
    expect(d("now + 0 hours", "Asia/Kolkata").result).toBe("2026-11-24 15:30 Asia/Kolkata");
    expect(d("today", "Pacific/Kiritimati").result).toBe("2026-11-25");
  });
  it("natural-language dates via chrono", () => {
    expect(d("December 25, 2026 + 1 day").result).toBe("2026-12-26");
  });
  it("rejects absurd magnitudes and bad dates", () => {
    expect(() => d("2026-11-24 + 99999999 days")).toThrow(CalcError);
    expect(() => d("2026-02-30 + 1 day")).toThrow(CalcError);
    expect(() => d("2026-11-24 + 3 fortnights")).toThrow(/unit/i);
  });
});

describe("date differences", () => {
  it("days until", () => {
    const r = d("days until 2026-12-25");
    expect(r.result).toBe("31 days");
    expect(r.text).toContain("Friday");
  });
  it("days since / past targets", () => {
    expect(d("days since 2026-11-01").result).toBe("23 days");
    expect(d("days until 2026-11-20").result).toBe("-4 days");
  });
  it("how many days until", () => expect(d("how many days until 2026-12-25").result).toBe("31 days"));
  it("days between", () => expect(d("days between 2026-01-01 and 2026-12-31").result).toBe("364 days"));
  it("weeks between", () => {
    const r = d("weeks between 2026-01-01 and 2026-03-05");
    expect(r.result).toBe("9 weeks");
    expect(r.text).toContain("63 days");
  });
  it("months between", () => {
    const r = d("months between 2026-01-15 and 2026-04-20");
    expect(r.result).toBe("3 months");
    expect(r.text).toContain("5 days");
  });
  it("difference between", () => {
    const r = d("difference between 2024-02-28 and 2026-03-01");
    expect(r.text).toContain("2 years");
    expect(r.text).toContain("732 days");
  });
  it("reverse order is negative", () => expect(d("days between 2026-12-31 and 2026-01-01").result).toBe("-364 days"));
  it("timezone-aware today", () => {
    // 10:00Z is already 2026-11-25 in Kiritimati (+14)
    expect(d("days until 2026-11-30", "Pacific/Kiritimati").result).toBe("5 days");
  });
});

describe("day of week", () => {
  it("day of week", () => {
    expect(d("day of week 2026-12-25").result).toBe("Friday");
    expect(d("what day is 2026-07-04").result).toBe("Saturday");
    expect(d("what day of the week was 2000-01-01").result).toBe("Saturday");
  });
  it("a bare date reports its weekday", () => expect(d("2026-11-24").text).toContain("Tuesday"));
});

describe("time zone conversion", () => {
  it("9am IST in America/New_York (IST = India)", () => {
    const r = d("9am IST in America/New_York");
    expect(r.result).toBe("2026-11-23 22:30 America/New_York");
    expect(r.text).toMatch(/India/);
    expect(r.text).toMatch(/previous day|2026-11-23/);
  });
  it("explicit date and zones", () => {
    expect(d("2026-07-01 12:00 UTC in America/New_York").result).toBe("2026-07-01 08:00 America/New_York");
    expect(d("2026-01-01 12:00 UTC to America/New_York").result).toBe("2026-01-01 07:00 America/New_York");
  });
  it("pm / 24h / noon / midnight", () => {
    expect(d("2026-06-01 3:30pm UTC in Asia/Tokyo").result).toBe("2026-06-02 00:30 Asia/Tokyo");
    expect(d("2026-06-01 14:30 JST in UTC").result).toBe("2026-06-01 05:30 UTC");
    expect(d("2026-06-01 noon UTC in CET").result).toBe("2026-06-01 13:00 CET");
    expect(d("2026-06-01 12am UTC in UTC").result).toBe("2026-06-01 00:00 UTC");
    expect(d("2026-06-01 9 am UTC in UTC").result).toBe("2026-06-01 09:00 UTC");
  });
  it("abbreviations are fixed offsets", () => {
    expect(d("2026-07-01 12:00 PST in UTC").result).toBe("2026-07-01 20:00 UTC");
    expect(d("2026-07-01 12:00 PDT in UTC").result).toBe("2026-07-01 19:00 UTC");
    expect(d("2026-01-01 12:00 EST in GMT").result).toBe("2026-01-01 17:00 GMT");
    expect(d("2026-07-01 12:00 EDT in UTC").result).toBe("2026-07-01 16:00 UTC");
  });
  it("UTC offsets", () => {
    expect(d("2026-06-01 12:00 UTC+5:30 in UTC").result).toBe("2026-06-01 06:30 UTC");
  });
  it("source zone defaults to the timezone parameter, then UTC", () => {
    expect(d("2026-06-01 09:00 in UTC", "Asia/Kolkata").result).toBe("2026-06-01 03:30 UTC");
    expect(d("2026-06-01 09:00 in Asia/Kolkata").result).toBe("2026-06-01 14:30 Asia/Kolkata");
  });
  it("now in a zone uses the app clock", () => {
    expect(d("now in Asia/Tokyo").result).toBe("2026-11-24 19:00 Asia/Tokyo");
  });
  it("spring-forward gap is rejected", () => {
    expect(() => d("2026-03-08 02:30 America/New_York in UTC")).toThrow(/does not exist|DST|skipped/i);
  });
  it("fall-back overlap is flagged and resolves to the first occurrence", () => {
    const r = d("2026-11-01 01:30 America/New_York in UTC");
    expect(r.result).toBe("2026-11-01 05:30 UTC");
    expect(r.text).toMatch(/ambiguous|twice/i);
  });
  it("across the DST boundary uses the right offsets", () => {
    expect(d("2026-03-08 12:00 America/New_York in UTC").result).toBe("2026-03-08 16:00 UTC");
    expect(d("2026-03-07 12:00 America/New_York in UTC").result).toBe("2026-03-07 17:00 UTC");
  });
  it("invalid / ambiguous zones are rejected", () => {
    expect(() => d("9am UTC in Mars/Olympus")).toThrow(/time zone/i);
    expect(() => d("9am CST in UTC")).toThrow(/ambiguous/i);
    expect(() => d("9am UTC in BST")).toThrow(/ambiguous/i);
    expect(() => d("9am XYZ in UTC")).toThrow(/time zone/i);
    expect(() => d("25:00 UTC in UTC")).toThrow(CalcError);
    expect(() => d("13pm UTC in UTC")).toThrow(CalcError);
  });
});

describe("resolveZone", () => {
  it("documents the IST choice", () => {
    const z = resolveZone("IST");
    expect(z.label).toBe("IST");
    expect(z.note).toMatch(/India/);
    expect(z.offsetMinutes).toBe(330);
  });
  it("accepts IANA names", () => expect(resolveZone("Europe/London").label).toBe("Europe/London"));
  it("rejects junk", () => {
    expect(() => resolveZone("not a zone")).toThrow(CalcError);
    expect(() => resolveZone("")).toThrow(CalcError);
  });
});
