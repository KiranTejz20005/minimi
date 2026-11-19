import type { MemoryStore } from "./store.js";
import type { RetrieverResult } from "./retrieve.js";
import { DateTime } from "luxon";

export function formatMemoryBlock(
  result: RetrieverResult,
  store: MemoryStore,
  tz: string,
): string | null {
  if (result.status === "none") return null;

  if (result.status === "miss") {
    const dates = result.checkedDates
      .map((d: string) => formatLocalDate(d, tz))
      .join(", ");
    let xml = `<memory status="miss" resolved="${escapeAttr(result.resolvedLabel)}">\n`;
    xml += `No stored conversation for ${dates || "that date"}.\n`;
    if (result.nearest) {
      xml += `  <nearest id="${result.nearest.id}" date="${formatLocalDate(result.nearest.local_date, tz)}">${escapeText(
        truncate(result.nearest.user_question, 200),
      )}</nearest>\n`;
    }
    xml += `</memory>`;
    return xml;
  }

  let xml = `<memory status="hit" resolved="${escapeAttr(result.resolvedLabel)}"`;
  if (result.date_adjusted) xml += ` date_adjusted="true"`;
  if (result.date_mismatch) xml += ` date_mismatch="true"`;
  xml += `>\n`;

  for (const t of result.turns) {
    const title = t.conversation_title ?? t.topic ?? truncate(t.user_question, 40);
    xml += `  <turn id="${t.id}" date="${formatLocalDate(t.local_date, tz)}" conversation="${escapeAttr(title)}">\n`;
    xml += `    <user>${escapeText(truncate(t.user_question, 2000))}</user>\n`;
  if (t.assistant_answer) {
      xml += `    <assistant>${escapeText(truncate(t.assistant_answer, 4500))}</assistant>\n`;
    }
    const claims = store.claimsForTurn(t.id);
    if (claims.length) {
      xml += `    <claims>\n`;
      for (const c of claims) {
        xml += `      <claim subject="${escapeAttr(c.subject)}" attribute="${escapeAttr(c.attribute)}" value="${escapeAttr(c.value)}" as_of="${c.as_of}" source="${escapeAttr(c.source_url ?? "")}"/>\n`;
      }
      xml += `    </claims>\n`;
    }
    xml += `  </turn>\n`;
  }

  if (result.otherQuestions.length) {
    xml += `  <other_questions_that_day>\n`;
    for (const q of result.otherQuestions) {
      xml += `    <q id="${q.id}" time="${q.time}">${escapeText(q.question)}</q>\n`;
    }
    xml += `  </other_questions_that_day>\n`;
  }

  xml += `</memory>`;
  return xml;
}

export const renderMemoryBlock = formatMemoryBlock;

export function memoryStatusText(result: RetrieverResult, tz: string): string | null {
  if (result.status === "none") return null;
  if (result.status === "miss") {
    return `No saved conversation for ${result.checkedDates[0] ? formatLocalDate(result.checkedDates[0], tz) : "that date"}`;
  }
  if (result.date_adjusted && result.turns[0]) {
    return `Nothing on that day — found it on ${formatLocalDate(result.turns[0].local_date, tz)}`;
  }
  if (result.turns[0]) {
    return `Found your conversation from ${formatLocalDate(result.turns[0].local_date, tz)}`;
  }
  return null;
}

function formatLocalDate(ymd: string, tz: string): string {
  const dt = DateTime.fromISO(ymd, { zone: tz });
  return dt.isValid ? dt.toFormat("ccc d LLL yyyy") : ymd;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
