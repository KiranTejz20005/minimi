import { FileRejected } from "./errors.js";
import { parseDelimited } from "./csv.js";
import { decodeTextStrict, MAX_BINARY_BYTES, MAX_TEXT_CHARS, sniffBytes, sniffTextName, type FileKind } from "./sniff.js";
import { readZipDirectory, verifyZipSafe } from "./zip.js";

/**
 * Extraction happens ONCE, at upload. The plain text goes to attachments.content and the structure to attachments.meta.
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

function defuse(s: string): string {
  return s.replace(/^=== (page \d+|sheet:)/gm, "=​== $1");
}
function stripControl(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => {
      onTimeout?.();
      rej(new FileRejected("timeout", "Extracting the file took too long."));
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(t!);
  }
}

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

// ── PDF ──────────────────────────────────────────────────────────────────────
async function extractPdf(bytes: Uint8Array, base: Pick<AttachmentMeta, "originalMime" | "originalSize">): Promise<Extracted> {
  const { getDocumentProxy } = await import("unpdf");
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  const run = async (): Promise<Extracted> => {
    try {
      // Copy: pdf.js transfers (detaches) the buffer it is given. isEvalSupported:false keeps font programs from being eval'd.
      pdf = await getDocumentProxy(new Uint8Array(bytes), { isEvalSupported: false, verbosity: 0, stopAtErrors: false } as never);
    } catch (e) {
      const name = (e as { name?: string }).name ?? "";
      if (name === "PasswordException") throw new FileRejected("encrypted", "This PDF is password-protected. Remove the password and upload it again.");
      throw new FileRejected("corrupt", "This PDF is corrupt or unreadable.");
    }
    const total = pdf.numPages;
    const limit = Math.min(total, LIMITS.pdfPages);
    const parts: string[] = [];
    let chars = 0;
    let truncated = total > LIMITS.pdfPages;
    let reason = truncated ? `only the first ${LIMITS.pdfPages} of ${total} pages were extracted` : undefined;
    let pagesDone = 0;
    for (let n = 1; n <= limit; n++) {
      let pageText = "";
      try {
        const content = await (await pdf.getPage(n)).getTextContent();
        pageText = (content.items as { str?: string; hasEOL?: boolean }[])
          .filter((it) => typeof it.str === "string")
          .map((it) => (it.str as string) + (it.hasEOL ? "\n" : ""))
          .join("");
      } catch {
        pageText = "";
      }
      pageText = defuse(stripControl(pageText).replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim());
      if (chars + pageText.length > LIMITS.pdfChars) {
        pageText = pageText.slice(0, Math.max(0, LIMITS.pdfChars - chars));
        truncated = true;
        reason = `text was cut at ${LIMITS.pdfChars} characters (page ${n})`;
        parts.push(`${pageMarker(n)}\n\n${pageText}`);
        pagesDone = n;
        break;
      }
      chars += pageText.length;
      parts.push(`${pageMarker(n)}\n\n${pageText}`);
      pagesDone = n;
    }
    const text = parts.join("\n\n");
    if (!text.replace(/=== page \d+ ===/g, "").trim()) throw new FileRejected("no_text", "No extractable text in this PDF (it may be a scan or images only).");
    const meta: AttachmentMeta = { kind: "pdf", pages: total, ...base };
    if (truncated) {
      meta.truncated = true;
      meta.truncatedReason = reason;
    }
    void pagesDone;
    return { kind: "pdf", text, meta };
  };
  const kill = () => {
    try {
      void Promise.resolve((pdf as unknown as { loadingTask?: { destroy?: () => unknown } } | undefined)?.loadingTask?.destroy?.()).catch(() => {});
    } catch {
      /* ignore */
    }
  };
  try {
    return await withTimeout(run(), LIMITS.timeoutMs, kill);
  } finally {
    kill();
  }
}

// ── XLSX ─────────────────────────────────────────────────────────────────────
function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return "";
    const iso = v.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 19) + "Z";
  }
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return stripControl(String(v)).replace(/[\t\r\n]+/g, " ").trim();
}

