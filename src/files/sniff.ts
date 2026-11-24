import { FileRejected } from "./errors.js";

export type FileKind = "pdf" | "xlsx" | "csv" | "text";

export const MAX_BINARY_BYTES = 10 * 1024 * 1024; // pdf / xlsx
export const MAX_TEXT_CHARS = 500_000; // csv / text (unchanged from the original text-only upload)

const ext = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((v, i) => b[i] === v);

/** PDF header may be preceded by a little junk (spec: first 1024 bytes). */
export function hasPdfSignature(b: Uint8Array): boolean {
  return Buffer.from(b.subarray(0, 1024)).toString("latin1").includes("%PDF-");
}
export const hasZipSignature = (b: Uint8Array) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]);

/** Known executable / container magics that must never be accepted as "text", whatever the name says. */
function foreignMagic(b: Uint8Array): string | null {
  if (startsWith(b, [0x4d, 0x5a])) return "a Windows executable";
  if (startsWith(b, [0x7f, 0x45, 0x4c, 0x46])) return "an ELF executable";
  if (startsWith(b, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(b, [0xca, 0xfe, 0xba, 0xbe])) return "a native executable";
  if (startsWith(b, [0xd0, 0xcf, 0x11, 0xe0])) return "a legacy Office file (.xls/.doc) - save it as .xlsx or .csv";
  if (startsWith(b, [0x1f, 0x8b])) return "a gzip archive";
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47]) || startsWith(b, [0xff, 0xd8, 0xff]) || startsWith(b, [0x47, 0x49, 0x46, 0x38])) return "an image";
  return null;
}

/** Strict UTF-8 decode + no NUL + not mostly control characters. Returns the text (BOM stripped). */
export function decodeTextStrict(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new FileRejected("not_text", "Only text, CSV, PDF and XLSX files are supported (binary data / NUL bytes found).");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new FileRejected("not_text", "The file is not valid UTF-8 text. Re-save it as UTF-8 (or upload a PDF/XLSX).");
  }
  const sample = text.slice(0, 8192);
  let ctl = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12) ctl++;
  }
  if (sample.length && ctl / sample.length > 0.05) throw new FileRejected("not_text", "The file does not look like text.");
  return text.replace(/^﻿/, "");
}

/**
 * Decide what a binary upload is from its NAME and its first bytes (never the MIME alone).
 * Throws FileRejected for any mismatch or unsupported type. The XLSX workbook.xml marker is checked in extract.ts.
 */
export function sniffBytes(name: string, bytes: Uint8Array): FileKind {
  const e = ext(name);
  if (e === "pdf") {
    if (!hasPdfSignature(bytes)) throw new FileRejected("signature_mismatch", "This file is named .pdf but is not a PDF (missing %PDF- header).");
    return "pdf";
  }
  if (e === "xlsx" || e === "xlsm") {
    if (!hasZipSignature(bytes)) throw new FileRejected("signature_mismatch", "This file is named .xlsx but is not a valid XLSX (not a ZIP container).");
    return "xlsx";
  }
  if (e === "xls" || e === "doc" || e === "ppt") throw new FileRejected("unsupported_type", "Legacy Office formats are not supported - save as .xlsx or .csv.");
  if (hasZipSignature(bytes)) throw new FileRejected("signature_mismatch", `This ${e || "file"} is a ZIP archive, which is not supported (only .xlsx workbooks).`);
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) throw new FileRejected("signature_mismatch", `This ${e || "file"} is a PDF but is not named .pdf.`);
  const foreign = foreignMagic(bytes);
  if (foreign) throw new FileRejected("signature_mismatch", `This file is ${foreign}, not a supported document.`);
  decodeTextStrict(bytes);
  return e === "csv" || e === "tsv" ? "csv" : "text";
}

/** Kind for the legacy JSON `content` (already a JS string) upload. */
export function sniffTextName(name: string): FileKind {
  const e = ext(name);
  if (e === "pdf" || e === "xlsx" || e === "xlsm") throw new FileRejected("signature_mismatch", `A .${e} file must be sent as contentBase64, not as text.`);
  return e === "csv" || e === "tsv" ? "csv" : "text";
}
