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

export type LLMEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | {
      type: "done";
      stopReason: string | null;
      content: AssistantBlock;
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
