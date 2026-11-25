import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { getConfig } from "../config.js";
import { fetchUrlTool } from "./fetch-url.js";
import { lookupClaimsTool } from "./lookup-claims.js";
import { memorySearchTool } from "./memory-search.js";
import { webSearchTool } from "./web-search.js";
import { calculateTool } from "./calculate.js";
import { readAttachmentTool } from "./read-attachment.js";
import { saveMemoryTool } from "./save-memory.js";
import { weatherTool } from "./weather.js";
import { currencyTool } from "./currency.js";
import {
  ToolInputError,
  type ToolContext,
  type ToolDefinition,
  type ToolExecResult,
  type ToolSearchMeta,
} from "./types.js";

export { ToolInputError };
export type { ToolContext, ToolDefinition, ToolExecResult };

/**
 * Single source of truth for the tools the model can call.
 * To add a tool: export a ToolDefinition from its own file and list it here. That is the whole integration:
 * the schema the model sees, validation, limits, timeouts, approvals, UI labels and dispatch all derive from it.
 */
const BUILTIN_TOOLS: ToolDefinition[] = [
  webSearchTool,
  fetchUrlTool,
  memorySearchTool,
  lookupClaimsTool,
  calculateTool,
  readAttachmentTool,
  saveMemoryTool,
  weatherTool,
  currencyTool,
];

const tools = new Map<string, ToolDefinition>();

/** Live list handed to the LLM adapters. Mutated by registerTool so late registrations are visible. */
export const AGENT_TOOLS: Tool[] = [];

export function registerTool(def: ToolDefinition): void {
  if (def.name !== def.schema.name) throw new Error(`tool ${def.name}: schema.name is ${def.schema.name}`);
  if (tools.has(def.name)) throw new Error(`tool ${def.name} is already registered`);
  tools.set(def.name, def);
  AGENT_TOOLS.push(def.schema);
}

/** Test seam: remove a tool registered by a test. */
export function unregisterTool(name: string): void {
  tools.delete(name);
  const i = AGENT_TOOLS.findIndex((t) => t.name === name);
  if (i >= 0) AGENT_TOOLS.splice(i, 1);
}

export function getTool(name: string): ToolDefinition | undefined {
  return tools.get(name);
}

export function listTools(): ToolDefinition[] {
  return [...tools.values()];
}

for (const t of BUILTIN_TOOLS) registerTool(t);

/** UI/approval label for a call; safe for unknown tools and malformed input. */
export function labelForCall(name: string, input: unknown): string {
  const def = tools.get(name);
  try {
    const l = def?.label?.(input);
    if (l) return l;
  } catch {
    /* fall through */
  }
  return def?.actionLabel ?? name;
}

/** Max tool calls the loop will run in one step (the rest get an explicit "limit" result). */
export function stepToolBudget(): number {
  return Math.max(getConfig().MAX_SEARCHES_PER_STEP, 6);
}

export function maxPerTurn(def: ToolDefinition): number {
  const m = def.maxPerTurn;
  return typeof m === "function" ? m() : (m ?? Infinity);
}

/** Order-independent JSON so {a,b} and {b,a} dedupe to the same key. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function defaultError(name: string, error: string): string {
  return `<tool_error name="${esc(name)}" error="${esc(error)}"/>`;
}

function searchMeta(def: ToolDefinition | undefined, label: string, error: string): ToolSearchMeta | undefined {
  return def?.isSearch ? { query: label, count: 0, cached: false, error, results: [] } : undefined;
}

function failed(
  call: { id: string; name: string },
  def: ToolDefinition | undefined,
  label: string,
  error: string,
  ms = 0,
): ToolExecResult {
  return {
    id: call.id,
    name: call.name,
    label,
    ms,
    error,
    content: def?.errorContent ? def.errorContent(label, error) : defaultError(call.name, error),
    search: searchMeta(def, label, error),
  };
}

/** Errors worth one more try: network blips, 429/5xx, timeouts of an upstream. Never user mistakes. */
export function isTransientError(msg: string): boolean {
  return /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|HTTP (429|5\d\d)|\b(429|502|503|504)\b/i.test(
    msg,
  );
}

