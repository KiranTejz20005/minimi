/**
 * Output limits and truncation: MAX_OUTPUT_TOKENS, provider token usage, and how the loop recovers from a step that
 * stopped at the length limit (stopReason "max_tokens").
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { overlapLength, runAgentLoop, type LoopCallbacks } from "../src/agent/loop.js";
import { envSchema, getConfig } from "../src/config.js";
import { createOpenAILlm, toOpenAIMessages } from "../src/llm/openai.js";
import type { AssistantBlock, LLM, LLMEvent, LLMStreamRequest } from "../src/llm/types.js";
import { registerTool, unregisterTool } from "../src/tools/registry.js";
import type { ToolDefinition } from "../src/tools/types.js";

// ---- scripted fake LLM (yields any stopReason, unlike test/helpers/integration.ts) ----------------------
type Script = (req: LLMStreamRequest, call: number) => LLMEvent[] | Error;
type Use = { id: string; name: string; input: unknown };

const say = (text: string, stopReason = "end_turn"): LLMEvent[] => [
  ...Array.from(text, (ch) => ({ type: "text_delta" as const, text: ch })),
  { type: "done", stopReason, content: [{ type: "text", text }] },
];
const cut = (text: string) => say(text, "max_tokens");
const use = (calls: Use[], stopReason = "tool_use", text = ""): LLMEvent[] => {
  const content: Exclude<AssistantBlock, string> = [];
  if (text) content.push({ type: "text", text });
  for (const c of calls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
  return [...(text ? [{ type: "text_delta", text } as LLMEvent] : []), { type: "done", stopReason, content }];
};

function fakeLlm(script: Script) {
  const requests: LLMStreamRequest[] = [];
  const llm: LLM = {
    stream(req) {
      const call = requests.length;
      requests.push({ ...req, messages: JSON.parse(JSON.stringify(req.messages)) });
      const out = script(req, call);
      return (async function* () {
        if (out instanceof Error) throw out;
        yield* out;
      })();
    },
    async json() {
      throw new Error("not used");
    },
  };
  return { llm, requests };
}

// ---- a fake tool -----------------------------------------------------------------------------------
let log: string[] = [];
const trRead: ToolDefinition = {
  name: "tr_read",
  effect: "read",
  schema: { name: "tr_read", description: "tr_read", input_schema: { type: "object", properties: {} } },
  validate: (raw) => (raw ?? {}) as any,
  label: (raw) => `tr_read:${(raw as any)?.x ?? ""}`,
  run: async (input: any) => {
    log.push(`tr_read:${input.x}`);
    return { content: `tr_read result ${input.x}` };
  },
};
beforeAll(() => registerTool(trRead));
afterAll(() => unregisterTool("tr_read"));
beforeEach(() => {
  log = [];
});

const base = { system: [{ type: "text" as const, text: "sys" }], messages: [{ role: "user" as const, content: "hi" }] };

function spy() {
  const tokens: string[] = [];
  const statuses: string[] = [];
  const truncations: unknown[] = [];
  const callbacks: LoopCallbacks = {
    onToken: (t) => tokens.push(t),
    onStatus: (t) => statuses.push(t),
    onTruncation: (p) => truncations.push(p),
  };
  return { tokens, statuses, truncations, callbacks, streamed: () => tokens.join("") };
}

type Msg = { role: string; content: unknown };
const blocks = (m: Msg) => (Array.isArray(m.content) ? (m.content as { type: string; id?: string; tool_use_id?: string; text?: string }[]) : []);
const textOf = (m: Msg) => (typeof m.content === "string" ? m.content : blocks(m).map((b) => (b.type === "text" ? b.text ?? "" : "")).join(""));

const CUT_NOTE = "(The answer was cut off at the length limit.)";

// ---- config --------------------------------------------------------------------------------------
describe("MAX_OUTPUT_TOKENS", () => {
  it("defaults to 4096 and is bounded to 256..32000", () => {
    expect(envSchema.parse({}).MAX_OUTPUT_TOKENS).toBe(4096);
    expect(envSchema.parse({ MAX_OUTPUT_TOKENS: "8000" }).MAX_OUTPUT_TOKENS).toBe(8000);
    expect(envSchema.safeParse({ MAX_OUTPUT_TOKENS: "100" }).success).toBe(false);
    expect(envSchema.safeParse({ MAX_OUTPUT_TOKENS: "40000" }).success).toBe(false);
    expect(envSchema.safeParse({ MAX_OUTPUT_TOKENS: "12.5" }).success).toBe(false);
  });
});

// ---- OpenAI-compatible adapter ---------------------------------------------------------------------
const sse = (...chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
const okSse = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
const TEXT_STREAM = sse(
  { choices: [{ index: 0, delta: { content: "Hel" } }] },
  { choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
);

async function collect(llm: LLM, extra: Partial<LLMStreamRequest> = {}): Promise<LLMEvent[]> {
  const out: LLMEvent[] = [];
  for await (const ev of llm.stream({ system: [{ type: "text", text: "sys" }], messages: [{ role: "user", content: "hi" }], model: "m", ...extra })) out.push(ev);
  return out;
}
const doneOf = (evs: LLMEvent[]) => evs.find((e) => e.type === "done") as Extract<LLMEvent, { type: "done" }>;

describe("openai adapter: output limit and usage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const bodyOf = (i: number) => JSON.parse((fetchMock.mock.calls[i]![1] as { body: string }).body) as Record<string, unknown>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("defaults max_tokens to MAX_OUTPUT_TOKENS (not 1500); an explicit maxTokens still wins", async () => {
    fetchMock.mockImplementation(async () => okSse(TEXT_STREAM));
    const llm = createOpenAILlm("test-key");
    await collect(llm);
    expect(bodyOf(0).max_tokens).toBe(getConfig().MAX_OUTPUT_TOKENS);
    await collect(llm, { maxTokens: 777 });
    expect(bodyOf(1).max_tokens).toBe(777);
  });

  it("asks for usage and reports it on the done event", async () => {
    fetchMock.mockImplementation(async () => okSse(TEXT_STREAM));
    const evs = await collect(createOpenAILlm("test-key"));
    expect(bodyOf(0).stream_options).toEqual({ include_usage: true });
    expect(evs.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text)).toEqual(["Hel", "lo"]);
    const done = doneOf(evs);
    expect(done.stopReason).toBe("end_turn");
    expect(done.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
  });

  it("leaves usage undefined when the provider sends none", async () => {
    fetchMock.mockImplementation(async () => okSse(sse({ choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }] })));
    const done = doneOf(await collect(createOpenAILlm("test-key")));
    expect(done.usage).toBeUndefined();
  });

  it("maps finish_reason 'length' to max_tokens, also when a tool call was cut off mid-arguments", async () => {
    fetchMock.mockImplementationOnce(async () => okSse(sse({ choices: [{ index: 0, delta: { content: "long" }, finish_reason: "length" }] })));
    fetchMock.mockImplementationOnce(async () =>
      okSse(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "calculate", arguments: '{"expre' } }] }, finish_reason: "length" }] })),
    );
    const llm = createOpenAILlm("test-key");
    expect(doneOf(await collect(llm)).stopReason).toBe("max_tokens");
    const cutTool = doneOf(await collect(llm));
    expect(cutTool.stopReason).toBe("max_tokens");
    expect((cutTool.content as { type: string }[]).some((b) => b.type === "tool_use")).toBe(true);
  });

  it("retries once without stream_options when the provider rejects it with a 400, and remembers that", async () => {
    fetchMock.mockImplementationOnce(async () => new Response('{"error":{"message":"Unrecognized request argument supplied: stream_options"}}', { status: 400 }));
    fetchMock.mockImplementation(async () => okSse(TEXT_STREAM));
    const llm = createOpenAILlm("test-key");
    const done = doneOf(await collect(llm));
    expect(done.stopReason).toBe("end_turn");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(0).stream_options).toEqual({ include_usage: true });
    expect(bodyOf(1)).not.toHaveProperty("stream_options");
    await collect(llm);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(bodyOf(2)).not.toHaveProperty("stream_options");
  });

  it("does not retry a 400 that is not about stream_options", async () => {
    fetchMock.mockImplementation(async () => new Response('{"error":"model not found"}', { status: 400 }));
    await expect(collect(createOpenAILlm("test-key"))).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries only once: a second stream_options 400 is an error", async () => {
    fetchMock.mockImplementation(async () => new Response("unknown parameter: stream_options", { status: 400 }));
    await expect(collect(createOpenAILlm("test-key"))).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ---- Anthropic adapter (SDK replaced for this test only) ------------------------------------------
describe("anthropic adapter: output limit and usage", () => {
  const seen: Record<string, unknown>[] = [];
  beforeEach(() => {
    seen.length = 0;
    vi.resetModules();
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          stream: (params: Record<string, unknown>) => {
            seen.push(params);
            const events = [
              { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
              { type: "message_stop" },
            ];
            return {
              async *[Symbol.asyncIterator]() {
                yield* events;
              },
              finalMessage: async () => ({
                content: [{ type: "text", text: "hi" }],
                stop_reason: "max_tokens",
                usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 4 },
              }),
            };
          },
        };
      },
    }));
  });
  afterEach(() => {
    vi.doUnmock("@anthropic-ai/sdk");
    vi.resetModules();
  });

  it("keeps max_tokens at least 8192 and reports usage (cached input included) from finalMessage()", async () => {
    const { createAnthropicLlm } = await import("../src/llm/anthropic.js");
    const done = doneOf(await collect(createAnthropicLlm("test-key")));
    expect(seen[0]!.max_tokens).toBe(8192);
    expect(done.stopReason).toBe("max_tokens");
    expect(done.usage).toEqual({ inputTokens: 104, outputTokens: 5 });
  });

  it("uses MAX_OUTPUT_TOKENS when it is above 8192", async () => {
    const prev = process.env.MAX_OUTPUT_TOKENS;
    process.env.MAX_OUTPUT_TOKENS = "16000";
    try {
      const { createAnthropicLlm } = await import("../src/llm/anthropic.js");
      await collect(createAnthropicLlm("test-key"));
      expect(seen[0]!.max_tokens).toBe(16000);
    } finally {
      if (prev === undefined) delete process.env.MAX_OUTPUT_TOKENS;
      else process.env.MAX_OUTPUT_TOKENS = prev;
    }
  });
});

// ---- loop: a cut-off answer is continued once ------------------------------------------------------
describe("loop: answer cut off at the length limit", () => {
  it("continues once and streams the rest into the same answer", async () => {
    const { llm, requests } = fakeLlm((_req, call) => (call === 0 ? cut("Part one of the ans") : say("wer. Part two.")));
    const s = spy();
    const res = await runAgentLoop({ llm, ...base, callbacks: s.callbacks });
    expect(res.answer).toBe("Part one of the answer. Part two.");
    expect(s.streamed()).toBe(res.answer);
    expect(requests).toHaveLength(2);
    expect(res.steps).toBe(1);

    // The continuation request: no tools, the partial answer as the assistant turn, then a short user nudge.
    const cont = requests[1]!;
    expect(cont.tools).toBeUndefined();
    const msgs = cont.messages as Msg[];
    expect(msgs.at(-1)).toEqual({ role: "user", content: "Continue exactly where you stopped." });
    expect(msgs.at(-2)!.role).toBe("assistant");
    expect(textOf(msgs.at(-2)!)).toBe("Part one of the ans");
    expect(msgs.flatMap(blocks).some((b) => b.type === "tool_use")).toBe(false);
    // OpenAI-compatible shape stays valid: system, user, assistant, user.
    expect(toOpenAIMessages(cont.system, cont.messages as unknown[]).map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);

    expect(s.statuses.some((t) => /length limit/i.test(t))).toBe(true);
    expect(s.truncations).toEqual([{ step: 1, kind: "answer", action: "continue" }]);
  });

  it("drops text the continuation repeats from the cut-off tail (no duplicated text)", async () => {
    const { llm } = fakeLlm((_req, call) => (call === 0 ? cut("The quick brown fox jumps over") : say(" fox jumps over the lazy dog.")));
    const s = spy();
    const res = await runAgentLoop({ llm, ...base, callbacks: s.callbacks });
    expect(res.answer).toBe("The quick brown fox jumps over the lazy dog.");
    expect(s.streamed()).toBe(res.answer);
  });

  it("does not trim a continuation that merely starts like the tail", async () => {
    const { llm } = fakeLlm((_req, call) => (call === 0 ? cut("Total: 4") : say("2 apples.")));
    const s = spy();
    const res = await runAgentLoop({ llm, ...base, callbacks: s.callbacks });
    expect(res.answer).toBe("Total: 42 apples.");
    expect(s.streamed()).toBe(res.answer);
  });

  it("appends a visible note when the continuation is cut off too, and continues only once", async () => {
    const { llm, requests } = fakeLlm((_req, call) => (call === 0 ? cut("First half, ") : cut("second half")));
    const s = spy();
    const res = await runAgentLoop({ llm, ...base, callbacks: s.callbacks });
    expect(requests).toHaveLength(2);
    expect(res.answer.startsWith("First half, second half")).toBe(true);
    expect(res.answer.endsWith(CUT_NOTE)).toBe(true);
    expect(s.streamed()).toBe(res.answer);
    expect(s.truncations).toEqual([
      { step: 1, kind: "answer", action: "continue" },
      { step: 1, kind: "answer", action: "gave_up" },
    ]);
  });

  it("keeps the partial answer (with the note) when the continuation request fails", async () => {
    const { llm } = fakeLlm((_req, call) => (call === 0 ? cut("Partial answer") : Object.assign(new Error("bad request"), { status: 400 })));
    const s = spy();
    const res = await runAgentLoop({ llm, ...base, callbacks: s.callbacks });
    expect(res.answer.startsWith("Partial answer")).toBe(true);
    expect(res.answer.endsWith(CUT_NOTE)).toBe(true);
    expect(s.streamed()).toBe(res.answer);
  });

  it("continues a cut-off answer on the last step too (tools withheld)", async () => {
    const { llm, requests } = fakeLlm((_req, call) => (call === 0 ? cut("Short and ") : say("complete.")));
    const res = await runAgentLoop({ llm, ...base, limits: { maxSteps: 1 } });
    expect(requests[0]!.tools).toBeUndefined();
    expect(res.answer).toBe("Short and complete.");
  });
});

// ---- loop: a tool call cut off mid-arguments is never executed ---------------------------------------
describe("loop: tool call cut off at the length limit", () => {
  it("does not run the partial call; retries the step once and runs the complete call", async () => {
    const { llm, requests } = fakeLlm((_req, call) => {
      if (call === 0) return use([{ id: "p1", name: "tr_read", input: { x: "par" } }], "max_tokens");
      if (call === 1) return use([{ id: "c1", name: "tr_read", input: { x: "full" } }]);
      return say("done");
    });
    const s = spy();
    const res = await runAgentLoop({ llm, ...base, callbacks: s.callbacks });
    expect(res.answer).toBe("done");
    expect(log).toEqual(["tr_read:full"]);
    expect(res.toolCalls.map((c) => c.id)).toEqual(["c1"]);

    // The retry did not see the cut-off call, and was told why it is asked again.
    const retry = requests[1]!.messages as Msg[];
    expect(retry.flatMap(blocks).some((b) => b.id === "p1")).toBe(false);
    expect(retry).toHaveLength(1);
    expect(textOf(retry[0]!)).toMatch(/^hi\b/);
    expect(textOf(retry[0]!)).toMatch(/cut off/i);

    // The nudge was for the retry only; the history the model sees next is clean and paired.
    const next = requests[2]!.messages as Msg[];
    expect(next[0]).toEqual({ role: "user", content: "hi" });
    expect(next.flatMap(blocks).some((b) => b.id === "p1" || b.tool_use_id === "p1")).toBe(false);
    const useIds = blocks(next[1]!).filter((b) => b.type === "tool_use").map((b) => b.id);
    const resIds = blocks(next[2]!).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id);
    expect(useIds).toEqual(["c1"]);
    expect(resIds).toEqual(useIds);

    expect(s.statuses.some((t) => /cut off/i.test(t))).toBe(true);
    expect(s.truncations).toEqual([{ step: 1, kind: "tool_call", action: "retry" }]);
  });

  it("merges the retry nudge into a tool_result message without breaking tool pairing", async () => {
    const { llm, requests } = fakeLlm((_req, call) => {
      if (call === 0) return use([{ id: "a1", name: "tr_read", input: { x: "1" } }]);
      if (call === 1) return use([{ id: "p2", name: "tr_read", input: { x: "par" } }], "max_tokens");
      if (call === 2) return use([{ id: "c2", name: "tr_read", input: { x: "2" } }]);
      return say("ok");
    });
    const res = await runAgentLoop({ llm, ...base });
    expect(res.answer).toBe("ok");
    expect(log).toEqual(["tr_read:1", "tr_read:2"]);
    const retry = requests[2]!.messages as Msg[];
    const last = blocks(retry.at(-1)!);
    expect(last[0]).toMatchObject({ type: "tool_result", tool_use_id: "a1" });
    expect(last.at(-1)!.type).toBe("text");
    // OpenAI-compatible: the tool message still directly follows its tool call.
    const oa = toOpenAIMessages(requests[2]!.system, retry as unknown[]);
    const ai = oa.findIndex((m) => m.role === "assistant");
    expect(oa[ai + 1]).toMatchObject({ role: "tool", tool_call_id: "a1" });
  });

  it("gives up on a call cut off twice: nothing runs and no unpaired tool_use reaches the model", async () => {
    const { llm, requests } = fakeLlm((_req, call) => {
      if (call <= 1) return use([{ id: `p${call}`, name: "tr_read", input: { x: "par" } }], "max_tokens", "Let me check. ");
      return say("best effort answer");
    });
    const s = spy();
    const res = await runAgentLoop({ llm, ...base, callbacks: s.callbacks });
    expect(log).toEqual([]);
    expect(res.toolCalls).toEqual([]);
    expect(res.answer).toBe("best effort answer");
    for (const r of requests) expect((r.messages as Msg[]).flatMap(blocks).some((b) => b.type === "tool_use")).toBe(false);
    expect(s.truncations).toEqual([
      { step: 1, kind: "tool_call", action: "retry" },
      { step: 1, kind: "tool_call", action: "gave_up" },
    ]);
  });
});

describe("overlapLength", () => {
  it("finds the repeated tail, ignoring short coincidences", () => {
    expect(overlapLength("The quick brown fox jumps over", " fox jumps over the lazy dog")).toBe(" fox jumps over".length);
    expect(overlapLength("Total: 4", "2 apples")).toBe(0);
    expect(overlapLength("ends with the", "the next")).toBe(0);
    expect(overlapLength("", "anything")).toBe(0);
  });
});
