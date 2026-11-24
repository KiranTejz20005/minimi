import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runAgentLoop, classifyLlmError, type LoopCallbacks } from "../src/agent/loop.js";
import type { AssistantBlock, LLM, LLMEvent, LLMStreamRequest } from "../src/llm/types.js";
import { registerTool, unregisterTool } from "../src/tools/registry.js";
import type { ToolDefinition } from "../src/tools/types.js";

// ---- scripted fake LLM ------------------------------------------------------------------------------
type Script = (req: LLMStreamRequest, call: number) => LLMEvent[] | Error | { events: LLMEvent[]; then: Error };
type Use = { id: string; name: string; input: unknown };

const say = (text: string): LLMEvent[] => [
  { type: "text_delta", text },
  { type: "done", stopReason: "end_turn", content: [{ type: "text", text }] },
];
const use = (calls: Use[], text = ""): LLMEvent[] => {
  const content: Exclude<AssistantBlock, string> = [];
  if (text) content.push({ type: "text", text });
  for (const c of calls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
  return [...(text ? [{ type: "text_delta", text } as LLMEvent] : []), { type: "done", stopReason: "tool_use", content }];
};

function fakeLlm(script: Script) {
  const requests: LLMStreamRequest[] = [];
  const llm: LLM = {
    stream(req) {
      const call = requests.length;
      requests.push({ ...req, messages: [...req.messages] });
      const out = script(req, call);
      return (async function* () {
        if (out instanceof Error) throw out;
        if (!Array.isArray(out)) {
          yield* out.events;
          throw out.then;
        }
        yield* out;
      })();
    },
    async json() {
      throw new Error("not used");
    },
  };
  return { llm, requests };
}

const httpError = (status: number, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });

// ---- fake tools -------------------------------------------------------------------------------------
let log: string[] = [];
let running = 0;
let maxRunning = 0;
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

const mk = (name: string, over: Partial<ToolDefinition> & { delay?: (i: any) => number }): ToolDefinition => ({
  name,
  schema: { name, description: name, input_schema: { type: "object", properties: {} } },
  validate: (raw) => (raw ?? {}) as any,
  label: (raw) => `${name}:${JSON.stringify((raw as any)?.x ?? "")}`,
  run: async (input: any, ctx) => {
    log.push(`${name}:${input.x}:start`);
    running++;
    maxRunning = Math.max(maxRunning, running);
    try {
      await sleep(over.delay?.(input) ?? input.ms ?? 0, ctx.signal);
      if (input.fail) throw new Error("boom");
      return { content: `${name} result ${input.x}` };
    } finally {
      running--;
      log.push(`${name}:${input.x}:end`);
    }
  },
  ...over,
});

const TOOLS = ["lt_read", "lt_fail", "lt_write", "lt_sens", "lt_search"];
beforeAll(() => {
  registerTool(mk("lt_read", { effect: "read" }));
  registerTool(mk("lt_fail", { effect: "read" }));
  registerTool(mk("lt_write", { effect: "write" }));
  registerTool(mk("lt_sens", { effect: "write", approval: "sensitive", actionLabel: "Save to memory" }));
  registerTool(
    mk("lt_search", {
      isSearch: true,
      effect: "read",
      run: async (input: any) => ({ content: `found ${input.x}`, search: { query: String(input.x), count: 2, cached: false, results: [{ title: "t", url: "https://a.test" }] } }),
    }),
  );
});
afterAll(() => TOOLS.forEach(unregisterTool));
beforeEach(() => {
  log = [];
  running = 0;
  maxRunning = 0;
});

const base = { system: [{ type: "text" as const, text: "sys" }], messages: [{ role: "user" as const, content: "hi" }] };
const run = (llm: LLM, extra: Partial<Parameters<typeof runAgentLoop>[0]> = {}) => runAgentLoop({ llm, ...base, ...extra });
const resultsOf = (req: LLMStreamRequest) => {
  const last = req.messages.at(-1) as { content: { tool_use_id: string; content: string }[] };
  return last.content;
};

