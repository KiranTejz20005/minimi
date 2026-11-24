import { answer, capture, count, freshDb, messageText, rows, scriptedLlm, tools, turn, turnStatus, use } from "./helpers/integration.js";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { needsFreshData } from "../src/agent/run-turn.js";
import { runAgentLoop } from "../src/agent/loop.js";
import { toOpenAIMessages } from "../src/llm/openai.js";
import { registerTool, unregisterTool } from "../src/tools/registry.js";
import type { ToolDefinition } from "../src/tools/types.js";
import type { SearchProvider } from "../src/search/types.js";
import { createMockSearchProvider, createMultiHitProvider } from "../scripts/mock-search.js";

let db: DatabaseSync;
beforeEach(() => {
  db = freshDb();
});

// ---- test-only tools ------------------------------------------------------------------------------------
const sleepAbortable = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
const mkTool = (name: string, run: ToolDefinition["run"], over: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name,
  schema: { name, description: name, input_schema: { type: "object", properties: {} } },
  validate: (raw) => (raw ?? {}) as never,
  run,
  ...over,
});
let slowStarted = 0;
let slowFinished = 0;
beforeAll(() => {
  registerTool(mkTool("it_boom", async () => { throw new Error("kaboom: disk on fire"); }, { effect: "read" }));
  registerTool(
    mkTool("it_slow", async (_i, ctx) => {
      slowStarted++;
      await sleepAbortable(5000, ctx.signal);
      if (ctx.signal?.aborted) throw new Error("aborted by signal");
      slowFinished++;
      return { content: "slow done" };
    }),
  );
  registerTool(
    // ignores ctx.signal entirely: models a third-party tool that does not honour cancellation
    mkTool("it_deaf", async () => {
      await new Promise((r) => setTimeout(r, 1500));
      return { content: "deaf done" };
    }),
  );
});
afterAll(() => ["it_boom", "it_slow", "it_deaf"].forEach(unregisterTool));

const countingProvider = (inner: SearchProvider = createMockSearchProvider()) => {
  const queries: string[] = [];
  const p: SearchProvider = {
    async search(input, signal) {
      queries.push(input.query);
      return inner.search(input, signal);
    },
  };
  return { p, queries };
};

describe("1. calculation turn", () => {
  it("does not force a web search for arithmetic (heuristic) and persists the calculate result + trace", async () => {
    // The forced-search heuristic itself (only active when no llm is injected, so assert the pure function).
    for (const q of ["what is 15% of 240", "15% of 240", "5 miles to km", "what day is it today", "days between 2026-01-01 and 2026-03-05"]) {
      expect(needsFreshData(q, false, false), q).toBe(false);
    }
    expect(needsFreshData("latest iphone price", false, false)).toBe(true);

    const { p, queries } = countingProvider();
    const s = scriptedLlm([tools([use("t1", "calculate", { expression: "15% of 240" })]), answer("15% of 240 is 36.")]);
    const cap = capture();
    const res = await turn(db, s.llm, "what is 15% of 240", { searchProvider: p }, cap.handlers);

    expect(res.answer).toBe("15% of 240 is 36.");
    expect(res.searchCount).toBe(0);
    expect(queries).toEqual([]);
    expect(cap.of("search_start")).toEqual([]);
    expect(s.requests).toHaveLength(2);
    expect(s.requests[0]!.forceTool).toBe(false);
    expect(s.requests[0]!.toolNames).toContain("calculate");
    // tool event + persisted tool_results row
    expect(cap.of("tool_done")).toHaveLength(1);
    const tr = rows<{ name: string; content: string; error: string | null; call_id: string }>(db, `SELECT * FROM tool_results WHERE turn_id = ?`, res.turnId);
    expect(tr).toHaveLength(1);
    expect(tr[0]).toMatchObject({ name: "calculate", call_id: "t1", error: null });
    expect(tr[0]!.content).toContain("36");
    expect(s.resultsFor(1)["t1"]).toContain("36");
    // trace
    const traces = rows<{ stage: string; detail: string }>(db, `SELECT stage, detail FROM traces WHERE turn_id = ?`, res.turnId);
    const llmStep = traces.find((t) => t.stage === "llm_step")!;
    expect(JSON.parse(llmStep.detail)).toMatchObject({ steps: 2, searches: 0, toolCalls: 1 });
    expect(traces.some((t) => t.stage === "search")).toBe(false);
    expect(turnStatus(db, res.turnId)).toBe("ok");
    // the user/assistant messages are stored
    expect(count(db, "messages", `conversation_id = '${res.conversationId}'`)).toBe(2);
  });

  it("a bad expression is reported to the model as an error result, not thrown", async () => {
    const s = scriptedLlm([tools([use("t1", "calculate", { expression: "1 / 0 )(" })]), answer("I could not compute that.")]);
    const res = await turn(db, s.llm, "calc please 1/0", {});
    expect(res.answer).toBe("I could not compute that.");
    const tr = rows<{ error: string | null; content: string }>(db, `SELECT error, content FROM tool_results WHERE turn_id = ?`, res.turnId);
    expect(tr[0]!.error).toBeTruthy();
    expect(s.resultsFor(1)["t1"]).toContain("error");
  });
});

