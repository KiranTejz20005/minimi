import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import type { SearchProvider } from "../search/types.js";
import { getConfig } from "../config.js";
import { defaultMainModel, extractToolCalls } from "../llm/anthropic.js";
import type { LLM } from "../llm/types.js";
import type { AssistantBlock, LLMEvent, SystemBlock } from "../llm/types.js";
import { SEARCH_TOOL } from "./prompts.js";
import {
  TurnCitationRegistry,
  getSearchRunner,
  searchCapRemaining,
} from "../search/tool.js";

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
  /** When set, web searches wait for the user's approval before running. */
  requestApproval?: (queries: string[]) => Promise<boolean>;
  /** Fired after a parallel search batch (one tool step) completes. */
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
  /** If set, step 1 must search: the model is asked to, and if it does not, this query is searched for it. */
  forceSearch?: string | (() => Promise<string>);
}): Promise<AgentLoopResult> {
  const cfg = getConfig();
  const callbacks = opts.callbacks ?? {};
  const registry = new TurnCitationRegistry();
  const runner = getSearchRunner(opts.searchProvider);
  let messages = [...opts.messages];
  let searches = 0;
  let answer = "";
  let steps = 0;

  for (let step = 1; step <= cfg.MAX_STEPS; step++) {
    steps = step;
    const withholdTools = step === cfg.MAX_STEPS;
    const stream = opts.llm.stream({
      system: opts.system,
      messages,
      tools: withholdTools ? undefined : [SEARCH_TOOL],
      forceTool: step === 1 && !!opts.forceSearch && !withholdTools,
      model: opts.model ?? defaultMainModel(),
      signal: opts.signal,
    });

    // After the first step the model is almost always writing the final answer, so stream it live.
    const mustSearch = step === 1 && !!opts.forceSearch && !withholdTools;
    let { content, text } = await consumeStream(
      stream,
      callbacks,
      withholdTools || step > 1,
      mustSearch,
    );
    let calls = extractToolCalls(content);
    if (mustSearch && calls.length === 0) {
      // The model answered from memory on a time-sensitive question. Search for it instead.
      const query = typeof opts.forceSearch === "function" ? await opts.forceSearch() : opts.forceSearch;
      content = [
        { type: "tool_use", id: `forced_${Date.now().toString(36)}`, name: "web_search", input: { query } },
      ];
      calls = extractToolCalls(content);
      text = "";
    }
    messages.push({ role: "assistant", content: content as never });

    if (!calls.length) {
      answer = text;
      break;
    }

    const perStepCap = cfg.MAX_SEARCHES_PER_STEP;
    const turnCap = searchCapRemaining(searches);
    const allowed = Math.min(calls.length, perStepCap, turnCap);
    const toRun = calls.slice(0, allowed);
    const dropped = calls.slice(allowed);

    const queries = toRun.map((c) => queryFromInput(c.input));
    let approved = true;
    if (toRun.length > 0 && callbacks.requestApproval) {
      approved = await callbacks.requestApproval(queries);
    }
    callbacks.onSearchStart?.(queries, toRun.map((c) => c.id));

    const batchT0 = Date.now();
    const results = await Promise.all(
      toRun.map(async (c) => {
        if (!approved) {
          const q = queryFromInput(c.input);
          callbacks.onSearchDone?.({
            query: q,
            count: 0,
            ms: 0,
            cached: false,
            callId: c.id,
            results: [],
            error: "declined by user",
          });
          return {
            id: c.id,
            content: `<search_results query="${escapeAttr(q)}" error="the user declined this web search; answer from what you know and say so"/>`,
            query: q,
            durationMs: 0,
          };
        }
        const res = await runner.run(c.input, registry, opts.signal);
        callbacks.onSearchDone?.({
          query: res.query,
          count: res.count,
          ms: res.ms,
          cached: res.cached,
          callId: c.id,
          results: (res.sources ?? []).map((s) => ({ title: s.title, url: s.url })),
          error: res.error,
        });
        searches += 1;
        return {
          id: c.id,
          content: res.xml,
          query: res.query,
          durationMs: res.ms,
        };
      }),
    );
    const batchDurationMs = Date.now() - batchT0;
    if (toRun.length > 0) {
      callbacks.onSearchBatch?.({
        step,
        queryCount: toRun.length,
        batchDurationMs,
        queries: results.map((r) => ({
          query: r.query,
          durationMs: r.durationMs,
        })),
      });
    }

    for (const d of dropped) {
      results.push({
        id: d.id,
        content: `<search_results query="${escapeAttr(queryFromInput(d.input))}" error="search limit reached for this turn"/>`,
        query: queryFromInput(d.input),
        durationMs: 0,
      });
    }

    messages.push(toolResultBlocks(results));

    if (step === cfg.MAX_STEPS) {
      answer = text;
    }
  }

  if (!answer.trim() && !opts.signal?.aborted) {
    // The model returned nothing (rate limit, empty completion, reasoning-only output). Ask once more,
    // with tools withheld, then fall back to an honest message rather than a blank reply.
    const retry = await consumeStream(
      opts.llm.stream({
        system: opts.system,
        messages: [
          ...messages,
          { role: "user", content: "Answer the user's question now in plain text, using any search results above. Do not call tools." },
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

function queryFromInput(input: unknown): string {
  if (input && typeof input === "object" && "query" in input) {
    return String((input as { query: unknown }).query);
  }
  return "";
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
