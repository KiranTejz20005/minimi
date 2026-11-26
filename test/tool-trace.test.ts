/** Per-tool traces, token usage on the llm_step trace / RunTurnResult, and the truncation trace row. */
import { capture, freshDb, makeApp, rows, turn } from "./helpers/integration.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { getTracesForTurn } from "../src/memory/store.js";
import type { AssistantBlock, LLM, LLMEvent, TokenUsage } from "../src/llm/types.js";
import { registerTool, unregisterTool } from "../src/tools/registry.js";
import type { ToolDefinition } from "../src/tools/types.js";

const mk = (name: string, run: ToolDefinition["run"]): ToolDefinition => ({
  name,
  effect: "read",
  schema: { name, description: name, input_schema: { type: "object", properties: {} } },
  validate: (raw) => (raw ?? {}) as any,
  label: (raw) => `${name} ${(raw as any)?.x ?? ""}`.trim(),
  run,
});
beforeAll(() => {
  registerTool(mk("tt_ok", async (input: any) => ({ content: `ok ${input.x}` })));
  registerTool(
    mk("tt_fail", async () => {
      throw new Error("boom");
    }),
  );
});
afterAll(() => ["tt_ok", "tt_fail"].forEach(unregisterTool));

type Use = { id: string; name: string; input: unknown };
const calls = (list: Use[], usage?: TokenUsage): LLMEvent[] => {
  const content: Exclude<AssistantBlock, string> = list.map((c) => ({ type: "tool_use" as const, ...c }));
  return [{ type: "done", stopReason: "tool_use", content, ...(usage ? { usage } : {}) }];
};
const say = (text: string, usage?: TokenUsage, stopReason = "end_turn"): LLMEvent[] => [
  { type: "text_delta", text },
  { type: "done", stopReason, content: [{ type: "text", text }], ...(usage ? { usage } : {}) },
];

function llmOf(steps: LLMEvent[][]): LLM {
  let call = 0;
  return {
    stream() {
      const evs = steps[Math.min(call++, steps.length - 1)]!;
      return (async function* () {
        yield* evs;
      })();
    },
    async json<T>(): Promise<T> {
      throw new Error("not used");
    },
  };
}

const traces = (db: DatabaseSync, turnId: string) =>
  getTracesForTurn(db, turnId).map((t) => ({ ...t, d: t.detail ? (JSON.parse(t.detail) as Record<string, any>) : null }));

describe("per-tool trace", () => {
  it("records one 'tool' row per call with name, label and step; flags duplicates and errors", async () => {
    const db = freshDb();
    const llm = llmOf([
      calls([
        { id: "a", name: "tt_ok", input: { x: 1 } },
        { id: "b", name: "tt_ok", input: { x: 1 } },
        { id: "c", name: "tt_fail", input: { x: 2 } },
      ]),
      calls([{ id: "d", name: "tt_ok", input: { x: 3 } }]),
      say("All done."),
    ]);
    const res = await turn(db, llm, "run my tools please");
    expect(res.answer).toBe("All done.");

    const all = traces(db, res.turnId);
    const tools = all.filter((t) => t.stage === "tool");
    expect(tools).toHaveLength(4);
    const byId = Object.fromEntries(tools.map((t) => [t.d!.id, t.d!]));
    expect(byId.a).toMatchObject({ name: "tt_ok", tool: "tt_ok", label: "tt_ok 1", step: 1 });
    expect(byId.a.duplicate).toBeUndefined();
    expect(byId.a.error).toBeUndefined();
    expect(byId.b).toMatchObject({ name: "tt_ok", step: 1, duplicate: true });
    expect(byId.c).toMatchObject({ name: "tt_fail", step: 1 });
    expect(byId.c.error).toMatch(/boom/);
    expect(byId.d).toMatchObject({ name: "tt_ok", label: "tt_ok 3", step: 2 });
    for (const t of tools) expect(t.duration_ms).toBeGreaterThanOrEqual(0);

    // Existing stages are still recorded once each, and llm_step keeps its fields.
    for (const stage of ["temporal", "retrieve", "llm_step", "citations"]) expect(all.filter((t) => t.stage === stage)).toHaveLength(1);
    const step = all.find((t) => t.stage === "llm_step")!.d!;
    expect(step).toMatchObject({ steps: 3, searches: 0, toolCalls: 3, budget: null });
  });

  it("the runs API shows tool rows with the tool name the Runs view uses for titles", async () => {
    const db = freshDb();
    const res = await turn(db, llmOf([calls([{ id: "a", name: "tt_ok", input: { x: 9 } }]), say("ok")]), "go");
    const body = (await (await makeApp(db).request(`/api/runs/${res.turnId}`)).json()) as { steps: { stage: string; detail: any }[] };
    const tool = body.steps.find((s) => s.stage === "tool");
    expect(tool?.detail).toMatchObject({ tool: "tt_ok", name: "tt_ok", label: "tt_ok 9", step: 1 });
  });
});