async function extractXlsx(bytes: Uint8Array, base: Pick<AttachmentMeta, "originalMime" | "originalSize">): Promise<Extracted> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = readZipDirectory(buf);
  if (!entries.some((e) => e.name === "xl/workbook.xml")) {
    throw new FileRejected("signature_mismatch", "This file is a ZIP archive but not an Excel workbook (xl/workbook.xml is missing).");
  }
  await verifyZipSafe(buf, entries);

  const { default: readXlsxFile } = await import("read-excel-file/node");
  let sheets: { sheet: string; data: unknown[][] }[];
  try {
    sheets = (await withTimeout(readXlsxFile(buf), LIMITS.timeoutMs)) as never;
  } catch (e) {
    if (e instanceof FileRejected) throw e;
    throw new FileRejected("corrupt", "This spreadsheet is corrupt or unreadable.");
  }

  const out: string[] = [];
  const sheetMetas: SheetMeta[] = [];
  let cells = 0;
  let chars = 0;
  let truncated = sheets.length > LIMITS.xlsxSheets;
  let reason = truncated ? `only the first ${LIMITS.xlsxSheets} of ${sheets.length} sheets were extracted` : undefined;
  const seen = new Set<string>();
  outer: for (const sh of sheets.slice(0, LIMITS.xlsxSheets)) {
    let name = stripControl(String(sh.sheet)).replace(/[\r\n]+/g, " ").trim().slice(0, 60) || "Sheet";
    for (let i = 2; seen.has(name.toLowerCase()); i++) name = `${name.replace(/ \(\d+\)$/, "")} (${i})`;
    seen.add(name.toLowerCase());
    const lines: string[] = [];
    let cols = 0;
    let header: string[] | undefined;
    for (let r = 0; r < sh.data.length; r++) {
      if (r >= LIMITS.xlsxRowsPerSheet) {
        truncated = true;
        reason = `sheet "${name}" was cut at ${LIMITS.xlsxRowsPerSheet} rows`;
        break;
      }
      const raw = sh.data[r].slice(0, LIMITS.xlsxCols);
      if (sh.data[r].length > LIMITS.xlsxCols) {
        truncated = true;
        reason = `sheet "${name}" was cut at ${LIMITS.xlsxCols} columns`;
      }
      const row = raw.map(cellText);
      while (row.length && row[row.length - 1] === "") row.pop();
      cells += row.length;
      if (cells > LIMITS.xlsxCells) {
        truncated = true;
        reason = `workbook was cut at ${LIMITS.xlsxCells} cells`;
        break;
      }
      cols = Math.max(cols, row.length);
      if (r === 0) header = row.slice(0, 40).map((h) => h.slice(0, 60));
      const line = defuse(row.join("\t"));
      chars += line.length + 1;
      if (chars > LIMITS.xlsxChars) {
        truncated = true;
        reason = `text was cut at ${LIMITS.xlsxChars} characters`;
        sheetMetas.push({ name, rows: Math.max(0, lines.length - 1), cols, header });
        out.push(`${sheetMarker(name)}\n${lines.join("\n")}`);
        break outer;
      }
      lines.push(line);
    }
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    sheetMetas.push({ name, rows: Math.max(0, lines.length - 1), cols, header });
    out.push(`${sheetMarker(name)}\n${lines.join("\n")}`);
  }
  const text = out.join("\n\n");
  if (!sheetMetas.some((s) => s.cols > 0)) throw new FileRejected("empty", "This spreadsheet has no data.");
  const meta: AttachmentMeta = { kind: "xlsx", sheets: sheetMetas, ...base };
  if (truncated) {
    meta.truncated = true;
    meta.truncatedReason = reason;
  }
  return { kind: "xlsx", text, meta };
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
      return kind === "pdf" ? extractPdf(bytes, { originalMime: mime, originalSize }) : extractXlsx(bytes, { originalMime: mime, originalSize });
    }
    if (bytes.length > MAX_TEXT_CHARS * 4) throw new FileRejected("too_large", "File too large (max 500 KB of text)");
    return extractText(kind, decodeTextStrict(bytes), { originalMime: mime, originalSize });
  }
  const text = input.text ?? "";
  const kind = sniffTextName(input.name);
  return extractText(kind as "csv" | "text", text, { originalMime: mime, originalSize: text.length });
}
