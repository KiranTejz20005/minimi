import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../clock.js";
import { bm25Score, BM25_MATCH_THRESHOLD, tokenize } from "./bm25.js";
import { MemoryStore, type TurnWithContent } from "./store.js";
import type { TimeRef } from "./temporal.js";
import { formatDisplayDate, stripDateExpressions } from "./temporal.js";
import { formatMemoryBlock } from "./format.js";

const CUE_RE =
  /\b(asked|told|said|discussed|shortlisted|earlier|previously|your answer|again)\b/i;

export type RecalledTurn = TurnWithContent & { score?: number };

export type RetrieverResult =
  | {
      status: "hit";
      resolvedLabel: string;
      date_adjusted?: boolean;
      date_mismatch?: boolean;
      turns: RecalledTurn[];
      otherQuestions: { id: string; time: string; question: string }[];
    }
  | {
      status: "miss";
      resolvedLabel: string;
      checkedDates: string[];
      nearest: RecalledTurn | null;
    }
  | { status: "none" };

export function retrieve(
  db: DatabaseSync,
  message: string,
  timeRefs: TimeRef[],
  tz: string,
  _conversationId?: string,
): AgentRecall;
export function retrieve(
  message: string,
  timeRefs: TimeRef[],
  tz: string,
  clock: Clock,
  store: MemoryStore,
): RetrieverResult;
export function retrieve(
  a: DatabaseSync | string,
  b: string | TimeRef[],
  c: TimeRef[] | string,
  d: string | Clock,
  e?: string | MemoryStore,
): RetrieverResult | AgentRecall {
  if (typeof a !== "string") {
  const r = retrieveCore(b as string, c as TimeRef[], d as string, { now: () => new Date() }, new MemoryStore(a));
    return toAgentRecall(r);
  }
  return retrieveCore(a, b as TimeRef[], c as string, d as Clock, e as MemoryStore);
}

/** Agent-facing recall shape (legacy `kind` field). */
export type RecallResult = AgentRecall;

export type AgentRecall =
  | {
      kind: "hit";
      turns: {
        id: string;
        localDate: string;
        question: string;
        answer: string | null;
      }[];
      otherQuestions: { id: string; time: string; question: string }[];
      dateAdjusted?: boolean;
      dateMismatch?: boolean;
      resolvedLabel: string;
    }
  | { kind: "miss"; resolvedDates: string[]; nearest?: { id: string; localDate: string; question: string } };

