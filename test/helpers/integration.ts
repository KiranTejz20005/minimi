/**
 * Shared harness for test/integration-*.test.ts.
 *
 * IMPORTANT: import this module BEFORE any ../src module in a test file. It pins the process environment
 * (no LLM keys, a throw-away DB_PATH for the web-search cache singleton, fixed step budgets) before the lazy
 * config singleton is first read.
 */
import "./env.js";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { Clock } from "../../src/clock.js";
import { migrate } from "../../src/db.js";
import type { AssistantBlock, LLM, LLMEvent, LLMStreamRequest } from "../../src/llm/types.js";
import { registerRoutes } from "../../src/routes.js";
import { runTurn, type RunTurnInput, type RunTurnResult, type TurnEventHandlers } from "../../src/agent/run-turn.js";
import type { SearchProvider } from "../../src/search/types.js";
import { createMockSearchProvider } from "../../scripts/mock-search.js";

export const SCHEMA_PATH = new URL("../../schema.sql", import.meta.url);

export function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  migrate(db);
  return db;
}

export function makeApp(db: DatabaseSync): Hono {
  const app = new Hono();
  registerRoutes(app, db);
  return app;
}

/** Strictly increasing clock so turn ordering never depends on rowid tie-breaks. */
export class TickClock implements Clock {
  private t: number;
  constructor(start = "2026-11-10T13:30:00.000Z") {
    this.t = new Date(start).getTime();
  }
  now(): Date {
    this.t += 1000;
    return new Date(this.t);
  }
}

// ---- scripted LLM --------------------------------------------------------------------------------------
export type ToolUse = { id: string; name: string; input: unknown };
export type Step =
  | { kind: "tools"; calls: ToolUse[]; text?: string }
  | { kind: "answer"; text: string }
  | { kind: "fn"; fn: (req: LLMStreamRequest, call: number) => Step };

export const tools = (calls: ToolUse[], text?: string): Step => ({ kind: "tools", calls, text });
export const answer = (text: string): Step => ({ kind: "answer", text });
export const use = (id: string, name: string, input: unknown): ToolUse => ({ id, name, input });

export type RecordedRequest = {
  system: string;
  /** Deep snapshot of the messages at call time (the loop mutates its array afterwards). */
  messages: { role: string; content: unknown }[];
  hasTools: boolean;
  toolNames: string[];
  forceTool: boolean;
  aborted: boolean;
};

/** Text of the first user-visible content of a message (string or text blocks). */
export function messageText(m: { content: unknown }): string {
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return (m.content as { type?: string; text?: string }[]).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
}

export type Scripted = {
  llm: LLM;
  requests: RecordedRequest[];
  /** Raw tool_result blocks the model received on request #i (the last user message), by tool_use_id. */
  resultsFor(i: number): Record<string, string>;
};

/** After the last scripted step the last step repeats (so a loop that never stops is visible as many requests). */
export function scriptedLlm(steps: Step[]): Scripted {
  const requests: RecordedRequest[] = [];
  const llm: LLM = {
    stream(req: LLMStreamRequest): AsyncIterable<LLMEvent> {
      const call = requests.length;
      requests.push({
        system: req.system.map((s) => s.text).join("\n"),
        messages: JSON.parse(JSON.stringify(req.messages)),
        hasTools: !!req.tools && req.tools.length > 0,
        toolNames: (req.tools ?? []).map((t) => t.name),
        forceTool: !!req.forceTool,
        aborted: !!req.signal?.aborted,
      });
      let step = steps[Math.min(call, steps.length - 1)]!;
      if (step.kind === "fn") step = step.fn(req, call);
      const s = step;
      return (async function* () {
        if (s.kind === "tools") {
          const content: Exclude<AssistantBlock, string> = [];
          if (s.text) content.push({ type: "text", text: s.text });
          for (const c of s.calls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
          yield { type: "done", stopReason: "tool_use", content };
          return;
        }
        if (s.kind === "answer") {
          for (const ch of s.text) yield { type: "text_delta", text: ch };
          yield { type: "done", stopReason: "end_turn", content: [{ type: "text", text: s.text }] };
        }
      })();
    },
    async json<T>(): Promise<T> {
      throw new Error("scripted llm: json() not available");
    },
  };
  return {
    llm,
    requests,
    resultsFor(i: number) {
      const out: Record<string, string> = {};
      const last = requests[i]!.messages.at(-1)!;
      if (Array.isArray(last.content)) {
        for (const b of last.content as { type: string; tool_use_id?: string; content?: unknown }[]) {
          if (b.type === "tool_result" && b.tool_use_id) out[b.tool_use_id] = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        }
      }
      return out;
    },
  };
}

// ---- event capture + turn runner -----------------------------------------------------------------------
export type Captured = {
  events: { type: string; payload?: unknown }[];
  of(type: string): unknown[];
  handlers: TurnEventHandlers;
  approvalRequests: { tool: string; label: string; verb: string }[][];
};

export function capture(opts: { approve?: boolean | ((actions: { tool: string; label: string; verb: string }[]) => boolean) } = {}): Captured {
  const events: Captured["events"] = [];
  const approvalRequests: Captured["approvalRequests"] = [];
  const push = (type: string) => (payload?: unknown) => void events.push({ type, payload });
  const handlers: TurnEventHandlers = {
    onConversation: push("conversation"),
    onStatus: push("status"),
    onToken: push("token"),
    onSearchStart: (q, ids) => void events.push({ type: "search_start", payload: { q, ids } }),
    onSearchDone: push("search_done"),
    onSearchBatch: push("search_batch"),
    onToolStart: push("tool_start"),
    onToolDone: push("tool_done"),
    onSources: push("sources"),
    onDone: push("done"),
    onError: push("error"),
    onMemory: push("memory"),
  };
  if (opts.approve !== undefined) {
    handlers.requestApproval = async (actions) => {
      approvalRequests.push(actions);
      events.push({ type: "approval_request", payload: actions });
      return typeof opts.approve === "function" ? opts.approve(actions) : opts.approve!;
    };
  }
  return { events, approvalRequests, handlers, of: (t) => events.filter((e) => e.type === t).map((e) => e.payload) };
}

export const defaultSearch: SearchProvider = createMockSearchProvider();

export async function turn(
  db: DatabaseSync,
  llm: LLM,
  message: string,
  extra: Partial<RunTurnInput> = {},
  handlers: TurnEventHandlers = {},
  clock?: Clock,
): Promise<RunTurnResult> {
  return runTurn(
    { message, tz: "Asia/Kolkata", db, llm, clock: clock ?? sharedClock, searchProvider: defaultSearch, ...extra },
    handlers,
  );
}

const sharedClock = new TickClock();

// ---- db helpers ----------------------------------------------------------------------------------------
export const count = (db: DatabaseSync, table: string, where = "1=1"): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
export const rows = <T = Record<string, unknown>>(db: DatabaseSync, sql: string, ...args: (string | number)[]): T[] =>
  db.prepare(sql).all(...args) as T[];
export const turnStatus = (db: DatabaseSync, id: string): string =>
  (db.prepare(`SELECT status FROM turns WHERE id = ?`).get(id) as { status: string }).status;
