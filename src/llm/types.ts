import type {
  ContentBlockParam,
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";

export type CacheControl = { type: "ephemeral" };

export type SystemBlock = {
  type: "text";
  text: string;
  cache_control?: CacheControl;
};

/** Full assistant content from one model step (text, thinking, tool_use). */
export type AssistantBlock =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "thinking"; thinking: string }
      | { type: "redacted_thinking"; data: string }
      | { type: "tool_use"; id: string; name: string; input: unknown }
    >;

/** Provider-reported token counts for one model call (input includes cached prompt tokens). */
export type TokenUsage = { inputTokens: number; outputTokens: number };

export type LLMEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | {
      type: "done";
      /** "max_tokens" = cut off at the output limit (the loop continues or retries; see agent/loop.ts). */
      stopReason: string | null;
      content: AssistantBlock;
      /** Absent when the provider did not report usage. */
      usage?: TokenUsage;
    };

export interface LLMStreamRequest {
  system: SystemBlock[];
  messages: MessageParam[];
  tools?: Tool[];
  model: string;
  signal?: AbortSignal;
  maxTokens?: number;
  /** Require the model to call a tool this step (used to force web search on time-sensitive questions). */
  forceTool?: boolean;
  /** When set with forceTool, require this specific tool (e.g. web_search). Read by anthropic.ts / openai.ts. */
  forceToolName?: string;
}

export interface LLMJsonRequest {
  system: string;
  user: string;
  model: string;
  signal?: AbortSignal;
}

export interface LLM {
  stream(req: LLMStreamRequest): AsyncIterable<LLMEvent>;
  json<T>(req: LLMJsonRequest): Promise<T>;
}

export interface NormalizedToolCall {
  id: string;
  name: string;
  input: unknown;
}
