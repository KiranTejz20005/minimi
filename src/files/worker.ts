import { parentPort } from "node:worker_threads";
import { FileRejected } from "./errors.js";
import { LIMITS, pageMarker, sheetMarker, type SheetMeta } from "./extract.js";
import type { IsolatedKind, ParsedDoc, WorkerJob, WorkerReply } from "./run-isolated.js";

/**
 * The binary parsers. This module runs ONLY inside the extraction worker (run-isolated.ts starts it through
 * worker-boot.mjs): pdf.js and read-excel-file see hostile bytes here, under the worker's heap limits, memory
 * watchdog and wall clock. XLSX archives arrive already checked by zip.ts verifyZipSafe in the main thread.
 */

function defuse(s: string): string {
  return s.replace(/^=== (page \d+|sheet:)/gm, "=​== $1");
}
function stripControl(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

// ── PDF ──────────────────────────────────────────────────────────────────────
export async function parsePdf(bytes: Uint8Array): Promise<ParsedDoc> {
  const { getDocumentProxy } = await import("unpdf");
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // isEvalSupported:false keeps font programs from being eval'd. pdf.js may detach the buffer it is given.
    pdf = await getDocumentProxy(bytes, { isEvalSupported: false, verbosity: 0, stopAtErrors: false } as never);
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
      break;
    }
    chars += pageText.length;
    parts.push(`${pageMarker(n)}\n\n${pageText}`);
  }
  const text = parts.join("\n\n");
  if (!text.replace(/=== page \d+ ===/g, "").trim()) throw new FileRejected("no_text", "No extractable text in this PDF (it may be a scan or images only).");
  const doc: ParsedDoc = { kind: "pdf", text, pages: total };
  if (truncated) {
    doc.truncated = true;
    doc.truncatedReason = reason;
  }
  return doc;
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

export async function parseXlsx(bytes: Uint8Array): Promise<ParsedDoc> {
  const { default: readXlsxFile } = await import("read-excel-file/node");
  let sheets: { sheet: string; data: unknown[][] }[];
  try {
    sheets = (await readXlsxFile(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))) as never;
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
  const doc: ParsedDoc = { kind: "xlsx", text, sheets: sheetMetas };
  if (truncated) {
    doc.truncated = true;
    doc.truncatedReason = reason;
  }
  return doc;
}

// ── worker protocol ──────────────────────────────────────────────────────────
async function handle(job: WorkerJob): Promise<{ reply: WorkerReply; transfer: ArrayBuffer[] }> {
  const kind: IsolatedKind = job?.kind === "xlsx" ? "xlsx" : "pdf";
  try {
    if ((job?.kind !== "pdf" && job?.kind !== "xlsx") || !(job.bytes instanceof Uint8Array)) throw new Error("bad job");
    const doc = kind === "pdf" ? await parsePdf(job.bytes) : await parseXlsx(job.bytes);
    const payload = new TextEncoder().encode(JSON.stringify(doc));
    return { reply: { ok: true, payload }, transfer: [payload.buffer as ArrayBuffer] };
  } catch (e) {
    if (e instanceof FileRejected) return { reply: { ok: false, code: e.code, message: e.message }, transfer: [] };
    const message = kind === "pdf" ? "This PDF is corrupt or unreadable." : "This spreadsheet is corrupt or unreadable.";
    return { reply: { ok: false, code: "corrupt", message }, transfer: [] };
  }
}

/** Worker main: one job in, one reply out; the parent then terminates this thread. */
export function serve(): void {
  const port = parentPort;
  if (!port) throw new Error("serve() must run in a worker thread");
  port.once("message", (job: WorkerJob) => {
    void handle(job).then(({ reply, transfer }) => port.postMessage(reply, transfer));
  });
}