function retrieveCore(
  message: string,
  timeRefs: TimeRef[],
  tz: string,
  _clock: Clock,
  store: MemoryStore,
): RetrieverResult {
  const hasCue = CUE_RE.test(message);
  const listAllOnDay =
    /\bwhat did (i|we) ask\b/i.test(message) ||
    /\bwhat did we talk about\b/i.test(message);
  const topic = listAllOnDay
    ? ""
    : tokenize(stripDateExpressions(message)).join(" ");
  const lastWeekdayMention = /\blast\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(
    message,
  );
  const explicitCalendarDay =
    (!lastWeekdayMention &&
      /\b(on\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(
        message,
      )) ||
    /\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(message);

  if (timeRefs.length === 0 && !hasCue) {
    return { status: "none" };
  }

  const resolvedLabel =
    timeRefs.length > 0
      ? timeRefs
          .map((r) => `'${r.text}' → ${formatDisplayDate(r.candidates[0]!.start, tz)}`)
          .join("; ")
      : "topic recall";

  if (timeRefs.length > 0) {
    let matched: TurnWithContent[] = [];
    let date_adjusted = false;
    let date_mismatch = false;
    const checkedDates: string[] = [];

    for (const ref of timeRefs) {
      for (const win of ref.candidates) {
        checkedDates.push(win.start, win.end);
        let rows = store.turnsInDateRange(win.start, win.end);
        if (topic) rows = applyTopicFilter(rows, topic, explicitCalendarDay);
        if (rows.length) {
          matched = rows;
          break;
        }
      }
      if (matched.length) break;
    }

    if (!matched.length && timeRefs[0]) {
      const win = timeRefs[0].candidates[0]!;
      const widened = {
        start: shiftDate(win.start, -1),
        end: shiftDate(win.end, 1),
      };
      checkedDates.push(widened.start, widened.end);
      let rows = store.turnsInDateRange(widened.start, widened.end);
      if (topic) rows = applyTopicFilter(rows, topic, explicitCalendarDay);
      if (rows.length) {
        matched = rows;
        date_adjusted = true;
      }
    }

    if (!matched.length && topic && !explicitCalendarDay) {
      const rows = filterByTopic(store.allTurnsForRanking(), topic);
      if (rows.length) {
        matched = rows;
        date_mismatch = true;
      }
    }

    if (!matched.length) {
      const anchor = timeRefs[0]?.candidates[0]?.start ?? "2999-12-31";
      return {
        status: "miss",
        resolvedLabel,
        checkedDates: [...new Set(checkedDates)],
        nearest: store.nearestTurn(anchor),
      };
    }

    return packHit(matched, topic, resolvedLabel, date_adjusted, date_mismatch);
  }

  if (!topic) {
    return {
      status: "miss",
      resolvedLabel,
      checkedDates: [],
      nearest: store.nearestTurn("2999-12-31"),
    };
  }

  const ranked = filterByTopic(store.allTurnsForRanking(), topic);
  if (!ranked.length) {
    return {
      status: "miss",
      resolvedLabel,
      checkedDates: [],
      nearest: store.nearestTurn("2999-12-31"),
    };
  }
  return packHit(ranked, topic, resolvedLabel, false, false);
}

function applyTopicFilter(
  rows: TurnWithContent[],
  topic: string,
  keepOnExplicitDay: boolean,
): RecalledTurn[] {
  const filtered = filterByTopic(rows, topic);
  if (filtered.length) return filtered;
  return keepOnExplicitDay && rows.length ? rows : [];
}

function filterByTopic(rows: TurnWithContent[], topic: string): RecalledTurn[] {
  if (!topic.trim()) return rows;
  const docs = rows.map(turnDoc);
  return rows
    .map((r, i) => ({ r, score: bm25Score(topic, docs[i]!, docs) }))
    .filter((x) => x.score >= BM25_MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .map((x) => ({ ...x.r, score: x.score }));
}

function turnDoc(r: TurnWithContent): string {
  const ents = r.entities ? (JSON.parse(r.entities) as string[]).join(" ") : "";
  return `${r.user_question} ${r.topic ?? ""} ${ents}`;
}

function packHit(
  rows: RecalledTurn[],
  topic: string,
  resolvedLabel: string,
  date_adjusted: boolean,
  date_mismatch: boolean,
): RetrieverResult {
  const ordered = topic
    ? rows
    : rows.sort(
        (a, b) =>
          a.local_date.localeCompare(b.local_date) ||
          a.local_time.localeCompare(b.local_time),
      );
  const primaryCap = topic ? 3 : 12;
  const full = ordered.slice(0, primaryCap);
  const daySet = new Set(full.map((t) => t.local_date));
  const others = topic
    ? ordered
        .slice(3)
        .filter((t) => daySet.has(t.local_date))
        .map((t) => ({
          id: t.id,
          time: t.local_time,
          question: truncate(t.user_question, 160),
        }))
    : ordered.slice(primaryCap).map((t) => ({
        id: t.id,
        time: t.local_time,
        question: truncate(t.user_question, 160),
      }));

  return {
    status: "hit",
    resolvedLabel,
    date_adjusted: date_adjusted || undefined,
    date_mismatch: date_mismatch || undefined,
    turns: full,
    otherQuestions: others,
  };
}

function shiftDate(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + delta));
  return dt.toISOString().slice(0, 10);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function recalledTurnIds(result: RetrieverResult | AgentRecall): string[] {
  if ("kind" in result) {
    return result.kind === "hit" ? result.turns.map((t) => t.id) : [];
  }
  if (result.status !== "hit") return [];
  return result.turns.map((t) => t.id);
}

function toAgentRecall(result: RetrieverResult): AgentRecall {
  if (result.status === "hit") {
    return {
      kind: "hit",
      turns: result.turns.map((t) => ({
        id: t.id,
        localDate: t.local_date,
        question: t.user_question,
        answer: t.assistant_answer,
      })),
      otherQuestions: result.otherQuestions,
      dateAdjusted: result.date_adjusted,
      dateMismatch: result.date_mismatch,
      resolvedLabel: result.resolvedLabel,
    };
  }
  return {
    kind: "miss",
    resolvedDates: result.status === "miss" ? result.checkedDates : [],
    nearest: result.status === "miss" && result.nearest
      ? {
          id: result.nearest.id,
          localDate: result.nearest.local_date,
          question: result.nearest.user_question.slice(0, 120),
        }
      : undefined,
  };
}

export function renderMemoryBlock(
  recall: RetrieverResult | AgentRecall,
  tz: string,
  db?: DatabaseSync,
): string | null {
  if ("kind" in recall) {
    if (db) {
      const core = agentRecallToRetriever(recall, tz);
      return formatMemoryBlock(core, new MemoryStore(db), tz);
    }
    if (recall.kind === "miss") {
      const dates = recall.resolvedDates.join(", ") || "that date";
      let xml = `<memory status="miss" resolved="${dates}">\nNo stored conversation for ${dates}.\n`;
      if (recall.nearest) {
        xml += `<nearest id="${recall.nearest.id}" date="${recall.nearest.localDate}">${recall.nearest.question}</nearest>\n`;
      }
      return `${xml}</memory>`;
    }
    let xml = `<memory status="hit" resolved="${recall.resolvedLabel}">\n`;
    for (const t of recall.turns) {
      xml += `  <turn id="${t.id}" date="${formatDisplayDate(t.localDate, tz)}">\n`;
      xml += `    <user>${t.question}</user>\n`;
      if (t.answer) xml += `    <assistant>${t.answer.slice(0, 4800)}</assistant>\n`;
      xml += `  </turn>\n`;
    }
    xml += `</memory>`;
    return xml;
  }
  if (!db) return null;
  return formatMemoryBlock(recall, new MemoryStore(db), tz);
}

function agentRecallToRetriever(recall: AgentRecall, tz: string): RetrieverResult {
  if (recall.kind === "miss") {
    return {
      status: "miss",
      resolvedLabel: recall.resolvedDates.join(", "),
      checkedDates: recall.resolvedDates,
      nearest: null,
    };
  }
  return {
    status: "hit",
    resolvedLabel: recall.resolvedLabel,
    date_adjusted: recall.dateAdjusted,
    date_mismatch: recall.dateMismatch,
    turns: recall.turns.map((t) => ({
      id: t.id,
      user_id: "local",
      conversation_id: "",
      user_message_id: "",
      assistant_message_id: null,
      created_at: "",
      tz,
      local_date: t.localDate,
      local_time: "",
      topic: null,
      entities: null,
      digest_status: "pending",
      status: "ok",
      is_demo: 0,
      user_question: t.question,
      assistant_answer: t.answer,
      conversation_title: null,
    })),
    otherQuestions: recall.otherQuestions,
  };
}
