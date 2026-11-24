import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import type { Clock } from "../clock.js";
import { getConfig } from "../config.js";
import type { SystemBlock } from "../llm/types.js";
import type { MessageRow } from "../memory/store.js";
import { buildSystem } from "./prompts.js";

const CHARS_PER_TOKEN = 3.5;
/** Smallest slice of budget worth spending on a truncated older message. */
const MIN_PARTIAL_TOKENS = 120;
/** Hard cap on the text of the new user message (attachment manifest + question), in characters. */
const MAX_USER_CONTEXT_CHARS = 48_000;

/** Cheap token estimate (no tokenizer dependency): ~3.5 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function wrapUserMessage(text: string): string {
  const body = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<user_message>${body}</user_message>`;
}

/** Shorten to ~maxChars keeping the head and (a smaller) tail, with an explicit marker. */
function truncateMiddle(text: string, maxChars: number, tailShare = 0.25): string {
  if (text.length <= maxChars) return text;
  const tail = Math.floor(maxChars * tailShare);
  const head = maxChars - tail;
  const cut = text.length - head - tail;
  return `${text.slice(0, head)}\n…[truncated ${cut} characters]…\n${tail > 0 ? text.slice(text.length - tail) : ""}`;
}

export interface BuiltContext {
  system: SystemBlock[];
  messages: MessageParam[];
}

type Turn = { role: "user" | "assistant"; content: string };

/**
 * Pick the history that fits the token budget: newest first, the latest exchange always kept (each of its
 * messages capped at half the budget), older messages truncated with a marker when they only partly fit.
 */
function selectHistory(history: MessageRow[], budgetTokens: number): Turn[] {
  const rows = history.filter((m) => m.content?.trim());
  const picked: Turn[] = [];
  let used = 0;
  const latestCount = Math.min(rows.length, 2);
  let firstIdx = rows.length;
  for (let i = rows.length - 1; i >= 0; i--) {
    firstIdx = i;
    const m = rows[i]!;
    const isLatest = rows.length - i <= latestCount;
    let content = m.content;
    if (isLatest) {
      content = truncateMiddle(content, Math.floor((budgetTokens * CHARS_PER_TOKEN) / 2));
      used += estimateTokens(content);
    } else {
      const remaining = budgetTokens - used;
      const cost = estimateTokens(content);
      if (cost > remaining) {
        if (remaining < MIN_PARTIAL_TOKENS) break;
        content = truncateMiddle(content, Math.floor(remaining * CHARS_PER_TOKEN), 0.2);
        picked.push({ role: m.role, content });
        break;
      }
      used += cost;
    }
    picked.push({ role: m.role, content });
  }
  // A kept assistant message with no user message before it would be dropped later: keep a short stub of the question.
  const prev = rows[firstIdx - 1];
  if (picked.at(-1)?.role === "assistant" && prev?.role === "user") {
    picked.push({ role: "user", content: truncateMiddle(prev.content, 400) });
  }
  return picked.reverse();
}

/** Anthropic requires the first message to be a user message and roles to alternate: drop/merge to guarantee it. */
function normalizeRoles(turns: Turn[]): Turn[] {
  const out: Turn[] = [];
  for (const t of turns) {
    const last = out.at(-1);
    if (!last && t.role !== "user") continue;
    if (last && last.role === t.role) last.content = `${last.content}\n\n${t.content}`;
    else out.push({ ...t });
  }
  return out;
}

export function buildContext(opts: {
  clock: Clock;
  tz: string;
  history: MessageRow[];
  userMessage: string;
  /** Recalled earlier conversations (<memory> block). */
  memoryXml?: string;
  /** Facts the user asked to keep (<saved_memories> block, rendered by src/memory/saved.ts). */
  savedMemoryXml?: string;
  /** Compact results of tools run in earlier turns of this chat (see tool-history.ts). */
  previousToolResultsXml?: string;
  customInstructions?: string;
  /** Override for the history token budget (default: HISTORY_TOKEN_BUDGET config). */
  historyTokenBudget?: number;
}): BuiltContext {
  const system = buildSystem(opts.clock, opts.tz, opts.customInstructions);
  const budget = opts.historyTokenBudget ?? getConfig().HISTORY_TOKEN_BUDGET;
  const turns = selectHistory(opts.history, budget);

  const blocks = [opts.savedMemoryXml, opts.memoryXml, opts.previousToolResultsXml]
    .map((b) => b?.trim())
    .filter((b): b is string => !!b);
  const userBody = truncateMiddle(opts.userMessage.trim(), MAX_USER_CONTEXT_CHARS, 0.4);
  turns.push({ role: "user", content: [...blocks, wrapUserMessage(userBody)].join("\n\n") });

  const messages: MessageParam[] = normalizeRoles(turns).map((t) => ({ role: t.role, content: t.content }));
  return { system, messages };
}
