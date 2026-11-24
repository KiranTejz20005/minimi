import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import type { DatabaseSync } from "node:sqlite";
import type { SearchProvider } from "../search/types.js";
import { getConfig } from "../config.js";
import { defaultMainModel, extractToolCalls } from "../llm/anthropic.js";
import type { LLM } from "../llm/types.js";
import type { AssistantBlock, LLMEvent, SystemBlock } from "../llm/types.js";
import { MemoryStore } from "../memory/store.js";
import { TurnCitationRegistry } from "../search/tool.js";
import {
  AGENT_TOOLS,
  executeToolCall,
  getTool,
  isTransientError,
  labelForCall,
  stableStringify,
  stepToolBudget,
  type ToolContext,
  type ToolExecResult,
} from "../tools/registry.js";
import { PermissionGate, type ApprovalAction, type ApprovalMode } from "./permissions.js";

export interface LoopCallbacks {
  onStatus?: (text: string) => void;
  onSearchStart?: (queries: string[], ids?: string[]) => void;
  onSearchDone?: (payload: {
    query: string;
    count: number;
    ms: number;
    cached: boolean;
    callId?: string;
    results?: { title: string; url: string }[];
    error?: string;
    /** Answered from an identical call earlier in this turn (nothing was re-run). */
    duplicate?: true;
  }) => void;
  onToolStart?: (tools: { id: string; tool: string; label: string }[]) => void;
  onToolDone?: (payload: {
    id: string;
    tool: string;
    label: string;
    ms: number;
    error?: string;
    /** Answered from an identical call earlier in this turn (nothing was re-run). */
    duplicate?: true;
  }) => void;
  /**
   * One request per step for every gated call of that step; the answer is all-or-nothing for the batch.
   * Each action is `{ tool, label, verb }` (verb = the tool's actionLabel, e.g. "Fetch page").
   */
  requestApproval?: (actions: ApprovalAction[]) => Promise<boolean>;
  onSearchBatch?: (payload: {
    step: number;
    queryCount: number;
    batchDurationMs: number;
    queries: { query: string; durationMs: number }[];
  }) => void;
  onToken?: (text: string) => void;
}

/** A tool call the loop actually executed this turn (duplicates and budget-dropped calls are not listed). */
export interface ExecutedToolCall {
  id: string;
  name: string;
  label: string;
  input: unknown;
  content: string;
  error?: string;
  ms: number;
}

export interface AgentLoopResult {
  answer: string;
  registry: TurnCitationRegistry;
  steps: number;
  /** Executed (non-duplicate) calls of search tools. */
  searches: number;
  toolCalls: ExecutedToolCall[];
  /** Which budget forced the final answer, if any. */
  budget?: "steps" | "tool_calls";
}

export type LoopLimits = {
  /** Model<->tool rounds; the last step has no tools. Default: MAX_STEPS. */
  maxSteps?: number;
  /** Executed tool calls per turn across all tools. Default: MAX_TOOL_CALLS_PER_TURN. */
  maxToolCalls?: number;
  /** Concurrent tool calls inside one step. Default: MAX_PARALLEL_TOOLS. */
  maxParallel?: number;
  /** Pause before the single retry of a transient LLM failure. Default 300ms. */
  llmRetryDelayMs?: number;
};

function toolResultBlocks(
  calls: { id: string; content: string }[],
): MessageParam {
  return {
    role: "user",
    content: calls.map((c) => ({
      type: "tool_result" as const,
      tool_use_id: c.id,
      content: c.content,
    })),
  };
}

