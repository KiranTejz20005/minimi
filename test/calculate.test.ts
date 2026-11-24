import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FixedClock, SystemClock, setClock } from "../src/clock.js";
import { calculateTool } from "../src/tools/calculate.js";
import { executeToolCall, getTool, registerTool, unregisterTool } from "../src/tools/registry.js";
import { ToolInputError, type ToolContext } from "../src/tools/types.js";

const ctx = { counts: {} } as unknown as ToolContext;
const freshCtx = () => ({ counts: {} }) as unknown as ToolContext;

beforeEach(() => setClock(new FixedClock(new Date("2026-11-24T10:00:00.000Z"))));
afterEach(() => setClock(new SystemClock()));

async function call(raw: unknown) {
  return calculateTool.run(calculateTool.validate(raw), ctx);
}

describe("calculateTool definition", () => {
  it("has the expected metadata", () => {
    expect(calculateTool.name).toBe("calculate");
    expect(calculateTool.schema.name).toBe("calculate");
    expect(calculateTool.effect).toBe("read");
    expect(calculateTool.approval).toBeUndefined();
    expect(calculateTool.actionLabel).toBe("Calculate");
    expect(calculateTool.timeoutMs).toBeLessThanOrEqual(2000);
    const max = calculateTool.maxPerTurn;
    expect(typeof max === "function" ? max() : max).toBeGreaterThanOrEqual(8);
  });

  it("schema tells the model when to use it", () => {
    const desc = calculateTool.schema.description ?? "";
    for (const w of [/arithmetic/i, /percent/i, /unit/i, /date/i, /time.?zone/i, /web_search/, /currency/i]) {
      expect(desc).toMatch(w);
    }
    expect(desc).toMatch(/not.*(currency|exchange)|currency.*not/i);
    const schema = calculateTool.schema.input_schema as { required?: string[]; additionalProperties?: boolean };
    expect(schema.required).toEqual(["expression"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("label / dedupeKey", () => {
    expect(calculateTool.label!({ expression: "  2 + 2  " })).toBe("2 + 2");
    expect(calculateTool.label!({})).toBe("calculate");
    expect(calculateTool.label!(null)).toBe("calculate");
    expect(calculateTool.label!({ expression: "x".repeat(900) }).length).toBeLessThanOrEqual(80);
    const a = calculateTool.dedupeKey!(calculateTool.validate({ expression: "2 +  2" }));
    const b = calculateTool.dedupeKey!(calculateTool.validate({ expression: " 2 + 2 " }));
    expect(a).toBe(b);
    expect(calculateTool.dedupeKey!(calculateTool.validate({ expression: "5 KM to Miles" }))).toBe(
      calculateTool.dedupeKey!(calculateTool.validate({ expression: "5 km to miles" })),
    );
  });
});

describe("validate", () => {
  it("accepts valid input", () => {
    expect(calculateTool.validate({ expression: "1+1" })).toMatchObject({ expression: "1+1" });
    expect(calculateTool.validate({ expression: "1+1", mode: "math", timezone: "Asia/Tokyo" })).toBeTruthy();
  });
  it.each([
    [null],
    ["1+1"],
    [{}],
    [{ expression: 5 }],
    [{ expression: "" }],
    [{ expression: "   " }],
    [{ expression: "1+1", extra: 1 }],
    [{ expression: "1+1", mode: "eval" }],
    [{ expression: "x".repeat(501) }],
    [{ expression: "1+1", timezone: "Mars/Base" }],
    [{ expression: "1+1", timezone: 5 }],
  ])("rejects %j", (raw) => {
    expect(() => calculateTool.validate(raw)).toThrow(ToolInputError);
  });
});

describe("run", () => {
  it("math", async () => {
    const r = await call({ expression: "15% of 240" });
    expect(r.error).toBeUndefined();
    expect(r.content).toBe(
      '<calculation expression="15% of 240" kind="math" result="36">15% of 240 = 36</calculation>',
    );
  });
  it("escapes the echoed expression", async () => {
    const r = await call({ expression: 'sqrt("<x>")' });
    expect(r.error).toBeTruthy();
    expect(r.content).toContain("&quot;&lt;x&gt;&quot;");
    expect(r.content).not.toContain("<x>");
    expect(r.content).toMatch(/^<calculation expression="[^"]*" error="[^"]*"\/>$/);
  });
  it("convert (auto-detected and explicit)", async () => {
    const a = await call({ expression: "5 miles to km" });
    expect(a.content).toContain('kind="convert"');
    expect(a.content).toContain("8.04672");
    const b = await call({ expression: "72 F to C", mode: "convert" });
    expect(b.content).toContain("22.2222222222");
  });
  it("date (auto-detected and explicit) uses the app clock", async () => {
    const a = await call({ expression: "2026-11-24 + 90 days" });
    expect(a.content).toContain('kind="date"');
    expect(a.content).toContain("2027-02-22");
    const b = await call({ expression: "days until 2026-12-25" });
    expect(b.content).toContain("31 days");
    const c = await call({ expression: "9am IST in America/New_York" });
    expect(c.content).toContain("22:30");
    const e = await call({ expression: "today + 1 day", mode: "date", timezone: "Pacific/Kiritimati" });
    expect(e.content).toContain("2026-11-26");
  });
  it("mode override produces mode-specific errors", async () => {
    const r = await call({ expression: "5 miles to km", mode: "math" });
    expect(r.error).toBeTruthy();
  });
  it("errors are reported with ToolResult.error and an error element", async () => {
    for (const expression of ["1/0", "9**9**9", "process.exit()", "5 miles to kg", "100 USD to EUR", "2026-13-45 + 1 day"]) {
      const r = await call({ expression });
      expect(r.error, expression).toBeTruthy();
      expect(r.content).toContain("error=");
      expect(r.content).toContain("<calculation");
    }
  });
  it("never executes code", async () => {
    const r = await call({ expression: 'constructor.constructor("return process")()' });
    expect(r.error).toBeTruthy();
  });
  it("errorContent / declined produce well-formed elements", () => {
    expect(calculateTool.errorContent!('a"b', "bad <x>")).toBe(
      '<calculation expression="a&quot;b" error="bad &lt;x&gt;"/>',
    );
    expect(calculateTool.declined!("1+1")).toContain("<calculation");
  });
});

describe("through the registry dispatcher", () => {
  const preRegistered = !!getTool("calculate");
  beforeEach(() => {
    if (!getTool("calculate")) registerTool(calculateTool);
  });
  afterEach(() => {
    if (!preRegistered) unregisterTool("calculate");
  });

  it("executes a call", async () => {
    const res = await executeToolCall({ id: "t1", name: "calculate", input: { expression: "2 ^ 10" } }, freshCtx(), true);
    expect(res.error).toBeUndefined();
    expect(res.content).toContain('result="1024"');
    expect(res.label).toBe("2 ^ 10");
  });
  it("turns bad input into a readable tool error", async () => {
    const res = await executeToolCall({ id: "t2", name: "calculate", input: { expression: "" } }, freshCtx(), true);
    expect(res.error).toBeTruthy();
    expect(res.content).toContain("<calculation");
  });
  it("reports calc errors without throwing", async () => {
    const res = await executeToolCall({ id: "t3", name: "calculate", input: { expression: "1/0" } }, freshCtx(), true);
    expect(res.error).toMatch(/division by zero/i);
  });
  it("dedupes whitespace/case variants within a turn", async () => {
    const c = freshCtx();
    const a = await executeToolCall({ id: "a", name: "calculate", input: { expression: "2+2" } }, c, true);
    const b = await executeToolCall({ id: "b", name: "calculate", input: { expression: " 2+2 " } }, c, true);
    expect(a.duplicate).toBeFalsy();
    expect(b.duplicate).toBe(true);
    expect(b.content).toBe(a.content);
  });
  it("enforces the per-turn limit", async () => {
    const c = freshCtx();
    let last;
    for (let i = 0; i < 40; i++) {
      last = await executeToolCall({ id: `x${i}`, name: "calculate", input: { expression: `${i}+1` } }, c, true);
      if (last.error) break;
    }
    expect(last!.error).toBeTruthy();
  });
});
