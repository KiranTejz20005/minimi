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
import { renderSavedMemoryBlock } from "../memory/saved.js";
import { runMemorySearch } from "../tools/memory-search.js";
import { revokeTurnAttachments } from "../files/doc.js";
import { renderRecentToolResults, saveToolResults } from "./tool-history.js";
import { composeUserContext, readPrefs } from "../preferences.js";
import {
  citedNumbers,
  collectSources,
  sourcesToPayload,
  stripInvalidCitations,
} from "./citations.js";
import type { SearchProvider } from "../search/types.js";
import { runAgentLoop, type LoopCallbacks, type TruncationEvent } from "./loop.js";
import type { TokenUsage } from "../llm/types.js";

/**
 * Forced first-step web search: only for requests that are clearly about things that change (news, prices,
 * releases, scores, weather, office holders...). Everything else - arithmetic, units, dates and time zones
 * (the system prompt carries today's date; `calculate` does the maths), questions about attached files,
 * recall of earlier chats, save/forget requests, pure writing/coding/explaining tasks, greetings, pasted
 * content - is never forced. The model can still call web_search itself whenever it decides to.
 *
 * Detectors are conservative pure functions (regex, no network, no model) and are exported for testing.
 */
const FRESH_CUE =
  /\b(latest|newest|current(ly)?|today'?s?|tonight|tomorrow|yesterday|right now|as of|this (week|month|year|weekend|season)|news|breaking|headlines?|prices?|pricing|stocks?|share price|market cap|exchange rate|scores?|standings|weather|forecast|release[sd]?|releasing|launch(es|ed|ing)?|upcoming|schedule[sd]?|trailer|announce[sd]?|rumou?rs?|who (won|wins|is the (current|new|ceo|cto|cfo|president|prime minister|chancellor|governor|mayor|coach|champion))|ceo|net worth|population|20(2[4-9]|3\d))\b/i;
/** Cue words in scripts/languages where \b does not work. */
const FRESH_CUE_INTL =
  /(今天|今日|最新|新闻|新聞|天气|天氣|股价|आज|मौसम|समाचार|खबर|\bhoy\b|noticias|aujourd'?hui|actualités|météo|\bheute\b|nachrichten|wetter|\bclima\b)/i;
const CURRENCY_WORDS =
  /\b(usd|eur|inr|gbp|jpy|cad|aud|chf|cny|dollars?|euros?|rupees?|yen|btc|bitcoin|eth|ethereum)\b|[$€£₹¥]/i;
/** Weather questions are answered by the get_weather tool. */
const WEATHER_QUESTION = /\b(weather|umbrella)\b|\bwill it (rain|snow)\b|\bhow (hot|cold|warm) is it\b/i;
/** Currency conversion is live data, unlike unit conversion (answered by the convert_currency tool). */
const CURRENCY_CONVERSION =
  /\b(convert|exchange|rate|worth)\b.*(\b(usd|eur|inr|gbp|jpy|cad|aud|chf|cny|dollars?|euros?|rupees?|yen|btc|bitcoin|eth|ethereum)\b|[$€£₹¥])|\b(usd|eur|inr|gbp|jpy)\s+(to|in)\s+(usd|eur|inr|gbp|jpy)\b/i;

const GREETING_RE =
  /^(hi+|hello+|hey+( there)?|yo|sup|thanks?( you| a lot| so much)?|thank you( so much)?|ok(ay)?|cool|nice|great|bye|good (morning|evening|night|afternoon)|gm|gn|hola|namaste|namaskar|salut|bonjour|ciao|hallo|danke( sch[oö]n)?|gracias|merci|obrigado|你好|您好|谢谢|こんにちは|ありがとう|안녕(하세요)?|привет)[ !.?,~]*$/iu;

const TASK_RE =
  /^(please |pls )?(can you |could you |would you |kindly )?(help me (to )?)?(explain|write|rewrite|translate|summari[sz]e|fix|debug|refactor|generate|solve|draft|compose|define|implement|code|create|make|proofread|edit|improve|paraphrase|rephrase|brainstorm|outline|optimi[sz]e|review|format|describe|teach)\b/i;

const UNIT =
  "(?:km|kilomet(?:er|re)s?|m|met(?:er|re)s?|cm|mm|mi|miles?|ft|feet|foot|in|inch(?:es)?|yd|yards?|kg|g|grams?|lbs?|pounds?|oz|ounces?|l|lit(?:er|re)s?|ml|gal|gallons?|°?c|°?f|celsius|fahrenheit|kelvin|mph|kph|km/h|hours?|minutes?|mins?|seconds?|secs?|days?|weeks?|months?|years?|bytes?|kb|mb|gb|tb)";
const UNIT_CONVERSION = new RegExp(`\\b\\d+(?:[.,]\\d+)?\\s*${UNIT}\\b\\s+(?:to|in|into|=)\\s+(?:\\d+\\s*)?${UNIT}\\b`, "i");
const PURE_EXPRESSION = /^[\s\d+\-*/^%().,x×÷=?]+$/;

export function isGreeting(message: string): boolean {
  return GREETING_RE.test(message.trim());
}

/** Arithmetic, percentages, unit conversion ("12 * 7", "15% of 80", "5 km to miles"). Currency is NOT included. */
export function isCalculation(message: string): boolean {
  const m = message.trim();
  if (!/\d/.test(m) || CURRENCY_WORDS.test(m)) return false;
  if (PURE_EXPRESSION.test(m)) return /[+\-*/^%×÷]|\dx\d/i.test(m);
  if (/\d+(?:[.,]\d+)?\s*%\s*(?:of|de)\b/i.test(m)) return true;
  if (/\b(calculate|compute|evaluate|solve|calcul\w*|berechn\w*|hesapla\w*)\b|计算|算一下/i.test(m)) return true;
  if (/\b(plus|minus|times|divided by|multiplied by|squared|cubed|sqrt|square root|cube root|factorial|modulo)\b/i.test(m)) return true;
  return UNIT_CONVERSION.test(m);
}

/** "What day/time/date is it", time zones, "how many days until ...": answered from the clock, not the web. */
export function isDateTimeQuestion(message: string): boolean {
  const m = message.trim();
  return (
    /\bwhat (day|time|date|year|month)\b.*\b(is it|today|now)\b/i.test(m) ||
    /\bwhat(?:'?s| is) (?:the |today'?s )?(?:current )?(?:date|day|time)\b/i.test(m) ||
    /\btime ?zones?\b/i.test(m) ||
    /\bdays? (until|till|since|between)\b|\bhow many (days|weeks|months|hours|minutes) (until|till|since|between|from|are (in|left))\b/i.test(m)
  );
}

/** The message points at something the user attached ("this file", "the pdf", "report.docx"). */
export function referencesAttachment(message: string): boolean {
  return (
    /\b(this|the|that|my|attached|uploaded|enclosed|these|those)\s+(\w+\s+)?(files?|pdfs?|documents?|docx?|images?|pictures?|photos?|screenshots?|spreadsheets?|sheets?|csv|excel|slides?|decks?|resume|cv|attachments?|uploads?|zip)\b/i.test(message) ||
    /\battach(ed|ments?)\b|\buploaded\b/i.test(message) ||
    /\b[\w-]+\.(pdf|docx?|xlsx?|csv|pptx?|png|jpe?g|gif|txt|md|json)\b/i.test(message)
  );
}

/** Asks about the earlier conversation or about the user themselves: answered from chat memory. */
export function isMemoryRequest(message: string): boolean {
  return /\b(do you remember|remember (when|what|me)|what did (i|we)|did (i|we) (talk|tell|say|ask|discuss)|(we|i) (talked|discussed|spoke|said|told|asked)|you (said|told|mentioned|suggested)|earlier|previously|last time|our (last |previous )?(chat|conversation|discussion)|my (saved )?memor(y|ies)|what do you know about me|what(?:'?s| is| are) my|who am i|as (we|i) discussed)\b/i.test(message);
}

/** Asks to remember or forget something: handled by the memory tools, not the web. */
export function isSaveOrForget(message: string): boolean {
  return /\b(remember (that|this|my|i|me|to)|please remember|keep in mind|save (this|that|it|my)\b|add (this|that|it) to (my )?memory|note (that|this)( down)?|don'?t forget|forget (that|this|about|my|what|everything)|delete (that|this|my) (memory|note)|stop remembering|from now on|going forward|always (answer|reply|respond|call me|use))\b/i.test(message);
}

/** "2026-11-24 + 90 days", "30 days after 1 March 2026": a year in the text is an operand, not a freshness cue. */
const DATE_ARITHMETIC =
  /\d{4}-\d{2}-\d{2}\s*[+-]\s*\d+\s*(?:day|week|month|year)s?\b|\b\d+\s*(?:day|week|month|year)s?\s+(?:after|before|from)\b[^?]*\b\d{4}\b|\b(?:days|weeks|months|years)\s+(?:between|from|until|since)\b[^?]*\b\d{4}\b/i;

/** Pasted content (long text, code fences) is material to work on, not a question about the world. */
const PASTED_CHARS = 600;

export function needsFreshData(message: string, hasAttachments: boolean, hasMemory: boolean): boolean {
  const m = message.trim();
  if (hasAttachments || hasMemory || m.length < 3) return false;
  if (m.length > PASTED_CHARS || m.includes("```")) return false;
  if (isGreeting(m) || referencesAttachment(m)) return false;
  if (isMemoryRequest(m) || isSaveOrForget(m)) return false;
  if (TASK_RE.test(m)) return false;
  // Currency conversion and weather have dedicated tools (convert_currency, get_weather): don't force a web search.
  if (CURRENCY_CONVERSION.test(m) || WEATHER_QUESTION.test(m)) return false;
  if (isCalculation(m) || isDateTimeQuestion(m) || DATE_ARITHMETIC.test(m)) return false;
  return FRESH_CUE.test(m) || FRESH_CUE_INTL.test(m);
}

/** A usable search query from a chatty question: drop repeated punctuation, cap the length. */
export function searchQueryFrom(message: string): string {
  const q = message.replace(/[?!.]{2,}/g, " ").replace(/[?!]+$/g, "").replace(/\s+/g, " ").trim();
  return q.split(" ").slice(0, 14).join(" ");
}

/** A question about the user themselves: answer from what they told us earlier, never from thin air. */
const PERSONAL_QUESTION =
  /\bmy\s+(favou?rite|fav|name|birthday|age|email|phone|address|job|city|hobb|colou?r|food|pet|wife|husband|friend|dog|cat)|\bwho am i\b|what(?:'s| is| are)\s+my\b|do you (?:know|remember)\s+(?:my|me|what i)/i;

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
  /** Files uploaded with this message; bound to the conversation as soon as it exists. */
  attachmentIds?: string[];
  /** Composer approval mode for this turn (see permissions.ts). */
  approvalMode?: ApprovalMode;
  /** Pre-rendered <saved_memories> block (facts the user asked to keep); injected into the new user message. */
  savedMemoryXml?: string;
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
  /** Provider-reported token totals for the turn (all model calls); null when the provider reported none. */
  usage: TokenUsage | null;
}

/** Readable line for a truncation trace row (the Runs view shows `label` under the humanised stage name). */
function truncationLabel(t: TruncationEvent): string {
  if (t.kind === "answer") {
    return t.action === "continue"
      ? `Answer reached the output limit at step ${t.step}; asked the model to continue`
      : "Answer still cut off after one continuation; marked as cut off";
  }
  return t.action === "retry"
    ? `A tool call was cut off at step ${t.step}; it was not run and the step was retried`
    : "The tool call was cut off again; answered without it";
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

/** Saved memories are context, never a reason to fail a turn. */
function safeSavedMemory(db: DatabaseSync, query: string): string | undefined {
  try {
    return renderSavedMemoryBlock(db, { query }) ?? undefined;
  } catch {
    return undefined;
  }
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
  // First-turn uploads are readable by any chat until bound: bind them to THIS conversation right away (not after
  // the turn, which never happens if the turn fails) and drop the temporary read grant.
  if (input.attachmentIds?.length) {
    const bind = db.prepare(`UPDATE attachments SET conversation_id = ? WHERE id = ? AND conversation_id IS NULL`);
    for (const id of input.attachmentIds) bind.run(conversationId, id);
    revokeTurnAttachments(input.attachmentIds);
  }

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

  let memoryXml = recall ? renderMemoryBlock(recall, tz, db) ?? undefined : undefined;
  if (!memoryXml && readPrefs(db).memoryRecall && PERSONAL_QUESTION.test(input.message)) {
    // No date or "you said" cue, but this is about the user: look through what they told us in earlier chats.
    try {
      const found = runMemorySearch(new MemoryStore(db), { query: input.message, limit: 4 }, { excludeTurnId: turn.id, statementsOnly: true });
      if (found.count > 0) memoryXml = found.xml;
    } catch {
      /* recall is best-effort */
    }
  }

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
  // Compact results of tools run in earlier turns of this chat, so follow-ups can reuse them (not citable).
  let previousToolResultsXml: string | undefined;
  try {
    previousToolResultsXml = renderRecentToolResults(db, conversationId);
  } catch {
    previousToolResultsXml = undefined; // an unreadable history must never block the turn
  }
  const { system, messages } = buildContext({
    clock,
    tz,
    history,
    userMessage: input.contextMessage ?? input.message,
    memoryXml: memoryXml ?? undefined,
    savedMemoryXml: input.savedMemoryXml ?? safeSavedMemory(db, input.message),
    previousToolResultsXml,
    customInstructions: composeUserContext(prefs) || undefined,
  });

  let loopResult: Awaited<ReturnType<typeof runAgentLoop>>;
  try {
    const tLoop0 = clock.now().getTime();
    let searchBatch = 0;
    let truncations = 0;
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
      onToolTrace: (t) => {
        handlers.onToolTrace?.(t);
        // `tool` duplicates `name`: the Runs view titles unknown stages from detail.tool and detail.label.
        trace.record("tool", t.ms, {
          id: t.id,
          name: t.name,
          tool: t.name,
          label: t.label,
          step: t.step,
          ...(t.error ? { error: t.error } : {}),
          ...(t.duplicate ? { duplicate: true } : {}),
          ...(t.declined ? { declined: true } : {}),
        });
      },
      onTruncation: (t) => {
        handlers.onTruncation?.(t);
        truncations += 1;
        trace.record("truncation", 0, { ...t, label: truncationLabel(t) });
      },
    };
    // Pass db/store/approvalMode so loop can run memory_search/lookup_claims and gate permissions.
    // Called from server.ts POST /api/chat. Tools and their approval policy come from src/tools/registry.ts.
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
      turnId: turn.id,
      conversationId,
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
      toolCalls: loopResult.toolCalls.length,
      budget: loopResult.budget ?? null,
      inputTokens: loopResult.usage?.inputTokens ?? null,
      outputTokens: loopResult.usage?.outputTokens ?? null,
      ...(loopResult.stepUsage.length ? { usage: loopResult.stepUsage } : {}),
      ...(truncations ? { truncations } : {}),
    });
    try {
      saveToolResults(db, turn.id, loopResult.toolCalls);
    } catch {
      /* persisting tool results is an optimisation; the answer matters more */
    }
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
    usage: loopResult.usage,
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
