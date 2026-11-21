import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../clock.js";
import { getClock } from "../clock.js";
import { getConfig } from "../config.js";
import { getDb } from "../db.js";
import { createLlm } from "../llm/anthropic.js";
import type { LLM } from "../llm/types.js";
import { DigestQueue } from "../memory/digest.js";
import type { ApprovalMode } from "./permissions.js";
import {
  type RecallResult,
  recalledTurnIds,
  renderMemoryBlock,
  retrieve,
} from "../memory/retrieve.js";
import { formatDisplayDate, resolveTimeRefs } from "../memory/temporal.js";
import {
  MemoryStore,
  appendMessage,
  completeTurn,
  createConversation,
  createTurn,
  getConversation,
  getConversationMessages,
  localParts,
  saveSources,
} from "../memory/store.js";
import { createTraceWriter } from "../trace.js";
import { newId } from "../util/ids.js";
import { buildContext } from "./context.js";
import { composeUserContext, readPrefs } from "../preferences.js";
import {
  citedNumbers,
  collectSources,
  sourcesToPayload,
  stripInvalidCitations,
} from "./citations.js";
import type { SearchProvider } from "../search/types.js";
import { runAgentLoop, type LoopCallbacks } from "./loop.js";

/**
 * Questions about things that change (releases, prices, news, "latest"…) must be checked on the web:
 * small models otherwise answer from stale training data. Skipped when the user attached files
 * or is asking about the earlier conversation (memory).
 */
const FRESH_CUE =
  /\b(when|release[sd]?|releasing|launch(es|ed|ing)?|latest|newest|current(ly)?|today|tonight|tomorrow|yesterday|now|news|price[sd]?|pricing|costs?|score|weather|forecast|who (is|are|won|wins)|update[sd]?|version|upcoming|schedule|date|trailer|announce[sd]?|rumou?rs?|stock|rate|20(2[4-9]|3\d))\b/i;

const GREETING =
  /^(hi|hii+|hello|hey|yo|thanks?|thank you|ok(ay)?|cool|nice|great|bye|good (morning|evening|night)|gm|gn)[ !.?,]*$/i;
const NO_SEARCH_TASK =
  /^(please )?(explain|write|rewrite|translate|summari[sz]e|fix|debug|refactor|generate|convert|calculate|solve|draft|compose|define|implement|code|create|make|tell me a joke)\b/i;

/**
 * Search by default: small models answer from stale memory far too often. Skip the search only for
 * greetings, pure writing/coding tasks, attached files, and questions answered by saved memory.
 */
export function needsFreshData(message: string, hasAttachments: boolean, hasMemory: boolean): boolean {
  const m = message.trim();
  if (hasAttachments || hasMemory || m.length < 3) return false;
  if (GREETING.test(m)) return false;
  if (FRESH_CUE.test(m)) return true;
  if (NO_SEARCH_TASK.test(m)) return false;
  return true;
}

/** A usable search query from a chatty question: drop repeated punctuation, cap the length. */
export function searchQueryFrom(message: string): string {
  const q = message.replace(/[?!.]{2,}/g, " ").replace(/[?!]+$/g, "").replace(/\s+/g, " ").trim();
  return q.split(" ").slice(0, 14).join(" ");
}

const RECALL_CUE =
  /\b(asked|told|said|discussed|shortlisted|earlier|previously|your answer|again)\b/i;

let digestQueue: DigestQueue | null = null;

export function getDigestQueue(db: DatabaseSync): DigestQueue {
  if (!digestQueue) digestQueue = new DigestQueue(new MemoryStore(db));
  return digestQueue;
}

export type MemoryEventPayload = {
  status: "hit" | "miss" | "none";
  text?: string;
  turns?: { id: string; localDate: string; question: string }[];
  miss?: { dates: string[] };
};

export type TurnEventHandlers = LoopCallbacks & {
  /** Fired as soon as the conversation exists (before any model work), so clients can lock onto its id. */
  onConversation?: (id: string) => void;
  onMemory?: (payload: MemoryEventPayload) => void;
  onSources?: (sources: ReturnType<typeof sourcesToPayload>) => void;
  onDone?: (payload: {
    turnId: string;
    conversationId: string;
    answer: string;
    searchCount?: number;
  }) => void;
  onError?: (message: string) => void;
};

export interface RunTurnInput {
  message: string;
  tz: string;
  conversationId?: string;
  signal?: AbortSignal;
  /** Override DB/clock for eval; defaults to process singletons. */
  db?: DatabaseSync;
  clock?: Clock;
  llm?: LLM;
  searchProvider?: SearchProvider;
  /** Model id override for this turn (defaults to MODEL_MAIN). */
  model?: string;
  /** What the LLM sees as the user message (e.g. with attachments); `message` is what gets stored/shown. */
  contextMessage?: string;
  /** Composer approval mode for this turn (see permissions.ts). */
  approvalMode?: ApprovalMode;
}

