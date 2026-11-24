import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { TurnCitationRegistry } from "../src/search/tool.js";
import {
  AGENT_TOOLS,
  ToolInputError,
  executeToolCall,
  getTool,
  isTransientError,
  labelForCall,
  listTools,
  registerTool,
  stableStringify,
  unregisterTool,
  type ToolContext,
  type ToolDefinition,
} from "../src/tools/registry.js";

const registered: string[] = [];

function fake(name: string, over: Partial<ToolDefinition<{ q: string }>> = {}): ToolDefinition<{ q: string }> {
  const def: ToolDefinition<{ q: string }> = {
    name,
    schema: { name, description: "fake", input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
    validate: (raw) => {
      const p = z.object({ q: z.string().min(1) }).safeParse(raw);
      if (!p.success) throw new ToolInputError(`invalid ${name} input`);
      return p.data;
    },
    run: async (input) => ({ content: `<r>${input.q}</r>` }),
    ...over,
  };
  registerTool(def as ToolDefinition);
  registered.push(name);
  return def;
}

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { db: {} as never, registry: new TurnCitationRegistry(), counts: {}, ...over };
}

const call = (name: string, input: unknown, id = "c1") => ({ id, name, input });

afterEach(() => {
  while (registered.length) unregisterTool(registered.pop()!);
});

describe("registration + schema generation", () => {
  it("registers the four built-in tools and exposes their schemas to the model", () => {
    for (const n of ["web_search", "fetch_url", "memory_search", "lookup_claims"]) {
      expect(getTool(n)).toBeDefined();
      expect(AGENT_TOOLS.some((t) => t.name === n)).toBe(true);
    }
  });

  it("AGENT_TOOLS is derived from the registry (late registrations are visible, removal works)", () => {
    fake("zz_new");
    expect(AGENT_TOOLS.some((t) => t.name === "zz_new")).toBe(true);
    expect(listTools().some((t) => t.name === "zz_new")).toBe(true);
    unregisterTool("zz_new");
    registered.pop();
    expect(AGENT_TOOLS.some((t) => t.name === "zz_new")).toBe(false);
  });

  it("rejects duplicate names and name/schema mismatches", () => {
    fake("zz_dup");
    expect(() => registerTool({ ...(getTool("zz_dup") as ToolDefinition) })).toThrow(/already registered/);
    expect(() => registerTool({ ...(getTool("zz_dup") as ToolDefinition), name: "other" })).toThrow(/schema\.name/);
  });

  it("a new tool works through the dispatcher without touching any dispatch code", async () => {
    fake("zz_echo");
    const r = await executeToolCall(call("zz_echo", { q: "hi" }), ctx(), true);
    expect(r.content).toBe("<r>hi</r>");
    expect(r.error).toBeUndefined();
  });
});

describe("validation, unknown tools, declined, labels", () => {
  it("returns a readable error for invalid input instead of throwing", async () => {
    fake("zz_v");
    const r = await executeToolCall(call("zz_v", { nope: 1 }), ctx(), true);
    expect(r.error).toBe("invalid zz_v input");
    expect(r.content).toContain("tool_error");
  });

  it("unknown tools produce an error result", async () => {
    const r = await executeToolCall(call("does_not_exist", {}), ctx(), true);
    expect(r.error).toBe("unknown tool");
    expect(r.content).toContain("does_not_exist");
  });

  it("declined calls are not run", async () => {
    let ran = false;
    fake("zz_d", { run: async () => ((ran = true), { content: "x" }) });
    const r = await executeToolCall(call("zz_d", { q: "a" }), ctx(), false);
    expect(ran).toBe(false);
    expect(r.declined).toBe(true);
  });

  it("web_search keeps its search-shaped error/declined payloads for the UI", async () => {
    const r = await executeToolCall(call("web_search", { query: "x" }), ctx(), false);
    expect(r.search).toMatchObject({ query: "x", count: 0, error: "declined by user" });
    expect(r.content).toContain("<search_results");
    const bad = await executeToolCall(call("web_search", { nope: 1 }), ctx(), true);
    expect(bad.error).toBe("invalid web_search input");
    expect(bad.search?.error).toBe("invalid web_search input");
  });

  it("labelForCall is safe for unknown tools and malformed input", () => {
    expect(labelForCall("nope", null)).toBe("nope");
    expect(labelForCall("web_search", { query: "abc" })).toBe("abc");
    expect(labelForCall("fetch_url", undefined)).toBe("fetch page");
  });

  it("reports missing db for tools that need it", async () => {
    const r = await executeToolCall(call("memory_search", { query: "x" }), ctx({ db: undefined as never }), true);
    expect(r.error).toBe("memory database unavailable");
  });
});

