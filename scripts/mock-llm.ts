import type { AssistantBlock, LLM, LLMEvent, LLMStreamRequest } from "../src/llm/types.js";

export type ScriptedLlmStep =
  | { kind: "tools"; calls: { id: string; query: string; domains?: string[] }[] }
  | { kind: "answer"; text: string };

export function createScriptedLlm(steps: ScriptedLlmStep[]): LLM {
  let call = 0;
  return {
    async *stream(_req: LLMStreamRequest): AsyncIterable<LLMEvent> {
      const step = steps[call++] ?? steps[steps.length - 1]!;
      if (step.kind === "tools") {
        const content: AssistantBlock = step.calls.map((c) => ({
          type: "tool_use" as const,
          id: c.id,
          name: "web_search",
          input: {
            query: c.query,
            ...(c.domains?.length ? { domains: c.domains } : {}),
          },
        }));
        yield {
          type: "done",
          stopReason: "tool_use",
          content,
        };
        return;
      }
      for (const ch of step.text) yield { type: "text_delta", text: ch };
      yield {
        type: "done",
        stopReason: "end_turn",
        content: [{ type: "text", text: step.text }],
      };
    },
    async json<T>(): Promise<T> {
      throw new Error("mock json not implemented");
    },
  };
}

export function mockLlmPlain(reply: string): LLM {
  return createScriptedLlm([{ kind: "answer", text: reply }]);
}