export interface RunTurnResult {
  turnId: string;
  conversationId: string;
  answer: string;
  recalledIds: string[];
  searchCount: number;
  /** Web sources registered for citations this turn (may be fewer than searchCount if a search failed). */
  sourceCount: number;
  steps: number;
  firstStatusMs: number | null;
  firstTokenMs: number | null;
  totalMs: number;
}

function memoryStatusText(recall: RecallResult, tz: string): string | undefined {
  if (recall.kind === "miss") {
    const d = recall.resolvedDates[0];
    return d
      ? `No saved conversation for ${formatDisplayDate(d, tz)}`
      : "No saved conversation for that date";
  }
  if (recall.kind === "hit") {
    const display = formatDisplayDate(recall.turns[0]!.localDate, tz);
    if (recall.dateAdjusted) {
      return `Nothing on that day — found it on ${display}`;
    }
    return `Found your conversation from ${display}`;
  }
  return undefined;
}

function memoryPayload(recall: RecallResult | null, tz: string) {
  if (!recall) return { status: "none" as const };
  const text = memoryStatusText(recall, tz);
  if (recall.kind === "miss") {
    return {
      status: "miss" as const,
      text,
      miss: { dates: recall.resolvedDates },
    };
  }
  return {
    status: "hit" as const,
    text,
    turns: recall.turns.map((t) => ({
      id: t.id,
      localDate: t.localDate,
      question: t.question.slice(0, 160),
    })),
  };
}