describe("step budget", () => {
  it("withholds tools on the last step and answers from what it has", async () => {
    const { llm, requests } = fakeLlm((req, call) => (req.tools ? use([{ id: `c${call}`, name: "lt_read", input: { x: call } }]) : say("final answer")));
    const statuses: string[] = [];
    const res = await run(llm, { limits: { maxSteps: 3 }, callbacks: { onStatus: (t) => statuses.push(t) } });
    expect(res.answer).toBe("final answer");
    expect(res.steps).toBe(3);
    expect(requests.map((r) => !!r.tools)).toEqual([true, true, false]);
    expect(statuses.some((s) => /step limit|answer/i.test(s))).toBe(true);
  });

  it("defaults to 6 steps (5 tool rounds)", async () => {
    const { llm, requests } = fakeLlm((req, call) => (req.tools ? use([{ id: `c${call}`, name: "lt_read", input: { x: call } }]) : say("done")));
    await run(llm);
    expect(requests).toHaveLength(6);
    expect(requests.filter((r) => r.tools)).toHaveLength(5);
  });

  it("falls back to an 'answer now' call when the last step produces no text", async () => {
    const { llm, requests } = fakeLlm((req, call) => {
      if (req.tools) return use([{ id: `c${call}`, name: "lt_read", input: { x: call } }]);
      const last = req.messages.at(-1) as { content: unknown };
      return typeof last.content === "string" && /Answer the user's question now/.test(last.content) ? say("recovered") : [{ type: "done", stopReason: "end_turn", content: [] }];
    });
    const res = await run(llm, { limits: { maxSteps: 2 } });
    expect(res.answer).toBe("recovered");
    expect(requests).toHaveLength(3);
  });

  it("stops offering tools once the global tool-call cap is spent and says so", async () => {
    const { llm, requests } = fakeLlm((req, call) =>
      req.tools
        ? use([
            { id: `a${call}`, name: "lt_read", input: { x: `${call}a` } },
            { id: `b${call}`, name: "lt_read", input: { x: `${call}b` } },
            { id: `c${call}`, name: "lt_read", input: { x: `${call}c` } },
          ])
        : say("capped answer"),
    );
    const statuses: string[] = [];
    const res = await run(llm, { limits: { maxToolCalls: 2, maxSteps: 6 }, callbacks: { onStatus: (t) => statuses.push(t) } });
    expect(res.answer).toBe("capped answer");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.tools).toBeUndefined();
    const results = resultsOf(requests[1]!);
    expect(results.filter((r) => /limit/i.test(r.content))).toHaveLength(1);
    expect(res.toolCalls).toHaveLength(2);
    expect(statuses.some((s) => /tool call limit/i.test(s))).toBe(true);
  });
});