function abortError(): Error {
  const e = new Error("The turn was cancelled");
  e.name = "AbortError";
  return e;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/** Resolve with `p`, or with `onAbort` as soon as the signal fires. `p` never causes an unhandled rejection. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined, onAbort: T): Promise<T> {
  p.catch(() => {});
  if (!signal) return p;
  if (signal.aborted) return Promise.resolve(onAbort);
  return new Promise<T>((resolve, reject) => {
    const done = () => resolve(onAbort);
    signal.addEventListener("abort", done, { once: true });
    p.then(
      (v) => (signal.removeEventListener("abort", done), resolve(v)),
      (e) => (signal.removeEventListener("abort", done), reject(e)),
    );
  });
}

/**
 * Transient (worth one more try): network failures, timeouts, 408/429/5xx (incl. 529 overloaded), a stream that
 * ended without its final event. Fatal: aborts and every other 4xx (bad request, auth, ...) and unknown shapes.
 */
export function classifyLlmError(err: unknown): "transient" | "fatal" {
  if (!err || typeof err !== "object") return "fatal";
  const e = err as { name?: string; message?: string; status?: unknown; statusCode?: unknown; response?: { status?: unknown }; cause?: unknown };
  if (e.name === "AbortError" || e.name === "APIUserAbortError") return "fatal";
  const raw = e.status ?? e.statusCode ?? e.response?.status ?? (e.cause as { status?: unknown } | undefined)?.status;
  const status = typeof raw === "number" ? raw : undefined;
  if (status !== undefined) return status === 408 || status === 429 || status >= 500 ? "transient" : "fatal";
  const msg = e.message ?? "";
  if (isTransientError(msg) || /stream ended without|overloaded|rate.?limit|connection (error|closed|reset|lost)|terminated|network|socket|ENOTFOUND|EPIPE|premature close/i.test(msg)) return "transient";
  return "fatal";
}

async function consumeStream(
  stream: AsyncIterable<LLMEvent>,
  callbacks: LoopCallbacks,
  emitAsAnswer: boolean,
  /** Hold back a tool-less answer (the caller may replace it with a forced search). */
  hold = false,
  /** Set once any token reached the client, so a failed step is not retried (it would duplicate text). */
  progress: { emitted: boolean } = { emitted: false },
): Promise<{ content: AssistantBlock; text: string }> {
  let buffered = "";
  let thinking = "";

  for await (const ev of stream) {
    if (ev.type === "text_delta") {
      buffered += ev.text;
      if (emitAsAnswer) {
        progress.emitted = true;
        callbacks.onToken?.(ev.text);
      }
    } else if (ev.type === "thinking_delta") {
      thinking += ev.text;
      const line = ev.text.trim();
      if (line) callbacks.onStatus?.(line);
    } else if (ev.type === "done") {
      const toolCalls = extractToolCalls(ev.content);
      const textFromBlocks = blockText(ev.content);
      const combined = textFromBlocks || buffered;

      if (toolCalls.length > 0) {
        const statusText = (combined + thinking).trim();
        if (statusText) callbacks.onStatus?.(statusText);
      } else if (!emitAsAnswer && buffered && !hold) {
        for (const ch of buffered) callbacks.onToken?.(ch);
      }

      return { content: ev.content, text: combined };
    }
  }

  throw new Error("LLM stream ended without done event");
}

function blockText(content: AssistantBlock): string {
  if (typeof content === "string") return content;
  let out = "";
  for (const b of content) {
    if (b.type === "text") out += b.text;
  }
  return out;
}

type Call = { id: string; name: string; input: unknown };

/** Same normalisation the dispatcher uses to memoise: calls with equal keys are the same call. null = never deduplicated. */
function dedupeKeyOf(c: Call): string | null {
  const def = getTool(c.name);
  if (!def || def.effect === "write") return null;
  try {
    const v = def.validate(c.input);
    return `${c.name}:${def.dedupeKey ? def.dedupeKey(v) : stableStringify(v)}`;
  } catch {
    return null; // invalid input: let the dispatcher produce its error
  }
}

function errorResult(c: Call, error: string, ms = 0): ToolExecResult {
  const label = labelForCall(c.name, c.input);
  const esc = error.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return { id: c.id, name: c.name, label, ms, error, content: `<tool_error name="${c.name}" error="${esc}"/>` };
}

/** Run `fn` over `items` with at most `limit` in flight. `fn` must not throw. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
}

export async function runAgentLoop(opts: {
  llm: LLM;
  system: SystemBlock[];
  messages: MessageParam[];
  signal?: AbortSignal;
  callbacks?: LoopCallbacks;
  searchProvider?: SearchProvider;
  model?: string;
  db?: DatabaseSync;
  store?: MemoryStore;
  /** If set, step 1 must search: the model is asked to, and if it does not, this query is searched for it. */
  forceSearch?: string | (() => Promise<string>);
  /** Settings > Preferences > Web search off: the model is not offered web_search. */
  disableWebSearch?: boolean;
  /** Composer approval mode (default "auto"). Without a requestApproval callback nothing can be asked, so it is moot. */
  approvalMode?: ApprovalMode;
  /** Attribute tool writes (save_memory) to this turn / conversation. */
  turnId?: string;
  conversationId?: string;
  /** Overrides for the config budgets (tests, evals). */
  limits?: LoopLimits;
}): Promise<AgentLoopResult> {
  const cfg = getConfig();
  const maxSteps = Math.max(1, opts.limits?.maxSteps ?? cfg.MAX_STEPS);
  const maxToolCalls = Math.max(1, opts.limits?.maxToolCalls ?? cfg.MAX_TOOL_CALLS_PER_TURN);
  const maxParallel = Math.max(1, opts.limits?.maxParallel ?? cfg.MAX_PARALLEL_TOOLS);
  const retryDelayMs = opts.limits?.llmRetryDelayMs ?? 300;
  const signal = opts.signal;
  const callbacks = opts.callbacks ?? {};
  const registry = new TurnCitationRegistry();
  const messages = [...opts.messages];
  let answer = "";
  let steps = 0;
  let toolCallsUsed = 0;
  let budget: AgentLoopResult["budget"];
  const executed: ExecutedToolCall[] = [];

  const toolCtx: ToolContext = {
    db: opts.db as DatabaseSync,
    store: opts.store,
    searchProvider: opts.searchProvider,
    registry,
    signal,
    turnId: opts.turnId,
    conversationId: opts.conversationId,
    counts: {},
  };
  // Policy comes from each tool's definition (permissions.ts). Without a requestApproval callback nothing can be asked.
  const gate = new PermissionGate(!!callbacks.requestApproval, callbacks.requestApproval ? (opts.approvalMode ?? "auto") : "full", toolCtx);
  const isSearchTool = (name: string) => !!getTool(name)?.isSearch;
  const throwIfAborted = () => {
    if (signal?.aborted) throw abortError();
  };

  /** One model step. A transient failure is retried once, but only while nothing has reached the client. */
  const streamStep = async (req: Parameters<LLM["stream"]>[0], emitAsAnswer: boolean, hold: boolean) => {
    for (let attempt = 0; ; attempt++) {
      const progress = { emitted: false };
      try {
        return await consumeStream(opts.llm.stream(req), callbacks, emitAsAnswer, hold, progress);
      } catch (err) {
        throwIfAborted();
        if (attempt >= 1 || progress.emitted || classifyLlmError(err) !== "transient") throw err;
        callbacks.onStatus?.("Model connection hiccup, retrying…");
        await sleep(retryDelayMs, signal);
        throwIfAborted();
      }
    }
  };

  for (let step = 1; step <= maxSteps; step++) {
    steps = step;
    const toolCapHit = toolCallsUsed >= maxToolCalls;
    const withholdTools = step === maxSteps || toolCapHit;
    if (withholdTools && step > 1) {
      budget = toolCapHit ? "tool_calls" : "steps";
      callbacks.onStatus?.(
        toolCapHit
          ? "Tool call limit reached for this turn - answering with what I have"
          : "Step limit reached - answering with what I have",
      );
    }
    const mustSearch = step === 1 && !!opts.forceSearch && !withholdTools;
    const req = {
      system: opts.system,
      messages,
      tools: withholdTools ? undefined : opts.disableWebSearch ? AGENT_TOOLS.filter((t) => t.name !== "web_search") : AGENT_TOOLS,
      forceTool: mustSearch,
      forceToolName: mustSearch ? "web_search" : undefined,
      model: opts.model ?? defaultMainModel(),
      signal,
    };

    let { content, text } = await streamStep(req, withholdTools || step > 1, mustSearch);
    throwIfAborted();
    let calls = extractToolCalls(content);
    if (mustSearch && calls.length === 0) {
      const query =
        typeof opts.forceSearch === "function" ? await opts.forceSearch() : opts.forceSearch!;
      content = [
        {
          type: "tool_use",
          id: `forced_${Date.now().toString(36)}`,
          name: "web_search",
          input: { query },
        },
      ];
      calls = extractToolCalls(content);
      text = "";
    }

    if (!calls.length || withholdTools) {
      // Final answer. (A model that calls tools anyway when none were offered is ignored: no tool_use is kept
      // in the history without its result.)
      answer = text;
      if (calls.length === 0 && text.trim()) messages.push({ role: "assistant", content: content as never });
      break;
    }
    messages.push({ role: "assistant", content: content as never });

    // ---- plan the step: duplicates ride along free, the rest is subject to the step and turn budgets ----
    const firstByKey = new Map<string, Call>();
    const dupsOf = new Map<string, Call[]>();
    const unique: Call[] = [];
    const dupParent = new Map<string, string>();
    for (const c of calls) {
      const key = dedupeKeyOf(c);
      const first = key ? firstByKey.get(key) : undefined;
      if (first) {
        dupsOf.set(first.id, [...(dupsOf.get(first.id) ?? []), c]);
        dupParent.set(c.id, first.id);
      } else {
        if (key) firstByKey.set(key, c);
        unique.push(c);
      }
    }
    const perStep = stepToolBudget();
    const turnLeft = Math.max(0, maxToolCalls - toolCallsUsed);
    const allowed = Math.min(perStep, turnLeft);
    const toRun = unique.slice(0, allowed);
    const droppedReason = turnLeft <= perStep ? "tool call limit reached for this turn" : "tool limit reached for this step";
    const droppedIds = new Set(unique.slice(allowed).map((c) => c.id));

    // ---- approvals: ONE request for every gated call of this step; decisions are stored per call ----
    const pending = gate.callsNeedingPrompt(toRun);
    if (pending.length > 0 && callbacks.requestApproval) {
      let ok = false;
      try {
        ok = await raceAbort(callbacks.requestApproval(pending.map((c) => gate.actionFor(c))), signal, false);
      } catch {
        ok = false;
      }
      throwIfAborted();
      gate.record(ok, pending);
    }

    const runnable = (c: Call) => !droppedIds.has(c.id) && !(dupParent.has(c.id) && droppedIds.has(dupParent.get(c.id)!));
    const started = calls.filter(runnable);
    const searchStarted = started.filter((c) => isSearchTool(c.name));
    const otherStarted = started.filter((c) => !isSearchTool(c.name));
    if (searchStarted.length > 0) {
      callbacks.onSearchStart?.(
        searchStarted.map((c) => labelForCall(c.name, c.input)),
        searchStarted.map((c) => c.id),
      );
    }
    if (otherStarted.length > 0) {
      callbacks.onToolStart?.(otherStarted.map((c) => ({ id: c.id, tool: c.name, label: labelForCall(c.name, c.input) })));
    }

    // ---- execute ----
    const results = new Map<string, ToolExecResult>();
    const emitDone = (c: Call, res: ToolExecResult) => {
      if (isSearchTool(c.name)) {
        callbacks.onSearchDone?.({
          query: res.search?.query ?? res.label,
          count: res.search?.count ?? 0,
          ms: res.ms,
          cached: res.search?.cached ?? false,
          callId: c.id,
          results: res.search?.results ?? [],
          error: res.error,
          ...(res.duplicate ? { duplicate: true as const } : {}),
        });
      } else {
        callbacks.onToolDone?.({
          id: c.id,
          tool: c.name,
          label: res.label,
          ms: res.ms,
          error: res.error,
          ...(res.duplicate ? { duplicate: true as const } : {}),
        });
      }
    };
    const execOne = async (c: Call): Promise<void> => {
      let res: ToolExecResult;
      if (signal?.aborted) {
        res = errorResult(c, "cancelled");
      } else {
        try {
          res = await executeToolCall(c, toolCtx, gate.allows(c.name, c.input, c.id));
        } catch (e) {
          // The dispatcher never throws; this keeps one tool's failure from ever taking its siblings down.
          res = errorResult(c, e instanceof Error ? e.message : "tool failed");
        }
      }
      results.set(c.id, res);
      emitDone(c, res);
      for (const d of dupsOf.get(c.id) ?? []) {
        const dres: ToolExecResult = { ...res, id: d.id, ms: 0, duplicate: true };
        results.set(d.id, dres);
        emitDone(d, dres);
      }
    };

    const batchT0 = Date.now();
    const writes = toRun.filter((c) => getTool(c.name)?.effect === "write");
    const reads = toRun.filter((c) => getTool(c.name)?.effect !== "write");
    await pool(reads, maxParallel, execOne);
    for (const w of writes) await execOne(w); // model order, one at a time, after the reads
    const batchDurationMs = Date.now() - batchT0;
    throwIfAborted();

    const searchRuns = toRun.filter((c) => isSearchTool(c.name)).map((c) => results.get(c.id)!);
    if (searchRuns.length > 0) {
      callbacks.onSearchBatch?.({
        step,
        queryCount: searchRuns.length,
        batchDurationMs,
        queries: searchRuns.map((r) => ({ query: r.label, durationMs: r.ms })),
      });
    }

    for (const c of toRun) {
      const r = results.get(c.id)!;
      if (r.declined || r.duplicate) continue;
      toolCallsUsed += 1;
      executed.push({ id: c.id, name: c.name, label: r.label, input: c.input, content: r.content, error: r.error, ms: r.ms });
    }

    const toolMessage = calls.map((c) => {
      const r = results.get(c.id);
      return r
        ? { id: c.id, content: r.content }
        : { id: c.id, content: `<tool_error name="${c.name}" error="${droppedReason}"/>` };
    });
    messages.push(toolResultBlocks(toolMessage));
  }

  if (!answer.trim() && !signal?.aborted) {
    const retry = await consumeStream(
      opts.llm.stream({
        system: opts.system,
        messages: [
          ...messages,
          {
            role: "user",
            content:
              "Answer the user's question now in plain text, using any tool results above. Do not call tools.",
          },
        ],
        model: opts.model ?? defaultMainModel(),
        signal,
      }),
      callbacks,
      true,
    ).catch(() => ({ text: "" }));
    answer = retry.text.trim()
      ? retry.text
      : "I couldn't generate an answer this time. Please try again or rephrase the question.";
    if (!retry.text.trim()) callbacks.onToken?.(answer);
  }

  const searches = Object.entries(toolCtx.counts).reduce((n, [name, c]) => n + (isSearchTool(name) ? c : 0), 0);
  return { answer, registry, steps, searches, toolCalls: executed, budget };
}
