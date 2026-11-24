import type { DatabaseSync } from "node:sqlite";
import { parseDelimited, squareRows } from "./csv.js";
import type { AttachmentMeta } from "./extract.js";

export type AttachmentRow = {
  id: string;
  name: string;
  mime: string | null;
  size: number;
  content: string;
  meta: string | null;
  conversation_id: string | null;
};

export type TableSheet = { name: string; /** rows[0] is the header row; row numbers are 1-based positions in this array */ rows: string[][] };
export type Doc =
  | { type: "pdf"; pages: string[] }
  | { type: "table"; fileKind: "csv" | "xlsx"; sheets: TableSheet[] }
  | { type: "text"; text: string };

export function parseMeta(raw: string | null | undefined): AttachmentMeta | null {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw);
    return m && typeof m === "object" ? (m as AttachmentMeta) : null;
  } catch {
    return null;
  }
}

const extOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

/** Display kind string for the UI ("PDF", "XLSX", "CSV", ...). Mirrors fileKind() in routes.ts. */
export function kindLabel(row: Pick<AttachmentRow, "name" | "meta">): string {
  const m = parseMeta(row.meta);
  if (m?.kind === "pdf") return "PDF";
  if (m?.kind === "xlsx") return "XLSX";
  if (m?.kind === "csv") return "CSV";
  const e = extOf(row.name);
  if (e === "pdf") return "PDF";
  if (e === "xlsx" || e === "xlsm") return "XLSX";
  if (e === "csv" || e === "tsv") return "CSV";
  return "TXT";
}

/** Re-parse the stored extraction text (formats are documented at the top of extract.ts). */
export function loadDoc(row: Pick<AttachmentRow, "name" | "content" | "meta">): Doc {
  const meta = parseMeta(row.meta);
  const kind = meta?.kind ?? (extOf(row.name) === "csv" || extOf(row.name) === "tsv" ? "csv" : "text");
  if (kind === "pdf") {
    const parts = row.content.split(/^=== page (\d+) ===\n?/m);
    const pages: string[] = [];
    for (let i = 1; i + 1 < parts.length; i += 2) pages[Number(parts[i]) - 1] = parts[i + 1].trim();
    for (let i = 0; i < pages.length; i++) pages[i] ??= "";
    return { type: "pdf", pages };
  }
  if (kind === "xlsx") {
    const parts = row.content.split(/^=== sheet: (.*) ===\n?/m);
    const sheets: TableSheet[] = [];
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const body = parts[i + 1].replace(/\n+$/, "");
      sheets.push({ name: parts[i], rows: squareRows(body === "" ? [] : body.split("\n").map((l) => l.split("\t"))) });
    }
    return { type: "table", fileKind: "xlsx", sheets };
  }
  if (kind === "csv") {
    const p = parseDelimited(row.content, { delimiter: (meta?.delimiter as never) || undefined, maxRows: 200_000, maxCols: 500 });
    return { type: "table", fileKind: "csv", sheets: [{ name: "data", rows: squareRows(p.rows) }] };
  }
  return { type: "text", text: row.content };
}

// ── Scope / authorization ────────────────────────────────────────────────────
// A grant only has to bridge attachmentContext() -> runTurn(), which binds the file to its conversation (and revokes it)
// within milliseconds; the rest of the TTL is slack for a turn that never starts.
const GRANT_TTL_MS = 2 * 60_000;
const grants = new Map<string, number>(); // attachment id -> expiry (ms)

/**
 * Unbound uploads (conversation_id IS NULL) become readable by read_attachment only if they were attached to a turn
 * the server accepted: attachmentContext() grants the ids named in the chat request. Ids are random and only ever
 * shown to the model for files it is entitled to, so another conversation cannot reach them by guessing.
 */
export function grantTurnAttachments(ids: string[], nowMs = Date.now()): void {
  for (const [k, exp] of grants) if (exp <= nowMs) grants.delete(k);
  for (const id of ids) grants.set(id, nowMs + GRANT_TTL_MS);
}
export function revokeTurnAttachments(ids: string[]): void {
  for (const id of ids) grants.delete(id);
}
const granted = (id: string, nowMs: number) => (grants.get(id) ?? 0) > nowMs;

const COLS = `id, name, mime, size, content, meta, conversation_id`;

/**
 * Attachments the current turn may read: bound to `conversationId`, or unbound AND granted for this turn.
 * Never returns another conversation's files.
 */
export function turnAttachmentScope(db: DatabaseSync, conversationId: string | undefined, nowMs = Date.now()): AttachmentRow[] {
  const rows: AttachmentRow[] = conversationId
    ? (db.prepare(`SELECT ${COLS} FROM attachments WHERE conversation_id = ? ORDER BY created_at, id`).all(conversationId) as AttachmentRow[])
    : [];
  const have = new Set(rows.map((r) => r.id));
  for (const [id, exp] of grants) {
    if (exp <= nowMs || have.has(id)) continue;
    const r = db.prepare(`SELECT ${COLS} FROM attachments WHERE id = ? AND conversation_id IS NULL`).get(id) as AttachmentRow | undefined;
    if (r && granted(id, nowMs)) rows.push(r);
  }
  return rows;
}