describe("duplicates", () => {
  it("runs identical calls in one batch once; the second gets the same result, flagged duplicate", async () => {
    const { llm, requests } = fakeLlm((req, call) =>
      call === 0
        ? use([
            { id: "d1", name: "lt_read", input: { x: "same", ms: 10 } },
            { id: "d2", name: "lt_read", input: { ms: 10, x: "same" } },
          ])
        : say("ok"),
    );
    const done: any[] = [];
    const res = await run(llm, { callbacks: { onToolDone: (p) => done.push(p) } });
    expect(log.filter((l) => l.endsWith(":start"))).toHaveLength(1);
    const results = resultsOf(requests[1]!);
    expect(results.map((r) => r.tool_use_id)).toEqual(["d1", "d2"]);
    expect(results[0]!.content).toBe(results[1]!.content);
    expect(done.find((d) => d.id === "d2").duplicate).toBe(true);
    expect(done.find((d) => d.id === "d1").duplicate).toBeUndefined();
    expect(res.toolCalls.map((c) => c.id)).toEqual(["d1"]);
  });

  it("duplicates do not count against the tool-call cap", async () => {
    const { llm, requests } = fakeLlm((req, call) =>
      call === 0
        ? use([
            { id: "1", name: "lt_read", input: { x: "a" } },
            { id: "2", name: "lt_read", input: { x: "a" } },
            { id: "3", name: "lt_read", input: { x: "b" } },
          ])
        : say("ok"),
    );
    await run(llm, { limits: { maxToolCalls: 2 } });
    expect(resultsOf(requests[1]!).every((r) => !/limit/i.test(r.content))).toBe(true);
  });

  it("never dedupes write tools", async () => {
    const { llm } = fakeLlm((req, call) =>
      call === 0
        ? use([
            { id: "w1", name: "lt_write", input: { x: "n" } },
            { id: "w2", name: "lt_write", input: { x: "n" } },
          ])
        : say("ok"),
    );
    await run(llm);
    expect(log.filter((l) => l.endsWith(":start"))).toHaveLength(2);
  });

  it("flags duplicate search calls on search_done", async () => {
    const { llm } = fakeLlm((req, call) =>
      call === 0
        ? use([
            { id: "s1", name: "lt_search", input: { x: "q" } },
            { id: "s2", name: "lt_search", input: { x: "q" } },
          ])
        : say("ok"),
    );
    const done: any[] = [];
    const res = await run(llm, { callbacks: { onSearchDone: (p) => done.push(p) } });
    expect(done).toHaveLength(2);
    expect(done.find((d) => d.callId === "s2").duplicate).toBe(true);
    expect(res.searches).toBe(1);
  });
});

describe("parallel execution", () => {
  it("one failing tool does not affect its siblings", async () => {
    const { llm, requests } = fakeLlm((req, call) =>
      call === 0
        ? use([
            { id: "f", name: "lt_fail", input: { x: 1, fail: true } },
            { id: "g", name: "lt_read", input: { x: 2, ms: 15 } },
          ])
        : say("ok"),
    );
    const done: any[] = [];
    await run(llm, { callbacks: { onToolDone: (p) => done.push(p) } });
    const results = resultsOf(requests[1]!);
    expect(results.find((r) => r.tool_use_id === "f")!.content).toMatch(/boom/);
    expect(results.find((r) => r.tool_use_id === "g")!.content).toContain("lt_read result 2");
    expect(done.find((d) => d.id === "f").error).toBeTruthy();
  });

  it("caps concurrency per step", async () => {
    const calls = [1, 2, 3, 4, 5, 6].map((i) => ({ id: `p${i}`, name: "lt_read", input: { x: i, ms: 25 } }));
    const { llm } = fakeLlm((req, call) => (call === 0 ? use(calls) : say("ok")));
    await run(llm, { limits: { maxParallel: 2 } });
    expect(maxRunning).toBeLessThanOrEqual(2);
    expect(maxRunning).toBe(2);
  });

  it("runs write tools after the reads, one at a time, in model order", async () => {
    const { llm } = fakeLlm((req, call) =>
      call === 0
        ? use([
            { id: "w1", name: "lt_write", input: { x: "A", ms: 30 } },
            { id: "w2", name: "lt_write", input: { x: "B", ms: 0 } },
            { id: "r1", name: "lt_read", input: { x: "R", ms: 20 } },
          ])
        : say("ok"),
    );
    await run(llm);
    expect(log).toEqual(["lt_read:R:start", "lt_read:R:end", "lt_write:A:start", "lt_write:A:end", "lt_write:B:start", "lt_write:B:end"]);
  });

  it("returns tool results in the order of the model's calls", async () => {
    const { llm, requests } = fakeLlm((req, call) =>
      call === 0
        ? use([
            { id: "slow", name: "lt_read", input: { x: 1, ms: 30 } },
            { id: "fast", name: "lt_read", input: { x: 2, ms: 0 } },
          ])
        : say("ok"),
    );
    await run(llm);
    expect(resultsOf(requests[1]!).map((r) => r.tool_use_id)).toEqual(["slow", "fast"]);
  });
});

