import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FixedClock } from "../src/clock.js";
import { loadEvalFixtures } from "../scripts/eval-fixtures.js";
import { resolveTimeRefs } from "../src/memory/temporal.js";
import { recalledTurnIds, retrieve } from "../src/memory/retrieve.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tz = "Asia/Kolkata";
const frozen = new Date("2026-11-10T13:30:00.000Z");

let db: DatabaseSync;
let ids: Record<string, string>;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(root, "schema.sql"), "utf8"));
  ids = loadEvalFixtures(db);
});

describe("retrieve", () => {
  it("yesterday lists F1 and F2", () => {
    const clock = new FixedClock(frozen);
    const q = "What did I ask you yesterday?";
    const refs = resolveTimeRefs(q, clock, tz);
    const r = retrieve(db, q, refs, tz);
    const got = recalledTurnIds(r);
    expect(got).toContain(ids.F1);
    expect(got).toContain(ids.F2);
  });

  it("last Wednesday postgres widens to F4 not F3", () => {
    const clock = new FixedClock(frozen);
    const q =
      "Last Wednesday I asked about Postgres hosting. Has any pricing changed?";
    const refs = resolveTimeRefs(q, clock, tz);
    const r = retrieve(db, q, refs, tz);
    expect(recalledTurnIds(r)).toContain(ids.F4);
    expect(recalledTurnIds(r)).not.toContain(ids.F3);
  });

  it("last Tuesday postgres hits F4 not F7", () => {
    const clock = new FixedClock(frozen);
    const q =
      "Last Tuesday I asked you about Postgres hosting. Has any pricing changed?";
    const refs = resolveTimeRefs(q, clock, tz);
    const r = retrieve(db, q, refs, tz);
    const got = recalledTurnIds(r);
    expect(got).toContain(ids.F4);
    expect(got).not.toContain(ids.F7);
  });

  it("Friday email marketing is miss", () => {
    const clock = new FixedClock(frozen);
    const q =
      "On Friday we compared 3 email marketing tools. Any price changes?";
    const refs = resolveTimeRefs(q, clock, tz);
    const r = retrieve(db, q, refs, tz);
    expect(r.kind).toBe("miss");
  });

  it("9 October baggage recalls F8 despite loose topic match", () => {
    const clock = new FixedClock(frozen);
    const q = "On 9 October I asked about baggage rules — still the same?";
    const refs = resolveTimeRefs(q, clock, tz);
    const r = retrieve(db, q, refs, tz);
    expect(recalledTurnIds(r)).toContain(ids.F8);
  });

  it("3 November lists F4 and F5", () => {
    const clock = new FixedClock(frozen);
    const q = "What did I ask on 3 November?";
    const refs = resolveTimeRefs(q, clock, tz);
    const got = recalledTurnIds(retrieve(db, q, refs, tz));
    expect(got).toContain(ids.F4);
    expect(got).toContain(ids.F5);
  });

  it("last week recalls F3 through F6", () => {
    const clock = new FixedClock(frozen);
    const q = "What did we talk about last week?";
    const refs = resolveTimeRefs(q, clock, tz);
    const got = recalledTurnIds(retrieve(db, q, refs, tz));
    expect(got).toContain(ids.F3);
    expect(got).toContain(ids.F4);
    expect(got).toContain(ids.F5);
    expect(got).toContain(ids.F6);
  });

  it("CRM tools again recalls F1", () => {
    const clock = new FixedClock(frozen);
    const q = "What were those CRM tools again?";
    const refs = resolveTimeRefs(q, clock, tz);
    const r = retrieve(db, q, refs, tz);
    expect(recalledTurnIds(r)).toContain(ids.F1);
  });
});
