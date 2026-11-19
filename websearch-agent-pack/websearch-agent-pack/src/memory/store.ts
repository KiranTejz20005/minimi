import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DateTime } from "luxon";
import type { Clock } from "../clock.js";
import { newId } from "../util/ids.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

export interface TurnRow {
  id: string;
  user_id: string;
  conversation_id: string;
  user_message_id: string;
  assistant_message_id: string | null;
  created_at: string;
  tz: string;
  local_date: string;
  local_time: string;
  topic: string | null;
  entities: string | null;
  digest_status: string;
  status: string;
  is_demo: number;
}

export type TurnWithContent = TurnRow & {
  user_question: string;
  assistant_answer: string | null;
  conversation_title: string | null;
};

export interface ClaimRow {
  id: string;
  turn_id: string;
  subject: string;
  attribute: string;
  value: string;
  as_of: string;
  source_url: string | null;
  volatility: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface ConversationRow {
  id: string;
  user_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export function localParts(
  now: Date,
  tz: string,
): { localDate: string; localTime: string; createdAt: string } {
  const dt = DateTime.fromJSDate(now, { zone: tz });
  return {
    localDate: dt.toISODate()!,
    localTime: dt.toFormat("HH:mm"),
    createdAt: dt.toUTC().toISO()!,
  };
}

export function ensureConversation(
  db: DatabaseSync,
  id: string,
  title: string | null,
  createdAt: string,
  userId = "local",
): ConversationRow {
  const existing = getConversation(db, id);
  if (existing) return existing;
  db.prepare(
    `INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, userId, title, createdAt, createdAt);
  return getConversation(db, id)!;
}

export function createConversation(
  db: DatabaseSync,
  clock: Clock,
  title: string | null,
  userId = "local",
): ConversationRow {
  const id = newId("c");
  const { createdAt } = localParts(clock.now(), "UTC");
  db.prepare(
    `INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, userId, title, createdAt, createdAt);
  return {
    id,
    user_id: userId,
    title,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

export function appendMessage(
  db: DatabaseSync,
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  createdAt: string,
): MessageRow {
  const id = newId("m");
  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, conversationId, role, content, createdAt);
  db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(
    createdAt,
    conversationId,
  );
  return { id, conversation_id: conversationId, role, content, created_at: createdAt };
}

export function createTurn(
  db: DatabaseSync,
  input: {
    conversationId: string;
    userMessageId: string;
    clock: Clock;
    tz: string;
    isDemo?: boolean;
  },
): TurnRow {
  const id = newId("t");
  const parts = localParts(input.clock.now(), input.tz);
  db.prepare(
    `INSERT INTO turns (id, user_id, conversation_id, user_message_id, created_at, tz, local_date, local_time, is_demo)
     VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.conversationId,
    input.userMessageId,
    parts.createdAt,
    input.tz,
    parts.localDate,
    parts.localTime,
    input.isDemo ? 1 : 0,
  );
  return getTurn(db, id)!;
}

export function completeTurn(
  db: DatabaseSync,
  turnId: string,
  assistantMessageId: string,
  status: "ok" | "error" | "aborted" = "ok",
): void {
  db.prepare(
    `UPDATE turns SET assistant_message_id = ?, status = ? WHERE id = ?`,
  ).run(assistantMessageId, status, turnId);
}

export function getTurn(db: DatabaseSync, id: string): TurnRow | null {
  return db
    .prepare(`SELECT * FROM turns WHERE id = ?`)
    .get(id) as unknown as TurnRow | null;
}

export function turnsInWindow(
  db: DatabaseSync,
  start: string,
  end: string,
  userId = "local",
): TurnRow[] {
  return db
    .prepare(
      `SELECT * FROM turns WHERE user_id = ? AND local_date >= ? AND local_date <= ? AND status != 'aborted' ORDER BY created_at`,
    )
    .all(userId, start, end) as unknown as TurnRow[];
}

export function allTurnsForRanking(db: DatabaseSync, userId = "local"): TurnRow[] {
  return db
    .prepare(
      `SELECT * FROM turns WHERE user_id = ? AND status != 'aborted' ORDER BY created_at DESC`,
    )
    .all(userId) as unknown as TurnRow[];
}

export function getMessage(db: DatabaseSync, id: string): MessageRow | null {
  return db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as unknown as MessageRow | null;
}

export function getConversationMessages(
  db: DatabaseSync,
  conversationId: string,
): MessageRow[] {
  return db
    .prepare(
      `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at`,
    )
    .all(conversationId) as unknown as MessageRow[];
}

export function listConversations(db: DatabaseSync, userId = "local") {
  return db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c WHERE c.user_id = ? ORDER BY c.updated_at DESC`,
    )
    .all(userId) as unknown as (ConversationRow & { message_count: number })[];
}

export function getConversation(
  db: DatabaseSync,
  id: string,
): ConversationRow | null {
  return db
    .prepare(`SELECT * FROM conversations WHERE id = ?`)
    .get(id) as unknown as ConversationRow | null;
}

export function claimsForTurn(db: DatabaseSync, turnId: string): ClaimRow[] {
  return db
    .prepare(`SELECT * FROM claims WHERE turn_id = ?`)
    .all(turnId) as unknown as ClaimRow[];
}

export function saveClaims(
  db: DatabaseSync,
  turnId: string,
  claims: Omit<ClaimRow, "id" | "turn_id">[],
): void {
  db.prepare(`DELETE FROM claims WHERE turn_id = ?`).run(turnId);
  const insert = db.prepare(
    `INSERT INTO claims (id, turn_id, subject, attribute, value, as_of, source_url, volatility)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const c of claims) {
    insert.run(
      newId("cl"),
      turnId,
      c.subject,
      c.attribute,
      c.value,
      c.as_of,
      c.source_url,
      c.volatility,
    );
  }
}

export function saveSources(
  db: DatabaseSync,
  turnId: string,
  sources: {
    n: number;
    url: string;
    title?: string;
    publishedAt?: string;
    retrievedAt: string;
    cited: boolean;
  }[],
): void {
  db.prepare(`DELETE FROM sources WHERE turn_id = ?`).run(turnId);
  const insert = db.prepare(
    `INSERT INTO sources (id, turn_id, n, url, title, published_at, retrieved_at, cited)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const s of sources) {
    insert.run(
      newId("s"),
      turnId,
      s.n,
      s.url,
      s.title ?? null,
      s.publishedAt ?? null,
      s.retrievedAt,
      s.cited ? 1 : 0,
    );
  }
}

export function insertTurnAt(
  db: DatabaseSync,
  input: {
    conversationId: string;
    userContent: string;
    assistantContent: string;
    localDate: string;
    localTime: string;
    tz: string;
    title?: string;
    topic?: string;
    entities?: string[];
    isDemo?: boolean;
    claims?: Omit<ClaimRow, "id" | "turn_id">[];
  },
): TurnRow {
  const atUtc = DateTime.fromISO(`${input.localDate}T${input.localTime}`, {
    zone: input.tz,
  })
    .toUTC()
    .toISO()!;
  const conv = ensureConversation(
    db,
    input.conversationId,
    input.title ?? null,
    atUtc,
  );
  const userMsg = appendMessage(
    db,
    conv.id,
    "user",
    input.userContent,
    atUtc,
  );
  const asstMsg = appendMessage(
    db,
    conv.id,
    "assistant",
    input.assistantContent,
    atUtc,
  );
  const turnId = newId("t");
  db.prepare(
    `INSERT INTO turns (id, conversation_id, user_message_id, assistant_message_id, created_at, tz, local_date, local_time, topic, entities, digest_status, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'done', ?)`,
  ).run(
    turnId,
    conv.id,
    userMsg.id,
    asstMsg.id,
    atUtc,
    input.tz,
    input.localDate,
    input.localTime,
    input.topic ?? null,
    input.entities ? JSON.stringify(input.entities) : null,
    input.isDemo ? 1 : 0,
  );
  if (input.claims?.length) {
    saveClaims(
      db,
      turnId,
      input.claims.map((c) => ({ ...c, as_of: c.as_of || input.localDate })),
    );
  }
  return getTurn(db, turnId)!;
}

export type TraceRecord = { stage: string; started_ms: number; duration_ms: number; detail: string | null };

export function getTracesForTurn(db: DatabaseSync, turnId: string): TraceRecord[] {
  return db
    .prepare(
      `SELECT stage, started_ms, duration_ms, detail FROM traces WHERE turn_id = ? ORDER BY started_ms`,
    )
    .all(turnId) as unknown as TraceRecord[];
}

export function countSearchesInTraces(
  db: DatabaseSync,
  turnId: string,
): number {
  const rows = db
    .prepare(`SELECT detail FROM traces WHERE turn_id = ? AND stage = 'search'`)
    .all(turnId) as { detail: string | null }[];
  let n = 0;
  for (const r of rows) {
    if (!r.detail) continue;
    try {
      const d = JSON.parse(r.detail) as { count?: number };
      n += d.count ?? 1;
    } catch {
      n += 1;
    }
  }
  return n;
}

function mapTurnWithContent(row: Record<string, unknown>): TurnWithContent {
  const base = row as unknown as TurnRow;
  return {
    ...base,
    user_question: String(row.user_question),
    assistant_answer: row.assistant_answer ? String(row.assistant_answer) : null,
    conversation_title: row.conversation_title ? String(row.conversation_title) : null,
  };
}

const TURN_SELECT = `SELECT t.*, um.content AS user_question, am.content AS assistant_answer, c.title AS conversation_title
FROM turns t
JOIN messages um ON um.id = t.user_message_id
LEFT JOIN messages am ON am.id = t.assistant_message_id
JOIN conversations c ON c.id = t.conversation_id`;

export class MemoryStore {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(dbPath: string): MemoryStore {
    mkdirSync(dirname(dbPath), { recursive: true });
    const database = new DatabaseSync(dbPath);
    database.exec(readFileSync(join(ROOT, "schema.sql"), "utf8"));
    return new MemoryStore(database);
  }

  turnsInDateRange(start: string, end: string, userId = "local"): TurnWithContent[] {
    const rows = this.db
      .prepare(
        `${TURN_SELECT}
         WHERE t.user_id = ? AND t.local_date >= ? AND t.local_date <= ? AND t.status != 'aborted'
         ORDER BY t.created_at`,
      )
      .all(userId, start, end) as Record<string, unknown>[];
    return rows.map(mapTurnWithContent);
  }

  allTurnsForRanking(userId = "local"): TurnWithContent[] {
    const rows = this.db
      .prepare(
        `${TURN_SELECT}
         WHERE t.user_id = ? AND t.status != 'aborted'
         ORDER BY t.created_at DESC`,
      )
      .all(userId) as Record<string, unknown>[];
    return rows.map(mapTurnWithContent);
  }

  nearestTurn(targetDate: string, userId = "local"): TurnWithContent | null {
    const row = this.db
      .prepare(
        `${TURN_SELECT}
         WHERE t.user_id = ? AND t.status != 'aborted'
         ORDER BY ABS(julianday(t.local_date) - julianday(?)) ASC, t.local_time ASC
         LIMIT 1`,
      )
      .get(userId, targetDate) as Record<string, unknown> | undefined;
    return row ? mapTurnWithContent(row) : null;
  }

  claimsForTurn(turnId: string): ClaimRow[] {
    return claimsForTurn(this.db, turnId);
  }

  replaceClaims(turnId: string, claims: Omit<ClaimRow, "id" | "turn_id">[]): void {
    saveClaims(this.db, turnId, claims);
  }

  setDigestMeta(
    turnId: string,
    topic: string,
    entities: string[],
    status: "done" | "failed" | "skipped",
  ): void {
    this.db
      .prepare(`UPDATE turns SET topic = ?, entities = ?, digest_status = ? WHERE id = ?`)
      .run(topic, JSON.stringify(entities), status, turnId);
  }

  pendingDigests(limit = 50): { id: string; local_date: string }[] {
    return this.db
      .prepare(
        `SELECT id, local_date FROM turns
         WHERE digest_status = 'pending' AND status = 'ok' AND assistant_message_id IS NOT NULL
         LIMIT ?`,
      )
      .all(limit) as { id: string; local_date: string }[];
  }

  turnAnswer(turnId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT am.content FROM turns t
         JOIN messages am ON am.id = t.assistant_message_id WHERE t.id = ?`,
      )
      .get(turnId) as { content: string } | undefined;
    return row?.content ?? null;
  }

  sourcesForTurn(turnId: string): { url: string; title: string | null }[] {
    return this.db
      .prepare(`SELECT url, title FROM sources WHERE turn_id = ? ORDER BY n`)
      .all(turnId) as { url: string; title: string | null }[];
  }
}

export function openMemoryStore(dbPath: string): MemoryStore {
  return MemoryStore.open(dbPath);
}