describe("cancellation", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  beforeEach(() => {
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
  });
  afterEach(() => process.off("unhandledRejection", onUnhandled));

  it("aborting mid-step stops promptly: no more tools, no more LLM calls, rejects as aborted", async () => {
    const ac = new AbortController();
    const { llm, requests } = fakeLlm((req, call) =>
      call === 0
        ? use([
            { id: "r1", name: "lt_read", input: { x: 1, ms: 5_000 } },
            { id: "w1", name: "lt_write", input: { x: "W", ms: 0 } },
          ])
        : say("should never be asked"),
    );
    const t0 = Date.now();
    const p = run(llm, { signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(requests).toHaveLength(1);
    expect(log.some((l) => l.startsWith("lt_write"))).toBe(false);
    await sleep(20);
    expect(unhandled).toEqual([]);
  });

  it("does not start queued tools after the abort", async () => {
    const ac = new AbortController();
    const calls = [1, 2, 3, 4].map((i) => ({ id: `q${i}`, name: "lt_read", input: { x: i, ms: 60 } }));
    const { llm } = fakeLlm((req, call) => (call === 0 ? use(calls) : say("no")));
    const p = run(llm, { signal: ac.signal, limits: { maxParallel: 1 } });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(log.filter((l) => l.endsWith(":start")).length).toBeLessThanOrEqual(1);
  });

  it("aborting while an approval is pending resolves it and finishes as aborted", async () => {
    const ac = new AbortController();
    const { llm, requests } = fakeLlm((req, call) => (call === 0 ? use([{ id: "s", name: "lt_sens", input: { x: "mem" } }]) : say("no")));
    const p = run(llm, {
      signal: ac.signal,
      approvalMode: "auto",
      callbacks: { requestApproval: () => new Promise<boolean>(() => {}) }, // never answers
    });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(log).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(unhandled).toEqual([]);
  });

  it("an abort raised inside the LLM stream is not retried", async () => {
    const ac = new AbortController();
    const { llm, requests } = fakeLlm(() => Object.assign(new Error("aborted"), { name: "AbortError" }));
    ac.abort();
    await expect(run(llm, { signal: ac.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toHaveLength(1);
  });
});

describe("approvals", () => {
  const sens = (id: string, x: string) => ({ id, name: "lt_sens", input: { x } });

  it("batches a step's gated calls into one prompt carrying tool, label and verb", async () => {
    const { llm } = fakeLlm((req, call) => (call === 0 ? use([sens("a", "one"), sens("b", "two")]) : say("ok")));
    const prompts: any[][] = [];
    await run(llm, { callbacks: { requestApproval: async (actions) => (prompts.push(actions), true) } });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual([
      { tool: "lt_sens", label: 'lt_sens:"one"', verb: "Save to memory" },
      { tool: "lt_sens", label: 'lt_sens:"two"', verb: "Save to memory" },
    ]);
    expect(log.filter((l) => l.endsWith(":start"))).toHaveLength(2);
  });

  it("a declined batch runs nothing and tells the model", async () => {
    const { llm, requests } = fakeLlm((req, call) => (call === 0 ? use([sens("a", "one")]) : say("ok")));
    const done: any[] = [];
    await run(llm, { callbacks: { requestApproval: async () => false, onToolDone: (p) => done.push(p) } });
    expect(log).toEqual([]);
    expect(resultsOf(requests[1]!)[0]!.content).toMatch(/declin/i);
    expect(done[0].error).toMatch(/declin/i);
  });

  it("a later step's new sensitive call prompts again", async () => {
    const { llm } = fakeLlm((req, call) => (call === 0 ? use([sens("a", "one")]) : call === 1 ? use([sens("b", "two")]) : say("ok")));
    let n = 0;
    await run(llm, { callbacks: { requestApproval: async () => (n++, true) } });
    expect(n).toBe(2);
  });

  it("full mode never asks", async () => {
    const { llm } = fakeLlm((req, call) => (call === 0 ? use([sens("a", "one")]) : say("ok")));
    let asked = 0;
    await run(llm, { approvalMode: "full", callbacks: { requestApproval: async () => (asked++, false) } });
    expect(asked).toBe(0);
    expect(log.filter((l) => l.endsWith(":start"))).toHaveLength(1);
  });
});

describe("LLM stream retry", () => {
  it("retries a transient failure once when nothing was streamed", async () => {
    const { llm, requests } = fakeLlm((req, call) => (call === 0 ? httpError(503) : say("hello")));
    const tokens: string[] = [];
    const res = await run(llm, { callbacks: { onToken: (t) => tokens.push(t) } });
    expect(res.answer).toBe("hello");
    expect(requests).toHaveLength(2);
    expect(tokens.join("")).toBe("hello");
  });

  it("retries 429 and network errors, but only once", async () => {
    const a = fakeLlm((req, call) => (call === 0 ? httpError(429) : say("ok")));
    await run(a.llm);
    expect(a.requests).toHaveLength(2);
    const b = fakeLlm(() => new Error("fetch failed"));
    await expect(run(b.llm)).rejects.toThrow("fetch failed");
    expect(b.requests).toHaveLength(2);
  });

  it("does not retry a fatal 4xx", async () => {
    const { llm, requests } = fakeLlm(() => httpError(400, "bad request"));
    await expect(run(llm)).rejects.toThrow("bad request");
    expect(requests).toHaveLength(1);
  });

  it("does not retry once tokens reached the client (no duplicated text)", async () => {
    const { llm, requests } = fakeLlm((req, call) =>
      call === 0
        ? use([{ id: "r", name: "lt_read", input: { x: 1 } }])
        : { events: [{ type: "text_delta", text: "partial " }], then: httpError(503) },
    );
    const tokens: string[] = [];
    await expect(run(llm, { callbacks: { onToken: (t) => tokens.push(t) } })).rejects.toThrow();
    expect(requests).toHaveLength(2);
    expect(tokens.join("")).toBe("partial ");
  });
});

describe("classifyLlmError", () => {
  it("separates transient from fatal", () => {
    expect(classifyLlmError(httpError(500))).toBe("transient");
    expect(classifyLlmError(httpError(429))).toBe("transient");
    expect(classifyLlmError(httpError(529))).toBe("transient");
    expect(classifyLlmError(httpError(401))).toBe("fatal");
    expect(classifyLlmError(httpError(400))).toBe("fatal");
    expect(classifyLlmError(new Error("ECONNRESET"))).toBe("transient");
    expect(classifyLlmError(new Error("LLM stream ended without done event"))).toBe("transient");
    expect(classifyLlmError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe("fatal");
    expect(classifyLlmError("weird")).toBe("fatal");
  });
});

describe("result", () => {
  it("exposes executed tool calls for persistence", async () => {
    const { llm } = fakeLlm((req, call) => (call === 0 ? use([{ id: "z", name: "lt_read", input: { x: "q" } }, { id: "y", name: "lt_fail", input: { x: 1, fail: true } }]) : say("ok")));
    const res = await run(llm);
    expect(res.toolCalls).toHaveLength(2);
    const z = res.toolCalls.find((c) => c.id === "z")!;
    expect(z).toMatchObject({ name: "lt_read", input: { x: "q" }, content: "lt_read result q" });
    expect(res.toolCalls.find((c) => c.id === "y")!.error).toMatch(/boom/);
  });

  it("emits tool start/done pairs for every call", async () => {
    const { llm } = fakeLlm((req, call) => (call === 0 ? use([{ id: "a", name: "lt_read", input: { x: 1 } }, { id: "b", name: "lt_read", input: { x: 1 } }]) : say("ok")));
    const cb: LoopCallbacks = { onToolStart: () => {}, onToolDone: () => {} };
    const started: string[] = [];
    const done: string[] = [];
    await run(llm, { callbacks: { ...cb, onToolStart: (t) => started.push(...t.map((x) => x.id)), onToolDone: (p) => done.push(p.id) } });
    expect(started.sort()).toEqual(["a", "b"]);
    expect(done.sort()).toEqual(["a", "b"]);
  });
});
