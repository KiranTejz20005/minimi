import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageParam,
  RawContentBlockStartEvent,
  RawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { getConfig } from "../config.js";
import type {
  AssistantBlock,
  LLM,
  LLMEvent,
  LLMJsonRequest,
  LLMStreamRequest,
  NormalizedToolCall,
} from "./types.js";

type PartialTool = { id: string; name: string; json: string };

function extractToolCalls(content: AssistantBlock): NormalizedToolCall[] {
  if (!Array.isArray(content)) return [];
  const out: NormalizedToolCall[] = [];
  for (const block of content) {
    if (block.type === "tool_use") {
      out.push({ id: block.id, name: block.name, input: block.input });
    }
  }
  return out;
}

export { extractToolCalls };

export function createAnthropicLlm(apiKey?: string): LLM {
  const cfg = getConfig();
  const key = apiKey ?? cfg.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }
  const client = new Anthropic({ apiKey: key });

  return {
    async *stream(req: LLMStreamRequest): AsyncIterable<LLMEvent> {
      const stream = client.messages.stream(
        {
          model: req.model,
          max_tokens: req.maxTokens ?? 8_192,
          system: req.system,
          messages: req.messages as MessageParam[],
          tools: req.tools,
          ...(req.forceTool && req.tools?.length ? { tool_choice: { type: "any" } } : {}),
          thinking: { type: "between_tools" },
          output_config: { effort: "medium" },
        } as unknown as Parameters<typeof client.messages.stream>[0],
        { signal: req.signal },
      );

      const tools = new Map<number, PartialTool>();
      let currentToolIndex: number | null = null;

      for await (const event of stream as AsyncIterable<RawMessageStreamEvent>) {
        if (event.type === "content_block_start") {
          const start = event as RawContentBlockStartEvent;
          if (start.content_block.type === "tool_use") {
            currentToolIndex = start.index;
            tools.set(start.index, {
              id: start.content_block.id,
              name: start.content_block.name,
              json: "",
            });
          }
        } else if (event.type === "content_block_delta") {
          const d = event.delta;
          if (d.type === "text_delta" && d.text) {
            yield { type: "text_delta", text: d.text };
          } else if (d.type === "thinking_delta" && d.thinking) {
            yield { type: "thinking_delta", text: d.thinking };
          } else if (d.type === "input_json_delta" && currentToolIndex !== null) {
            const t = tools.get(currentToolIndex);
            if (t) t.json += d.partial_json;
          }
        } else if (event.type === "content_block_stop") {
          currentToolIndex = null;
        } else if (event.type === "message_stop") {
          break;
        }
      }

      const final = await stream.finalMessage();
      const content = final.content as unknown as AssistantBlock;

      yield {
        type: "done",
        stopReason: final.stop_reason,
        content,
      };
    },

    async json<T>(req: LLMJsonRequest): Promise<T> {
      const res = await client.messages.create({
        model: req.model,
        max_tokens: 2048,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
      }, { signal: req.signal });
      const text =
        res.content.find((c) => c.type === "text")?.text?.trim() ?? "";
      const cleaned = text
        .replace(/^```json\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      return JSON.parse(cleaned) as T;
    },
  };
}

/** Anthropic if its key is set, otherwise the OpenAI-compatible (NVIDIA) provider. */
export async function createLlm(): Promise<LLM> {
  const cfg = getConfig();
  if (cfg.ANTHROPIC_API_KEY?.trim()) return createAnthropicLlm();
  const { createOpenAILlm } = await import("./openai.js");
  return createOpenAILlm();
}

export function defaultMainModel(): string {
  return getConfig().MODEL_MAIN;
}