describe("token usage", () => {
  it("sums provider usage into the llm_step trace (totals and per step) and RunTurnResult", async () => {
    const db = freshDb();
    const llm = llmOf([
      calls([{ id: "a", name: "tt_ok", input: { x: 1 } }], { inputTokens: 100, outputTokens: 10 }),
      say("Answer.", { inputTokens: 150, outputTokens: 25 }),
    ]);
    const res = await turn(db, llm, "use tokens");
    expect(res.usage).toEqual({ inputTokens: 250, outputTokens: 35 });
    const step = traces(db, res.turnId).find((t) => t.stage === "llm_step")!.d!;
    expect(step.inputTokens).toBe(250);
    expect(step.outputTokens).toBe(35);
    expect(step.usage).toEqual([
      { step: 1, inputTokens: 100, outputTokens: 10 },
      { step: 2, inputTokens: 150, outputTokens: 25 },
    ]);
  });

  it("reports null usage when the provider sends none", async () => {
    const db = freshDb();
    const res = await turn(db, llmOf([say("Plain.")]), "no usage");
    expect(res.usage).toBeNull();
    const step = traces(db, res.turnId).find((t) => t.stage === "llm_step")!.d!;
    expect(step.inputTokens ?? null).toBeNull();
    expect(step.outputTokens ?? null).toBeNull();
    expect(step.steps).toBe(1);
  });

  it("counts the continuation of a cut-off answer in the same step", async () => {
    const db = freshDb();
    const llm = llmOf([say("Half an ", { inputTokens: 50, outputTokens: 4096 }, "max_tokens"), say("answer.", { inputTokens: 60, outputTokens: 3 })]);
    const res = await turn(db, llm, "long one");
    expect(res.usage).toEqual({ inputTokens: 110, outputTokens: 4099 });
    const step = traces(db, res.turnId).find((t) => t.stage === "llm_step")!.d!;
    expect(step.usage).toEqual([{ step: 1, inputTokens: 110, outputTokens: 4099 }]);
  });
});

describe("truncation trace", () => {
  it("records the continuation, emits a status, and stores the whole answer", async () => {
    const db = freshDb();
    const cap = capture();
    const res = await turn(db, llmOf([say("Half an ", undefined, "max_tokens"), say("answer.")]), "long one", {}, cap.handlers);
    expect(res.answer).toBe("Half an answer.");
    expect((cap.of("token") as string[]).join("")).toBe("Half an answer.");
    expect((cap.of("status") as string[]).some((s) => /length limit/i.test(s))).toBe(true);

    const all = traces(db, res.turnId);
    const tr = all.filter((t) => t.stage === "truncation");
    expect(tr).toHaveLength(1);
    expect(tr[0]!.d).toMatchObject({ step: 1, kind: "answer", action: "continue" });
    expect(typeof tr[0]!.d!.label).toBe("string");
    expect(all.find((t) => t.stage === "llm_step")!.d!.truncations).toBe(1);

    const stored = rows<{ content: string }>(db, `SELECT content FROM messages WHERE role = 'assistant' AND conversation_id = ?`, res.conversationId);
    expect(stored.map((m) => m.content)).toEqual(["Half an answer."]);
  });

  it("records a retried tool call that was cut off", async () => {
    const db = freshDb();
    const llm = llmOf([
      [{ type: "done", stopReason: "max_tokens", content: [{ type: "tool_use", id: "p", name: "tt_ok", input: {} }] }],
      calls([{ id: "a", name: "tt_ok", input: { x: 1 } }]),
      say("ok"),
    ]);
    const res = await turn(db, llm, "cut tool");
    const all = traces(db, res.turnId);
    expect(all.filter((t) => t.stage === "truncation").map((t) => t.d)).toEqual([expect.objectContaining({ step: 1, kind: "tool_call", action: "retry" })]);
    expect(all.filter((t) => t.stage === "tool").map((t) => t.d!.id)).toEqual(["a"]);
  });
});