describe("limits, duplicates, timeouts, retries", () => {
  it("enforces maxPerTurn", async () => {
    fake("zz_lim", { maxPerTurn: 2 });
    const c = ctx();
    expect((await executeToolCall(call("zz_lim", { q: "a" }), c, true)).error).toBeUndefined();
    expect((await executeToolCall(call("zz_lim", { q: "b" }), c, true)).error).toBeUndefined();
    const third = await executeToolCall(call("zz_lim", { q: "c" }), c, true);
    expect(third.error).toMatch(/limit reached/);
  });

  it("duplicate read-only calls reuse the first result, do not re-run and do not count toward the limit", async () => {
    let runs = 0;
    fake("zz_dupe", { maxPerTurn: 1, run: async (i) => ((runs += 1), { content: `<r>${i.q}</r>` }) });
    const c = ctx();
    const a = await executeToolCall(call("zz_dupe", { q: "same" }, "1"), c, true);
    const b = await executeToolCall(call("zz_dupe", { q: "same" }, "2"), c, true);
    expect(runs).toBe(1);
    expect(b.duplicate).toBe(true);
    expect(b.id).toBe("2");
    expect(b.content).toBe(a.content);
  });

  it("write tools are never deduplicated", async () => {
    let runs = 0;
    fake("zz_w", { effect: "write", run: async () => ((runs += 1), { content: "ok" }) });
    const c = ctx();
    await executeToolCall(call("zz_w", { q: "x" }), c, true);
    await executeToolCall(call("zz_w", { q: "x" }), c, true);
    expect(runs).toBe(2);
  });

  it("failed calls are not memoized (the model may legitimately retry)", async () => {
    let runs = 0;
    fake("zz_f", { run: async () => ((runs += 1), { content: "<e/>", error: "boom" }) });
    const c = ctx();
    await executeToolCall(call("zz_f", { q: "x" }), c, true);
    await executeToolCall(call("zz_f", { q: "x" }), c, true);
    expect(runs).toBe(2);
  });

  it("times out a hung tool via its own timeout without needing the turn signal", async () => {
    fake("zz_slow", {
      timeoutMs: 50,
      run: (_i, c) => new Promise((_res, rej) => c.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "TimeoutError")))),
    });
    const t0 = Date.now();
    const r = await executeToolCall(call("zz_slow", { q: "x" }), ctx(), true);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.error).toMatch(/timeout/);
  });

  it("timeout still applies when the turn passes its own (never-aborting) signal", async () => {
    fake("zz_slow2", {
      timeoutMs: 50,
      run: (_i, c) => new Promise((_res, rej) => c.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "TimeoutError")))),
    });
    const r = await executeToolCall(call("zz_slow2", { q: "x" }), ctx({ signal: new AbortController().signal }), true);
    expect(r.error).toMatch(/timeout/);
  });

  it("turn cancellation reaches the tool and is reported as cancelled", async () => {
    const ac = new AbortController();
    fake("zz_c", {
      timeoutMs: 5000,
      run: (_i, c) => new Promise((_res, rej) => c.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))),
    });
    const p = executeToolCall(call("zz_c", { q: "x" }), ctx({ signal: ac.signal }), true);
    setTimeout(() => ac.abort(), 20);
    expect((await p).error).toBe("cancelled");
  });

  it("retries transient failures of read tools a bounded number of times, never writes", async () => {
    let n = 0;
    fake("zz_r", {
      retry: { retries: 2, backoffMs: 1 },
      run: async () => {
        n += 1;
        if (n < 3) throw new Error("fetch failed");
        return { content: "<ok/>" };
      },
    });
    const r = await executeToolCall(call("zz_r", { q: "x" }), ctx(), true);
    expect(n).toBe(3);
    expect(r.error).toBeUndefined();

    let w = 0;
    fake("zz_rw", {
      effect: "write",
      retry: { retries: 3, backoffMs: 1 },
      run: async () => ((w += 1), Promise.reject(new Error("fetch failed"))),
    });
    await executeToolCall(call("zz_rw", { q: "x" }), ctx(), true);
    expect(w).toBe(1);
  });

  it("does not retry non-transient errors", async () => {
    let n = 0;
    fake("zz_nt", { retry: { retries: 3, backoffMs: 1 }, run: async () => ((n += 1), { content: "<e/>", error: "invalid thing" }) });
    await executeToolCall(call("zz_nt", { q: "x" }), ctx(), true);
    expect(n).toBe(1);
  });

  it("one tool throwing never rejects the dispatcher (siblings are safe)", async () => {
    fake("zz_t", { run: async () => { throw new Error("kaboom"); } });
    fake("zz_ok");
    const [a, b] = await Promise.all([
      executeToolCall(call("zz_t", { q: "x" }, "a"), ctx(), true),
      executeToolCall(call("zz_ok", { q: "y" }, "b"), ctx(), true),
    ]);
    expect(a.error).toBe("kaboom");
    expect(b.error).toBeUndefined();
  });
});

describe("helpers", () => {
  it("stableStringify ignores key order and undefined values", () => {
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe(stableStringify({ a: [2, { d: 1 }], b: 1 }));
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });

  it("classifies transient vs permanent errors", () => {
    for (const m of ["timeout after 6s", "HTTP 503", "ECONNRESET", "fetch failed", "429 too many"]) expect(isTransientError(m)).toBe(true);
    for (const m of ["invalid input", "HTTP 404", "that host is not allowed"]) expect(isTransientError(m)).toBe(false);
  });
});