export async function runTurn(
  input: RunTurnInput,
  handlers: TurnEventHandlers = {},
): Promise<RunTurnResult> {
  const cfg = getConfig();
  const db = input.db ?? getDb();
  const clock = input.clock ?? getClock();
  const tz = input.tz || cfg.DEFAULT_TZ;
  const turnStart = clock.now().getTime();
  let firstStatusMs: number | null = null;
  let firstTokenMs: number | null = null;
  const parts = localParts(clock.now(), tz);

  let llm = input.llm;
  if (!llm) {
    if (!cfg.hasLlm || !cfg.hasSearch) {
      const msg = !cfg.hasLlm
        ? "No LLM API key configured — add NVIDIA_API_KEY or ANTHROPIC_API_KEY to .env and restart (see README → API keys)"
        : "Missing TAVILY_API_KEY — copy .env.example to .env";
      handlers.onError?.(msg);
      throw new Error(msg);
    }
    llm = await createLlm();
  }

  let conversationId = input.conversationId;
  if (conversationId) {
    const conv = getConversation(db, conversationId);
    if (!conv) conversationId = undefined;
  }
  if (!conversationId) {
    conversationId = createConversation(db, clock, input.message.slice(0, 80)).id;
  }
  handlers.onConversation?.(conversationId);

  const userMsg = appendMessage(
    db,
    conversationId,
    "user",
    input.message,
    parts.createdAt,
  );
  const turn = createTurn(db, {
    conversationId,
    userMessageId: userMsg.id,
    clock,
    tz,
  });

  const trace = createTraceWriter(db, turn.id, clock, turnStart);

  const tTemporal0 = clock.now().getTime();
  const timeRefs = resolveTimeRefs(input.message, clock, tz);
  trace.record("temporal", clock.now().getTime() - tTemporal0, {
    refs: timeRefs.length,
  });

  const shouldRecall =
    readPrefs(db).memoryRecall && (timeRefs.length > 0 || RECALL_CUE.test(input.message));
  const tRecall0 = clock.now().getTime();
  const recall: RecallResult | null = shouldRecall
    ? retrieve(db, input.message, timeRefs, tz, conversationId)
    : null;
  const recalledIds = recall ? recalledTurnIds(recall) : [];
  trace.record("retrieve", clock.now().getTime() - tRecall0, {
    kind: recall?.kind ?? "skipped",
    ids: recalledIds,
  });

  const memoryXml = recall ? renderMemoryBlock(recall, tz, db) ?? undefined : undefined;

  handlers.onMemory?.(memoryPayload(recall, tz));
  const status = recall ? memoryStatusText(recall, tz) : undefined;
  if (status) {
    if (firstStatusMs === null) firstStatusMs = clock.now().getTime() - turnStart;
    handlers.onStatus?.(status);
  }

  const history = getConversationMessages(db, conversationId).filter(
    (m) => m.id !== userMsg.id,
  );
  const prefs = readPrefs(db);
  const { system, messages } = buildContext({
    clock,
    tz,
    history,
    userMessage: input.contextMessage ?? input.message,
    memoryXml: memoryXml ?? undefined,
    customInstructions: composeUserContext(prefs) || undefined,
  });

  let loopResult: Awaited<ReturnType<typeof runAgentLoop>>;
  try {
    const tLoop0 = clock.now().getTime();
    let searchBatch = 0;
    const metricHandlers: TurnEventHandlers = {
      ...handlers,
      onStatus: (text) => {
        if (firstStatusMs === null) firstStatusMs = clock.now().getTime() - turnStart;
        handlers.onStatus?.(text);
      },
      onToken: (text) => {
        if (firstTokenMs === null) firstTokenMs = clock.now().getTime() - turnStart;
        handlers.onToken?.(text);
      },
      onSearchBatch: (batch) => {
        handlers.onSearchBatch?.(batch);
        searchBatch += 1;
        trace.record("search", batch.batchDurationMs, {
          batch: searchBatch,
          step: batch.step,
          parallel: batch.queryCount > 1,
          count: batch.queryCount,
          queries: batch.queries,
        });
      },
    };
    // Pass db/store/approvalMode so loop can run memory_search/lookup_claims and gate permissions.
    // Called from server.ts POST /api/chat. User: add tools + fix useless permission prompts.
    loopResult = await runAgentLoop({
      llm,
      system,
      messages,
      signal: input.signal,
      callbacks: metricHandlers,
      searchProvider: input.searchProvider,
      model: input.model,
      db,
      store: new MemoryStore(db),
      disableWebSearch: !prefs.webSearch,
      approvalMode: input.approvalMode,
      forceSearch: prefs.webSearch && cfg.FORCE_SEARCH !== "0" && !input.llm && needsFreshData(input.message, !!input.contextMessage, recall?.kind === "hit")
        ? async () => {
            const raw = searchQueryFrom(input.message);
            if (history.length === 0) return raw;
            // Follow-up ("and when was it founded?"): rewrite into a standalone query using the chat so far.
            try {
              const recent = history
                .slice(-4)
                .map((m) => `${m.role}: ${m.content.slice(0, 300)}`)
                .join("\n");
              const r = await llm.json<{ query?: string }>({
                model: input.model ?? cfg.MODEL_MAIN,
                system: 'You turn a chat follow-up into one standalone web search query. Reply with JSON only like {"query": "..."}. 3-12 words, no pronouns, include the subject from the conversation.',
                user: `Conversation:\n${recent}\n\nLast user message: ${input.message}`,
                signal: input.signal,
              });
              const q = r?.query?.trim();
              return q ? q.slice(0, 200) : raw;
            } catch {
              return raw;
            }
          }
        : undefined,
    });
    trace.record("llm_step", clock.now().getTime() - tLoop0, {
      steps: loopResult.steps,
      searches: loopResult.searches,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Agent loop failed";
    handlers.onError?.(msg);
    const errAsst = appendMessage(
      db,
      conversationId,
      "assistant",
      msg,
      localParts(clock.now(), tz).createdAt,
    );
    completeTurn(
      db,
      turn.id,
      errAsst.id,
      input.signal?.aborted ? "aborted" : "error",
    );
    trace.flush();
    throw err;
  }

  const tCit0 = clock.now().getTime();
  const valid = new Set(loopResult.registry.sources.keys());
  const cited = citedNumbers(loopResult.answer);
  const answer = stripInvalidCitations(loopResult.answer, valid);
  const sources = collectSources(loopResult.registry, cited);
  trace.record("citations", clock.now().getTime() - tCit0, { cited: cited.length });

  const asstMsg = appendMessage(
    db,
    conversationId,
    "assistant",
    answer,
    localParts(clock.now(), tz).createdAt,
  );
  const aborted = Boolean(input.signal?.aborted);
  completeTurn(db, turn.id, asstMsg.id, aborted ? "aborted" : "ok");

  saveSources(
    db,
    turn.id,
    sources.map((s) => ({
      n: s.n,
      url: s.url,
      title: s.title,
      publishedAt: s.publishedAt ?? undefined,
      retrievedAt: s.retrievedAt,
      cited: true,
    })),
  );

  handlers.onSources?.(sourcesToPayload(sources));
  handlers.onDone?.({
    turnId: turn.id,
    conversationId,
    answer,
    searchCount: loopResult.searches,
  });
  trace.flush();

  getDigestQueue(db).enqueue(turn.id, turn.local_date);

  return {
    turnId: turn.id,
    conversationId,
    answer,
    recalledIds,
    searchCount: loopResult.searches,
    sourceCount: loopResult.registry.sources.size,
    steps: loopResult.steps,
    firstStatusMs,
    firstTokenMs,
    totalMs: clock.now().getTime() - turnStart,
  };
}

export function importConversations(
  db: DatabaseSync,
  clock: Clock,
  payload: {
    conversations: {
      title?: string;
      messages: { role: "user" | "assistant"; content: string; at: string }[];
    }[];
  },
  defaultTz: string,
): number {
  let count = 0;
  for (const c of payload.conversations) {
    const conv = createConversation(db, clock, c.title ?? null);
    let pendingUser: string | null = null;
    for (const m of c.messages) {
      const msg = appendMessage(db, conv.id, m.role, m.content, m.at);
      if (m.role === "user") pendingUser = msg.id;
      else if (m.role === "assistant" && pendingUser) {
        const local = localParts(new Date(m.at), defaultTz);
        db.prepare(
          `INSERT INTO turns (id, conversation_id, user_message_id, assistant_message_id, created_at, tz, local_date, local_time, digest_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'skipped')`,
        ).run(
          newId("t"),
          conv.id,
          pendingUser,
          msg.id,
          m.at,
          defaultTz,
          local.localDate,
          local.localTime,
        );
        pendingUser = null;
        count += 1;
      }
    }
  }
  return count;
}