describe("5. parallel + duplicate + failure in one step", () => {
  it("returns every tool_result in model order, runs the duplicate once, isolates the failing tool; both adapters accept the history", async () => {
    const { p, queries } = countingProvider();
    const s = scriptedLlm([
      tools([
        use("a", "web_search", { query: "parallel alpha query" }),
        use("b", "web_search", { query: "parallel alpha query" }), // identical -> duplicate
        use("c", "calculate", { expression: "6*7" }),
        use("d", "it_boom", {}),
      ]),
      answer("All done: 42 [1]."),
    ]);
    const cap = capture();
    const res = await turn(db, s.llm, "do several things", { searchProvider: p }, cap.handlers);

    expect(queries).toEqual(["parallel alpha query"]); // duplicate ran once
    const results = s.resultsFor(1);
    expect(Object.keys(results)).toEqual(["a", "b", "c", "d"]); // model order
    expect(results["a"]).toContain("<search_results");
    expect(results["b"]).toBe(results["a"]); // duplicate reuses the first answer
    expect(results["c"]).toContain("42");
    expect(results["d"]).toContain("tool_error");
    expect(results["d"]).toContain("kaboom");
    expect(res.answer).toBe("All done: 42 [1].");

    const done = cap.of("search_done") as { callId: string; duplicate?: true }[];
    expect(done.map((d) => d.callId).sort()).toEqual(["a", "b"]);
    expect(done.find((d) => d.callId === "b")!.duplicate).toBe(true);
    expect(done.find((d) => d.callId === "a")!.duplicate).toBeUndefined();
    const toolDone = cap.of("tool_done") as { id: string; error?: string }[];
    expect(toolDone.find((t) => t.id === "d")!.error).toContain("kaboom");
    expect(toolDone.find((t) => t.id === "c")!.error).toBeUndefined();

    // persisted: the duplicate is not stored, the failure is (with its error)
    const tr = rows<{ call_id: string; name: string; error: string | null }>(db, `SELECT call_id, name, error FROM tool_results WHERE turn_id = ? ORDER BY rowid`, res.turnId);
    expect(tr.map((t) => t.call_id)).toEqual(["a", "c", "d"]);
    expect(tr.find((t) => t.call_id === "d")!.error).toContain("kaboom");
    expect(res.searchCount).toBe(1);

    // Anthropic pairing: every tool_use id is answered by a tool_result in the very next user message.
    const msgs = s.requests[1]!.messages;
    const asstIdx = msgs.findIndex((m) => m.role === "assistant" && Array.isArray(m.content));
    const useIds = (msgs[asstIdx]!.content as { type: string; id?: string }[]).filter((b) => b.type === "tool_use").map((b) => b.id);
    const resIds = (msgs[asstIdx + 1]!.content as { type: string; tool_use_id?: string }[]).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id);
    expect(msgs[asstIdx + 1]!.role).toBe("user");
    expect(resIds).toEqual(useIds);

    // OpenAI adapter: every tool_call is followed (immediately, in order) by a tool message.
    const oa = toOpenAIMessages([{ text: "sys" }], msgs);
    const ai = oa.findIndex((m) => m.role === "assistant" && "tool_calls" in m && !!m.tool_calls);
    const calls = (oa[ai] as { tool_calls: { id: string }[] }).tool_calls.map((c) => c.id);
    expect(calls).toEqual(["a", "b", "c", "d"]);
    const toolMsgs = oa.slice(ai + 1, ai + 1 + calls.length) as { role: string; tool_call_id: string; content: string }[];
    expect(toolMsgs.map((m) => m.role)).toEqual(["tool", "tool", "tool", "tool"]);
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(calls);
    expect(toolMsgs.every((m) => m.content.length > 0)).toBe(true);
  });

  it("budget-dropped calls still get a paired tool_result (maxToolCalls)", async () => {
    const s = scriptedLlm([
      tools([use("x1", "calculate", { expression: "1+1" }), use("x2", "calculate", { expression: "2+2" }), use("x3", "calculate", { expression: "3+3" })]),
      answer("ok"),
    ]);
    const res = await runAgentLoop({
      llm: s.llm,
      system: [{ type: "text", text: "sys" }],
      messages: [{ role: "user", content: "hi" }],
      db,
      limits: { maxToolCalls: 2 },
    });
    expect(res.answer).toBe("ok");
    const r = s.resultsFor(1);
    expect(Object.keys(r)).toEqual(["x1", "x2", "x3"]);
    expect(r["x3"]).toMatch(/limit/);
    expect(res.toolCalls.map((c) => c.id)).toEqual(["x1", "x2"]);
  });
});

