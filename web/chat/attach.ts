/*
 * Attachment helpers: file classification, client-side limits, chunked base64. Pure (no DOM/React); unit-tested.
 * Callers: Composer.tsx, FilesView.tsx. Limits mirror the server (10 MB pdf/xlsx, 500 KB text).
 */

export const MAX_TEXT_BYTES = 500_000;
export const MAX_BINARY_BYTES = 10 * 1024 * 1024;

export const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|log|ts|tsx|js|jsx|mjs|py|go|rs|java|c|h|cpp|html|css|sql|sh|yml|yaml|xml|toml|ini|env)$/i;
export const BINARY_EXT = /\.(pdf|xlsx)$/i;
export const ACCEPT =
  ".pdf,.xlsx,.txt,.md,.markdown,.csv,.tsv,.json,.log,.ts,.tsx,.js,.jsx,.mjs,.py,.go,.rs,.java,.c,.h,.cpp,.html,.css,.sql,.sh,.yml,.yaml,.xml,.toml,.ini,text/*,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type AttachClass = "text" | "pdf" | "xlsx";

export function classifyFile(name: string, mime = ""): AttachClass | null {
  if (/\.pdf$/i.test(name) || mime === "application/pdf") return "pdf";
  if (/\.xlsx$/i.test(name) || mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
  if (TEXT_EXT.test(name) || mime.startsWith("text/") || mime === "application/json") return "text";
  return null;
}

/** Null when the file may be uploaded, otherwise a short user-facing reason. */
export function validateFile(file: { name: string; size: number; type?: string }): string | null {
  const cls = classifyFile(file.name, file.type ?? "");
  if (!cls) return "unsupported type (use PDF, XLSX, CSV or a text file)";
  if (cls === "text" && file.size > MAX_TEXT_BYTES) return "too large (max 500 KB for text files)";
  if (cls !== "text" && file.size > MAX_BINARY_BYTES) return "too large (max 10 MB for PDF and XLSX)";
  if (file.size === 0) return "file is empty";
  return null;
}

/** Label for chips and badges: PDF / XLSX / CSV / MD / JSON / CODE / TXT. */
export function fileKindLabel(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "PDF";
  if (ext === "xlsx") return "XLSX";
  if (ext === "csv" || ext === "tsv") return "CSV";
  if (ext === "md" || ext === "markdown") return "MD";
  if (ext === "json") return "JSON";
  if (ext === "txt" || ext === "log" || ext === "") return "TXT";
  return TEXT_EXT.test(name) ? "CODE" : ext.slice(0, 4).toUpperCase();
}

/** Base64 without spreading a huge array into String.fromCharCode: encode in 30 KB slices. */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 30_000; // divisible by 3 so per-chunk base64 has no mid-string padding
  let out = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    let bin = "";
    const end = Math.min(i + CHUNK, bytes.length);
    for (let j = i; j < end; j++) bin += String.fromCharCode(bytes[j]!);
    out += btoa(bin);
  }
  return out;
}

/** Binary extracted text (page / sheet markers) is shown as plain text, never downloaded under the binary extension. */
export function isExtractedBinary(name: string): boolean {
  return BINARY_EXT.test(name);
}
