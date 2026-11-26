import { FileRejected } from "./errors.js";
import { parseDelimited } from "./csv.js";
import { runIsolated } from "./run-isolated.js";
import { decodeTextStrict, MAX_BINARY_BYTES, MAX_TEXT_CHARS, sniffBytes, sniffTextName, type FileKind } from "./sniff.js";
import { readZipDirectory, verifyZipSafe } from "./zip.js";

/**
 * Extraction happens ONCE, at upload. The plain text goes to attachments.content and the structure to attachments.meta.
 *
 * PDF and XLSX are parsed by third-party code (pdf.js, read-excel-file) in a separate worker thread with its own
 * heap limit, memory watchdog and a wall clock that terminates the thread (run-isolated.ts, worker.ts). XLSX
 * archives are first checked here, cheaply and in full (zip.ts), so a zip bomb never reaches that worker.
 *
 * Stored text formats (the reader in doc.ts parses exactly these):
 *   pdf  : "=== page 1 ===\n\n<text>\n\n=== page 2 ===\n\n<text>..."   (marker line = PAGE_MARKER)
 *   xlsx : "=== sheet: Name ===\n<row>\n<row>..." rows are TAB-separated, row 1 is the header, one line per row
 *   csv  : the original delimited text (meta.delimiter says which delimiter)
 *   text : the original text
 * Any line in document text that would look like one of our markers is defused ("=​=="), so a hostile file
 * cannot forge a page or sheet boundary.
 */
export const pageMarker = (n: number) => `=== page ${n} ===`;
export const sheetMarker = (name: string) => `=== sheet: ${name} ===`;

export const LIMITS = {
  pdfPages: 200,
  pdfChars: 1_000_000,
  xlsxSheets: 20,
  xlsxRowsPerSheet: 20_000,
  xlsxCols: 100,
  xlsxCells: 400_000,
  xlsxChars: 1_000_000,
  /** informational: the enforced wall clock is ISOLATION_LIMITS.timeoutMs in run-isolated.ts (same value) */
  timeoutMs: 25_000,
} as const;

export type SheetMeta = { name: string; rows: number; cols: number; header?: string[] };
export type AttachmentMeta = {
  kind: FileKind;
  pages?: number;
  sheets?: SheetMeta[];
  truncated?: boolean;
  truncatedReason?: string;
  delimiter?: string;
  originalMime: string | null;
  originalSize: number;
};
export type Extracted = { kind: FileKind; text: string; meta: AttachmentMeta };

export type UploadInput = { name: string; mime?: string | null; bytes?: Uint8Array; text?: string };

// ── text / csv ───────────────────────────────────────────────────────────────
function extractText(kind: "csv" | "text", text: string, base: Pick<AttachmentMeta, "originalMime" | "originalSize">): Extracted {
  if (text.includes("\u0000")) throw new FileRejected("not_text", "Only text, CSV, PDF and XLSX files are supported (NUL bytes found).");
  if (text.length > MAX_TEXT_CHARS) throw new FileRejected("too_large", "File too large (max 500 KB of text)");
  if (!text.trim()) throw new FileRejected("empty", "File is empty");
  text = text.replace(/^﻿/, "");
  const meta: AttachmentMeta = { kind, ...base };
  if (kind === "csv") {
    const p = parseDelimited(text, { maxRows: 200_000, maxCols: 500 });
    if (p.rows.length) {
      const cols = p.rows.reduce((m, r) => Math.max(m, r.length), 0);
      // Rows are padded to the widest row when read: bound rows x cols so one wide row cannot multiply into gigabytes.
      if (p.rows.length * cols > 1_000_000) throw new FileRejected("too_large", "This table is too large (more than 1,000,000 cells). Split it or remove columns.");
      meta.delimiter = p.delimiter;
      meta.sheets = [{ name: "data", rows: Math.max(0, p.rows.length - 1), cols, header: p.rows[0].slice(0, 40).map((h) => h.trim().slice(0, 60)) }];
    } else meta.kind = "text";
  }
  return { kind: meta.kind, text, meta };
}

// ── PDF / XLSX: checked here, parsed in the isolated worker ─────────────────
async function extractBinary(kind: "pdf" | "xlsx", bytes: Uint8Array, base: Pick<AttachmentMeta, "originalMime" | "originalSize">): Promise<Extracted> {
  if (kind === "xlsx") {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries = readZipDirectory(buf);
    if (!entries.some((e) => e.name === "xl/workbook.xml")) {
      throw new FileRejected("signature_mismatch", "This file is a ZIP archive but not an Excel workbook (xl/workbook.xml is missing).");
    }
    // Local headers == central directory, then a streaming inflate budget: the worst case is rejected before any worker starts.
    await verifyZipSafe(buf, entries);
  }
  const doc = await runIsolated(kind, bytes);
  const meta: AttachmentMeta = { kind, ...(doc.pages !== undefined ? { pages: doc.pages } : {}), ...(doc.sheets ? { sheets: doc.sheets } : {}), ...base };
  if (doc.truncated) {
    meta.truncated = true;
    meta.truncatedReason = doc.truncatedReason;
  }
  return { kind, text: doc.text, meta };
}

/** Validate + extract one upload. Throws FileRejected (never anything else for hostile input). */
export async function extractUpload(input: UploadInput): Promise<Extracted> {
  const mime = input.mime ? String(input.mime).slice(0, 120) : null;
  if (input.bytes) {
    const bytes = input.bytes;
    if (!bytes.length) throw new FileRejected("empty", "File is empty");
    const kind = sniffBytes(input.name, bytes);
    const originalSize = bytes.length;
    if (kind === "pdf" || kind === "xlsx") {
      if (bytes.length > MAX_BINARY_BYTES) throw new FileRejected("too_large", `File too large (max ${MAX_BINARY_BYTES / 1024 / 1024} MB for PDF/XLSX)`);
      return extractBinary(kind, bytes, { originalMime: mime, originalSize });
    }
    if (bytes.length > MAX_TEXT_CHARS * 4) throw new FileRejected("too_large", "File too large (max 500 KB of text)");
    return extractText(kind, decodeTextStrict(bytes), { originalMime: mime, originalSize });
  }
  const text = input.text ?? "";
  const kind = sniffTextName(input.name);
  return extractText(kind as "csv" | "text", text, { originalMime: mime, originalSize: text.length });
}