/** Settles with the promise, or rejects with an AbortError as soon as `signal` aborts (the promise is left to finish on its own). */
function raceAbort<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
      (e) => (signal.removeEventListener("abort", onAbort), reject(e)),
    );
  });
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Generic dispatcher. Order: lookup → decline → resources → validate → duplicate → per-turn limit → run
 * (timeout + bounded retry for read tools) → count. Never throws: every failure becomes a tool result the
 * model can read, so one tool failing never takes down its parallel siblings.
 */
export async function executeToolCall(
  call: { id: string; name: string; input: unknown },
  ctx: ToolContext,
  allowed: boolean,
): Promise<ToolExecResult> {
  const def = tools.get(call.name);
  const label = labelForCall(call.name, call.input);
  if (!def) return failed(call, undefined, label, "unknown tool");

  if (!allowed) {
    return {
      id: call.id,
      name: call.name,
      label,
      ms: 0,
      declined: true,
      error: "declined by user",
      content: def.declined ? def.declined(label) : defaultError(call.name, "declined by user"),
      search: searchMeta(def, label, "declined by user"),
    };
  }

  for (const need of def.needs ?? []) {
    if (need === "db" && !ctx.db) return failed(call, def, label, "memory database unavailable");
  }

  let input: unknown;
  try {
    input = def.validate(call.input);
  } catch (e) {
    const msg = e instanceof ToolInputError ? e.message : `invalid ${call.name} input`;
    return failed(call, def, label, msg);
  }

  // Duplicate prevention: identical read-only call earlier this turn → reuse the answer, don't re-run.
  const seen = (ctx.seen ??= new Map());
  const key = def.effect === "write" ? null : `${call.name}:${def.dedupeKey ? def.dedupeKey(input) : stableStringify(input)}`;
  const prior = key ? seen.get(key) : undefined;
  if (prior) return { ...prior, id: call.id, ms: 0, duplicate: true };

  const limit = maxPerTurn(def);
  if ((ctx.counts[call.name] ?? 0) >= limit) {
    return failed(call, def, label, `${call.name} limit reached for this turn`);
  }

  ctx.counts[call.name] = (ctx.counts[call.name] ?? 0) + 1; // before any await: parallel siblings must see it
  const t0 = Date.now();
  const attempts = def.effect === "write" ? 1 : 1 + Math.max(0, def.retry?.retries ?? 0);
  let out: ToolExecResult | null = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const signals = [ctx.signal, def.timeoutMs ? AbortSignal.timeout(def.timeoutMs) : undefined].filter(
      (s): s is AbortSignal => !!s,
    );
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    let error: string | undefined;
    try {
      // Race the turn's cancel signal: a tool that ignores its signal must not keep a cancelled turn waiting.
      const res = await raceAbort(def.run(input, { ...ctx, signal }), ctx.signal);
      out = {
        id: call.id,
        name: call.name,
        label: res.label || label,
        content: res.content,
        ms: Date.now() - t0,
        error: res.error,
        search: res.search,
      };
      error = res.error;
    } catch (e) {
      const aborted = ctx.signal?.aborted;
      error = aborted
        ? "cancelled"
        : e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
          ? `timeout after ${Math.round((def.timeoutMs ?? 0) / 1000)}s`
          : e instanceof Error
            ? e.message
            : "tool failed";
      out = failed(call, def, label, error, Date.now() - t0);
    }
    const retryable = !!error && !ctx.signal?.aborted && attempt < attempts - 1 && isTransientError(error);
    if (!retryable) break;
    await sleep((def.retry?.backoffMs ?? 300) * (attempt + 1), ctx.signal);
  }

  const result = out!;
  // Only successful results are reusable; a failed call may legitimately be retried by the model.
  if (key && !result.error) seen.set(key, result);
  return result;
}
