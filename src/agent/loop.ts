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
  labelForCall,
  stepToolBudget,
  type ToolContext,
} from "../tools/registry.js";
import { PermissionGate, type ApprovalMode } from "./permissions.js";

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
  }) => void;
  onToolStart?: (tools: { id: string; tool: string; label: string }[]) => void;
  onToolDone?: (payload: {
    id: string;
    tool: string;
    label: string;
    ms: number;
    error?: string;
  }) => void;
  /** At most once per turn for gated network actions (uncached search / fetch). */
  requestApproval?: (actions: { tool: string; label: string }[]) => Promise<boolean>;
  onSearchBatch?: (payload: {
    step: number;
    queryCount: number;
    batchDurationMs: number;
    queries: { query: string; durationMs: number }[];
  }) => void;
  onToken?: (text: string) => void;
}

export interface AgentLoopResult {
  answer: string;
  registry: TurnCitationRegistry;
  steps: number;
  searches: number;
}

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

async function consumeStream(
  stream: AsyncIterable<LLMEvent>,
  callbacks: LoopCallbacks,
  emitAsAnswer: boolean,
  /** Hold back a tool-less answer (the caller may replace it with a forced search). */
  hold = false,
): Promise<{ content: AssistantBlock; text: string }> {
  let buffered = "";
  let thinking = "";

  for await (const ev of stream) {
    if (ev.type === "text_delta") {
      buffered += ev.text;
      if (emitAsAnswer) callbacks.onToken?.(ev.text);
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
}): Promise<AgentLoopResult> {
  const cfg = getConfig();
  const callbacks = opts.callbacks ?? {};
  const registry = new TurnCitationRegistry();
  // Sensitive tools always gate; read-only search/fetch only when the user opted in (see permissions.ts).
  const gate = new PermissionGate(!!callbacks.requestApproval, callbacks.requestApproval ? (opts.approvalMode ?? "auto") : "full");
  let messages = [...opts.messages];
  let searches = 0;
  let fetches = 0;
  let answer = "";
  let steps = 0;

  const toolCtx = {
    db: opts.db as DatabaseSync,
    store: opts.store,
    searchProvider: opts.searchProvider,
    registry,
    signal: opts.signal,
    get searchesUsed() {
      return searches;
    },
    set searchesUsed(n: number) {
      searches = n;
    },
    get fetchesUsed() {
      return fetches;
    },
    set fetchesUsed(n: number) {
      fetches = n;
    },
  } satisfies ToolContext;

  for (let step = 1; step <= cfg.MAX_STEPS; step++) {
    steps = step;
    const withholdTools = step === cfg.MAX_STEPS;
    const stream = opts.llm.stream({
      system: opts.system,
      messages,
      tools: withholdTools ? undefined : opts.disableWebSearch ? AGENT_TOOLS.filter((t) => t.name !== "web_search") : AGENT_TOOLS,
      forceTool: step === 1 && !!opts.forceSearch && !withholdTools,
      forceToolName: step === 1 && !!opts.forceSearch && !withholdTools ? "web_search" : undefined,
      model: opts.model ?? defaultMainModel(),
      signal: opts.signal,
    });

    const mustSearch = step === 1 && !!opts.forceSearch && !withholdTools;
    let { content, text } = await consumeStream(
      stream,
      callbacks,
      withholdTools || step > 1,
      mustSearch,
    );
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
    messages.push({ role: "assistant", content: content as never });

    if (!calls.length) {
      answer = text;
      break;
    }

    // Keep every tool_use paired with a tool_result (API contract). When db is missing,
    // still return an explicit error for memory/claims instead of dropping the call.
    const needsDb = (name: string) => name === "memory_search" || name === "lookup_claims";

    const budget = stepToolBudget();
    const toRun = calls.slice(0, budget);
    const dropped = calls.slice(budget);

    const needing = gate.actionsNeedingPrompt(toRun);
    if (needing.length > 0 && callbacks.requestApproval) {
      const ok = await callbacks.requestApproval(needing);
      gate.record(ok);
    }

    const searchCalls = toRun.filter((c) => c.name === "web_search");
    const otherCalls = toRun.filter((c) => c.name !== "web_search");

    if (searchCalls.length > 0) {
      callbacks.onSearchStart?.(
        searchCalls.map((c) => labelForCall(c.name, c.input)),
        searchCalls.map((c) => c.id),
      );
    }
    if (otherCalls.length > 0) {
      callbacks.onToolStart?.(
        otherCalls.map((c) => ({
          id: c.id,
          tool: c.name,
          label: labelForCall(c.name, c.input),
        })),
      );
    }

    const batchT0 = Date.now();
    const results = await Promise.all(
      toRun.map(async (c) => {
        if (needsDb(c.name) && !opts.db) {
          const label = labelForCall(c.name, c.input);
          const err = "memory database unavailable";
          callbacks.onToolDone?.({ id: c.id, tool: c.name, label, ms: 0, error: err });
          return {
            id: c.id,
            content: `<tool_error name="${c.name}" error="${err}"/>`,
            query: label,
            durationMs: 0,
            isSearch: false,
          };
        }
        const allowed = gate.allows(c.name, c.input);
        const res = await executeToolCall(c, toolCtx, allowed);

        if (c.name === "web_search") {
          callbacks.onSearchDone?.({
            query: res.search?.query ?? res.label,
            count: res.search?.count ?? 0,
            ms: res.ms,
            cached: res.search?.cached ?? false,
            callId: c.id,
            results: res.search?.results ?? [],
            error: res.error,
          });
        } else {
          callbacks.onToolDone?.({
            id: c.id,
            tool: c.name,
            label: res.label,
            ms: res.ms,
            error: res.error,
          });
        }

        return {
          id: c.id,
          content: res.content,
          query: res.label,
          durationMs: res.ms,
          isSearch: c.name === "web_search",
        };
      }),
    );
    const batchDurationMs = Date.now() - batchT0;

    const searchResults = results.filter((r) => r.isSearch);
    if (searchResults.length > 0) {
      callbacks.onSearchBatch?.({
        step,
        queryCount: searchResults.length,
        batchDurationMs,
        queries: searchResults.map((r) => ({
          query: r.query,
          durationMs: r.durationMs,
        })),
      });
    }

    for (const d of dropped) {
      results.push({
        id: d.id,
        content: `<tool_error name="${d.name}" error="tool limit reached for this step"/>`,
        query: labelForCall(d.name, d.input),
        durationMs: 0,
        isSearch: d.name === "web_search",
      });
    }

    messages.push(toolResultBlocks(results));

    if (step === cfg.MAX_STEPS) {
      answer = text;
    }
  }

  if (!answer.trim() && !opts.signal?.aborted) {
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
        signal: opts.signal,
      }),
      callbacks,
      true,
    ).catch(() => ({ text: "" }));
    answer = retry.text.trim()
      ? retry.text
      : "I couldn't generate an answer this time. Please try again or rephrase the question.";
    if (!retry.text.trim()) callbacks.onToken?.(answer);
  }

  return { answer, registry, steps, searches };
}
