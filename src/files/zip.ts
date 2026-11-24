import { inflateRaw } from "node:zlib";
import { promisify } from "node:util";
import { FileRejected } from "./errors.js";

const inflate = promisify(inflateRaw);

export type ZipLimits = {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  /** Reject entries above this size whose expansion ratio exceeds maxRatio. */
  ratioFloorBytes: number;
  maxRatio: number;
  deadlineMs: number;
};

export const XLSX_ZIP_LIMITS: ZipLimits = {
  maxEntries: 1000,
  maxEntryBytes: 25 * 1024 * 1024,
  maxTotalBytes: 60 * 1024 * 1024,
  ratioFloorBytes: 1024 * 1024,
  maxRatio: 200,
  deadlineMs: 10_000,
};

export type ZipEntryInfo = { name: string; method: number; csize: number; usize: number; offset: number; flags: number };

const LIMIT = (m: string) => new FileRejected("zip_limits", m);

/** Parse the ZIP central directory (never trusts anything beyond bounds). Throws FileRejected. */
export function readZipDirectory(buf: Buffer, limits = XLSX_ZIP_LIMITS): ZipEntryInfo[] {
  const bad = () => new FileRejected("corrupt", "The spreadsheet is corrupt (invalid ZIP structure).");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad();
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOff === 0xffffffff) throw LIMIT("ZIP64 spreadsheets are not supported.");
  if (total > limits.maxEntries) throw LIMIT(`The spreadsheet archive has too many parts (max ${limits.maxEntries}).`);
  if (cdOff + cdSize > buf.length) throw bad();
  const out: ZipEntryInfo[] = [];
  let p = cdOff;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad();
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    if (p + 46 + nlen > buf.length) throw bad();
    if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) throw LIMIT("ZIP64 spreadsheets are not supported.");
    if (flags & 1) throw new FileRejected("encrypted", "Password-protected spreadsheets are not supported.");
    out.push({ name: buf.toString("utf8", p + 46, p + 46 + nlen), method, csize, usize, offset, flags });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

/**
 * Zip-bomb defence: check declared sizes and ratios, then really inflate every entry with a hard output ceiling
 * (declared sizes can lie), within an overall deadline. Throws FileRejected.
 */
export async function verifyZipSafe(buf: Buffer, entries: ZipEntryInfo[], limits = XLSX_ZIP_LIMITS): Promise<void> {
  const started = Date.now();
  let declared = 0;
  for (const e of entries) {
    declared += e.usize;
    if (e.usize > limits.maxEntryBytes || declared > limits.maxTotalBytes) throw LIMIT("The spreadsheet expands to too much data (possible zip bomb).");
    if (e.usize > limits.ratioFloorBytes && e.csize > 0 && e.usize / e.csize > limits.maxRatio) throw LIMIT("The spreadsheet has a suspicious compression ratio (possible zip bomb).");
  }
  let actual = 0;
  for (const e of entries) {
    if (Date.now() - started > limits.deadlineMs) throw new FileRejected("timeout", "Reading the spreadsheet took too long.");
    if (e.name.endsWith("/") || e.usize === 0) continue;
    const o = e.offset;
    if (o + 30 > buf.length || buf.readUInt32LE(o) !== 0x04034b50) throw new FileRejected("corrupt", "The spreadsheet is corrupt (bad entry header).");
    const start = o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
    const end = start + e.csize;
    if (end > buf.length) throw new FileRejected("corrupt", "The spreadsheet is corrupt (truncated entry).");
    const comp = buf.subarray(start, end);
    let size: number;
    if (e.method === 0) size = comp.length;
    else if (e.method === 8) {
      try {
        size = (await inflate(comp, { maxOutputLength: e.usize + 1 })).length;
      } catch (err) {
        if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError) throw LIMIT("The spreadsheet expands beyond its declared size (possible zip bomb).");
        throw new FileRejected("corrupt", "The spreadsheet is corrupt (bad compressed data).");
      }
    } else throw new FileRejected("unsupported_type", "Unsupported compression in spreadsheet.");
    if (size > e.usize) throw LIMIT("The spreadsheet expands beyond its declared size (possible zip bomb).");
    actual += size;
    if (actual > limits.maxTotalBytes) throw LIMIT("The spreadsheet expands to too much data (possible zip bomb).");
  }
}