describe("6. cancellation", () => {
  let unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => void unhandled.push(e);
  beforeEach(() => {
    unhandled = [];
    slowStarted = 0;
    slowFinished = 0;
    process.on("unhandledRejection", onUnhandled);
  });
  afterEach(() => void process.off("unhandledRejection", onUnhandled));

  it("abort during a slow tool: turn is 'aborted', no more LLM calls, no unhandled rejections, prompt return", async () => {
    const s = scriptedLlm([tools([use("s1", "it_slow", {})]), answer("should never be requested")]);
    const ac = new AbortController();
    const cap = capture();
    const t0 = Date.now();
    const p = turn(db, s.llm, "run the slow thing", { signal: ac.signal }, cap.handlers);
    const guarded = p.then(() => "resolved", (e: Error) => `rejected:${e.name}`);
    await new Promise((r) => setTimeout(r, 120));
    expect(slowStarted).toBe(1);
    ac.abort();
    const outcome = await guarded;
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(outcome).toMatch(/^rejected:/);
    expect(slowFinished).toBe(0); // the tool saw the signal and bailed out
    expect(s.requests).toHaveLength(1); // no further LLM calls
    await new Promise((r) => setTimeout(r, 50));
    const t = rows<{ id: string; status: string }>(db, `SELECT id, status FROM turns`);
    expect(t).toHaveLength(1);
    expect(t[0]!.status).toBe("aborted");
    expect(unhandled).toEqual([]);
    expect(count(db, "tool_results")).toBe(0);
  });

  it("abort while an approval prompt is pending: nothing runs, turn aborted", async () => {
    const s = scriptedLlm([tools([use("m1", "save_memory", { action: "save", text: "I like tea" })]), answer("never")]);
    const ac = new AbortController();
    const p = turn(db, s.llm, "remember I like tea", { signal: ac.signal, approvalMode: "auto" }, {
      requestApproval: () => new Promise<boolean>(() => {}), // user never answers
    }).then(() => "resolved", (e: Error) => `rejected:${e.name}`);
    await new Promise((r) => setTimeout(r, 80));
    ac.abort();
    expect(await p).toMatch(/^rejected:/);
    expect(count(db, "saved_memories")).toBe(0);
    expect(count(db, "memory_events")).toBe(0);
    expect(s.requests).toHaveLength(1);
    expect(rows<{ status: string }>(db, `SELECT status FROM turns`)[0]!.status).toBe("aborted");
    expect(unhandled).toEqual([]);
  });

  it("abort before the first model token", async () => {
    const ac = new AbortController();
    ac.abort();
    const s = scriptedLlm([answer("hello")]);
    const out = await turn(db, s.llm, "hi", { signal: ac.signal }).then(() => "resolved", () => "rejected");
    // whichever way it ends it must not leave a turn stuck in a non-final state
    const st = rows<{ status: string }>(db, `SELECT status FROM turns`)[0]!.status;
    expect(["aborted", "ok"]).toContain(st);
    if (out === "rejected") expect(st).toBe("aborted");
    expect(unhandled).toEqual([]);
  });

  // PRODUCT BUG (src/tools/registry.ts executeToolCall ~L205 / src/agent/loop.ts execOne): the dispatcher awaits def.run() without
  // racing ctx.signal, so a tool that does not poll the signal delays cancellation until it finishes or hits its timeoutMs.
  it("a tool that ignores the signal must not keep the cancelled turn hanging until it finishes", async () => {
    const s = scriptedLlm([tools([use("d1", "it_deaf", {})]), answer("never")]);
    const ac = new AbortController();
    const t0 = Date.now();
    const p = turn(db, s.llm, "deaf tool", { signal: ac.signal }).then(() => "resolved", () => "rejected");
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    await p;
    // The tool takes 1500ms and never looks at the signal. A responsive cancellation returns well before that.
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("1b. forced-search heuristic on date arithmetic", () => {
  // PRODUCT BUG (src/agent/run-turn.ts FRESH_CUE `20(2[4-9]|3\d)` ~L53 + needsFreshData ~L122): an explicit year in a calculation such as
  // "2026-11-24 + 90 days" matches FRESH_CUE and is not caught by isCalculation/isDateTimeQuestion, so the first step is a FORCED web_search
  // (when no llm is injected) even though `calculate` is the right tool.
  it("does not force a web search for date arithmetic that contains a year", () => {
    expect(needsFreshData("2026-11-24 + 90 days", false, false)).toBe(false);
    expect(needsFreshData("what is 2026-11-24 plus 2 weeks", false, false)).toBe(false);
  });
});

describe("7. step budget", () => {
  it("a model that keeps asking for tools is cut off at MAX_STEPS and still answers (tools withheld on the last step)", async () => {
    const s = scriptedLlm([
      {
        kind: "fn",
        fn: (req, call) => (req.tools ? tools([use(`c${call}`, "calculate", { expression: `${call}+1` })]) : answer("Final answer after budget.")),
      },
    ]);
    const cap = capture();
    const res = await turn(db, s.llm, "keep going", {}, cap.handlers);
    expect(res.answer).toBe("Final answer after budget.");
    expect(res.steps).toBe(6);
    expect(s.requests).toHaveLength(6);
    expect(s.requests.map((r) => r.hasTools)).toEqual([true, true, true, true, true, false]);
    expect(rows(db, `SELECT 1 FROM tool_results WHERE turn_id = ?`, res.turnId)).toHaveLength(5);
    const llmStep = JSON.parse(rows<{ detail: string }>(db, `SELECT detail FROM traces WHERE turn_id = ? AND stage = 'llm_step'`, res.turnId)[0]!.detail);
    expect(llmStep.budget).toBe("steps");
    expect((cap.of("status") as string[]).some((t) => /limit/i.test(t))).toBe(true);
    // the persisted assistant message is the real answer
    const m = rows<{ content: string }>(db, `SELECT content FROM messages WHERE conversation_id = ? AND role = 'assistant'`, res.conversationId);
    expect(m[0]!.content).toBe("Final answer after budget.");
  });

  it("an obstinate model that calls tools even when none are offered still yields a non-empty answer and terminates", async () => {
    const s = scriptedLlm([{ kind: "fn", fn: (_r, call) => tools([use(`o${call}`, "calculate", { expression: `${call}*2` })]) }]);
    const res = await turn(db, s.llm, "never stop", {});
    expect(res.answer.trim().length).toBeGreaterThan(0);
    expect(s.requests.length).toBeLessThanOrEqual(8);
    expect(turnStatus(db, res.turnId)).toBe("ok");
    // no dangling tool_use in any request: each assistant tool_use is followed by its tool_results
    for (const r of s.requests) {
      r.messages.forEach((m, i) => {
        if (m.role === "assistant" && Array.isArray(m.content) && (m.content as { type: string }[]).some((b) => b.type === "tool_use")) {
          expect(r.messages[i + 1]?.role).toBe("user");
        }
      });
    }
  });

  it("runAgentLoop honours limits.maxSteps", async () => {
    const s = scriptedLlm([{ kind: "fn", fn: (req, call) => (req.tools ? tools([use(`k${call}`, "calculate", { expression: `${call}+${call}` })]) : answer("done")) }]);
    const res = await runAgentLoop({ llm: s.llm, system: [{ type: "text", text: "s" }], messages: [{ role: "user", content: "x" }], db, limits: { maxSteps: 3 } });
    expect(res.steps).toBe(3);
    expect(res.answer).toBe("done");
    expect(res.budget).toBe("steps");
  });
});

describe("8. tool result persistence and reuse across turns", () => {
  it("turn 2 sees <previous_tool_results> (no [n]); its citations only reference turn-2 sources", async () => {
    const s1 = scriptedLlm([tools([use("w1", "web_search", { query: "zephyr cloud plans" })]), answer("Zephyr costs $40 [1].")]);
    const r1 = await turn(db, s1.llm, "zephyr cloud plans", {});
    expect(r1.answer).toBe("Zephyr costs $40 [1].");
    const src1 = rows<{ n: number; url: string; cited: number }>(db, `SELECT n, url, cited FROM sources WHERE turn_id = ?`, r1.turnId);
    expect(src1).toHaveLength(1);
    expect(src1[0]!.n).toBe(1);
    expect(count(db, "tool_results", `turn_id = '${r1.turnId}'`)).toBe(1);

    // turn 2, same conversation, no new search; the (sloppy) model re-cites [1]
    const s2 = scriptedLlm([answer("As found earlier it is $40 [1].")]);
    const r2 = await turn(db, s2.llm, "and is that per month?", { conversationId: r1.conversationId });
    const userMsg = messageText(s2.requests[0]!.messages.at(-1)!);
    expect(userMsg).toContain("<previous_tool_results");
    expect(userMsg).toContain('name="web_search"');
    expect(userMsg).toContain("zephyr cloud plans");
    const block = userMsg.slice(userMsg.indexOf("<previous_tool_results"), userMsg.indexOf("</previous_tool_results>"));
    expect(block).not.toMatch(/^\s*\[\d+\]/m);
    expect(block).not.toMatch(/\[1\]/);
    // [1] is not valid in turn 2 (no source registered) -> stripped; no sources saved for turn 2
    expect(r2.answer).not.toContain("[1]");
    expect(r2.sourceCount).toBe(0);
    expect(count(db, "sources", `turn_id = '${r2.turnId}'`)).toBe(0);

    // turn 3 searches again: [1] now means the NEW source and only that one is saved for turn 3
    const s3 = scriptedLlm([tools([use("w3", "web_search", { query: "zephyr cloud annual billing" })]), answer("Annual billing is cheaper [1] [2].")]);
    const r3 = await turn(db, s3.llm, "annual billing?", { conversationId: r1.conversationId });
    expect(r3.answer).toContain("[1]");
    expect(r3.answer).not.toContain("[2]"); // only one result was registered
    const src3 = rows<{ n: number; url: string }>(db, `SELECT n, url FROM sources WHERE turn_id = ?`, r3.turnId);
    expect(src3.map((s) => s.n)).toEqual([1]);
    expect(src3[0]!.url).not.toBe("");
    expect(src3[0]!.url).toContain("zephyr");
    // the older turn's source row is untouched
    expect(count(db, "sources", `turn_id = '${r1.turnId}'`)).toBe(1);
  });

  it("only successful tool results are offered to later turns; errors and write tools are not", async () => {
    const s1 = scriptedLlm([
      tools([use("e1", "it_boom", {}), use("m1", "save_memory", { action: "save", text: "I prefer window seats" }), use("c1", "calculate", { expression: "2+2" })]),
      answer("ok"),
    ]);
    const r1 = await turn(db, s1.llm, "mixed bag", {});
    const s2 = scriptedLlm([answer("fine")]);
    await turn(db, s2.llm, "follow up", { conversationId: r1.conversationId });
    const um = messageText(s2.requests[0]!.messages.at(-1)!);
    expect(um).toContain('name="calculate"');
    expect(um).not.toContain('name="it_boom"');
    const prev = um.slice(um.indexOf("<previous_tool_results"), um.indexOf("</previous_tool_results>") + 1);
    expect(prev).not.toContain("save_memory");
  });
});

describe("11. regression: the four original tools end-to-end", () => {
  it("web_search results are cited and the sources are persisted", async () => {
    const s = scriptedLlm([tools([use("w", "web_search", { query: "regression pricing page" })]), answer("Plans are unchanged [1].")]);
    const res = await turn(db, s.llm, "regression pricing page", { searchProvider: createMultiHitProvider(2) });
    expect(res.answer).toBe("Plans are unchanged [1].");
    expect(res.sourceCount).toBe(2);
    const src = rows<{ n: number; url: string; cited: number }>(db, `SELECT n, url, cited FROM sources WHERE turn_id = ? ORDER BY n`, res.turnId);
    expect(src).toHaveLength(1); // only the cited one is saved
    expect(src[0]).toMatchObject({ n: 1, cited: 1 });
    expect(src[0]!.url).toMatch(/^https:\/\/vendor-0\.example/);
  });

  it("fetch_url error path: invalid input and a blocked host come back as error results", async () => {
    const s = scriptedLlm([
      tools([use("f1", "fetch_url", { url: "not a url" }), use("f2", "fetch_url", { url: "http://127.0.0.1:1/" })]),
      answer("Could not fetch those pages."),
    ]);
    const res = await turn(db, s.llm, "fetch these pages please", {});
    expect(res.answer).toBe("Could not fetch those pages.");
    const r = s.resultsFor(1);
    expect(r["f1"]).toMatch(/error=/);
    expect(r["f2"]).toMatch(/error=/);
    expect(r["f2"]).not.toContain("untrusted web content");
    const tr = rows<{ call_id: string; error: string | null }>(db, `SELECT call_id, error FROM tool_results WHERE turn_id = ? ORDER BY call_id`, res.turnId);
    expect(tr.every((t) => !!t.error)).toBe(true);
  });

  it("memory_search finds an earlier turn from another conversation", async () => {
    const s1 = scriptedLlm([answer("Poseidonis is the capital of Atlantis.")]);
    await turn(db, s1.llm, "What is the capital of Atlantis?", {});
    const s2 = scriptedLlm([tools([use("ms", "memory_search", { query: "capital Atlantis" })]), answer("You asked about Atlantis.")]);
    const res = await turn(db, s2.llm, "what did we say about that city", {});
    expect(res.answer).toBe("You asked about Atlantis.");
    const out = s2.resultsFor(1)["ms"]!;
    expect(out).toContain("<memory_results");
    expect(out).toContain("Poseidonis");
    expect(out).toMatch(/count="[1-9]/);
  });

  it("lookup_claims returns an inserted claim", async () => {
    const s1 = scriptedLlm([answer("Acme Pro costs $99 per month.")]);
    const r1 = await turn(db, s1.llm, "Acme Pro price?", {});
    db.prepare(`INSERT INTO claims (id, turn_id, subject, attribute, value, as_of, source_url, volatility) VALUES ('cl1', ?, 'Acme Pro', 'monthly price', '$99', '2026-11-10', 'https://acme.example/pricing', 'high')`).run(r1.turnId);
    const s2 = scriptedLlm([tools([use("lc", "lookup_claims", { query: "Acme" })]), answer("It was $99.")]);
    await turn(db, s2.llm, "is the Acme price still right?", {});
    const out = s2.resultsFor(1)["lc"]!;
    expect(out).toContain('<claims query="Acme" count="1"');
    expect(out).toContain("Acme Pro · monthly price = $99");
    expect(out).toContain("https://acme.example/pricing");
  });
});
