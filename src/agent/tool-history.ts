import type { DatabaseSync } from "node:sqlite";
import { getClock } from "../clock.js";
import { getTool } from "../tools/registry.js";
import { newId } from "../util/ids.js";

/** A tool call as the loop reports it (AgentLoopResult.toolCalls) and as it is persisted. */
export type StoredToolCall = {
  id: string;
  name: string;
  label: string;
  input: unknown;
  content: string;
  error?: string;
  /** Answered from an earlier identical call this turn: nothing new to store. */
  duplicate?: boolean;
};

const MAX_STORED_CONTENT = 6000;
const MAX_STORED_INPUT = 2000;
/** Search results go stale quickly; fetched pages and memory lookups are reused for longer. */
const SEARCH_MAX_AGE_MS = 24 * 3600_000;

const NOTE =
  "results from earlier turns of this chat; not citable (no [n] numbers), may be stale - re-run the tool if freshness matters";

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s: string): string {
  return escText(s).replace(/"/g, "&quot;");
}

/** Persist the tool calls a turn executed (best effort per row; one bad row never loses the others). */
export function saveToolResults(db: DatabaseSync, turnId: string, calls: StoredToolCall[]): void {
  if (calls.length === 0) return;
  const at = getClock().now().toISOString();
  const stmt = db.prepare(
    `INSERT INTO tool_results (id, turn_id, call_id, name, label, input, content, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const c of calls) {
    if (c.duplicate) continue;
    let input: string | null = null;
    try {
      input = cap(JSON.stringify(c.input ?? null), MAX_STORED_INPUT);
    } catch {
      /* unserialisable input: store none */
    }
    try {
      stmt.run(newId("tr"), turnId, c.id, c.name, c.label ?? null, input, cap(c.content ?? "", MAX_STORED_CONTENT), c.error ?? null, at);
    } catch {
      /* e.g. the turn row was removed meanwhile */
    }
  }
}

type Row = { name: string; label: string | null; content: string; created_at: string; turn_id: string };

/**
 * Compact block of recent successful read-tool results for the NEW user message, so follow-ups ("and the
 * second one?") can reuse what was already fetched instead of searching again. The numbers `[n]` of old
 * search results are stripped: they belong to a finished turn and must not be cited.
 */
export function renderRecentToolResults(
  db: DatabaseSync,
  conversationId: string,
  opts: { maxTurns?: number; maxChars?: number } = {},
): string | undefined {
  const maxTurns = opts.maxTurns ?? 2;
  const maxChars = opts.maxChars ?? 3000;
  const turnIds = (
    db
      .prepare(
        `SELECT t.id FROM turns t
         WHERE t.conversation_id = ? AND EXISTS (SELECT 1 FROM tool_results r WHERE r.turn_id = t.id AND r.error IS NULL)
         ORDER BY t.created_at DESC, t.rowid DESC LIMIT ?`,
      )
      .all(conversationId, maxTurns) as { id: string }[]
  ).map((r) => r.id);
  if (turnIds.length === 0) return undefined;

  const now = getClock().now().getTime();
  const select = db.prepare(
    `SELECT name, label, content, created_at, turn_id FROM tool_results WHERE turn_id = ? AND error IS NULL ORDER BY created_at, rowid`,
  );
  const rows: Row[] = [];
  for (const id of turnIds) rows.push(...(select.all(id) as Row[]));

  const usable = rows.filter((r) => {
    const def = getTool(r.name);
    if (!def || def.effect === "write") return false;
    if (def.isSearch && now - new Date(r.created_at).getTime() > SEARCH_MAX_AGE_MS) return false;
    return !!r.content.trim();
  });
  if (usable.length === 0) return undefined;

  const parts: string[] = [];
  let remaining = maxChars;
  for (const r of usable) {
    if (remaining < 150) break;
    const clean = r.content.replace(/^\s*\[\d+\]\s*/gm, "").trim();
    const body = escText(cap(clean, Math.min(1200, remaining)));
    const part = `<tool_result name="${escAttr(r.name)}" label="${escAttr(r.label ?? "")}">\n${body}\n</tool_result>`;
    parts.push(part);
    remaining -= part.length;
  }
  if (parts.length === 0) return undefined;
  return `<previous_tool_results note="${NOTE}">\n${parts.join("\n")}\n</previous_tool_results>`;
}
