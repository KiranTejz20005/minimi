import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import type { Clock } from "../clock.js";
import type { SystemBlock } from "../llm/types.js";
import type { MessageRow } from "../memory/store.js";
import { buildSystem } from "./prompts.js";

const HISTORY_LIMIT = 12;

function wrapUserMessage(text: string): string {
  const body = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<user_message>${body}</user_message>`;
}

export interface BuiltContext {
  system: SystemBlock[];
  messages: MessageParam[];
}

export function buildContext(opts: {
  clock: Clock;
  tz: string;
  history: MessageRow[];
  userMessage: string;
  memoryXml?: string;
}): BuiltContext {
  const system = buildSystem(opts.clock, opts.tz);
  const prior = opts.history.slice(-HISTORY_LIMIT);
  const messages: MessageParam[] = prior.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let userText = wrapUserMessage(opts.userMessage.trim());
  if (opts.memoryXml?.trim()) {
    userText = `${opts.memoryXml.trim()}\n\n${userText}`;
  }

  messages.push({ role: "user", content: userText });
  return { system, messages };
}
