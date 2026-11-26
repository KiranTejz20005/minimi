import { createInflateRaw } from "node:zlib";
import { FileRejected } from "./errors.js";

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

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_DESCRIPTOR = Buffer.from([0x50, 0x4b, 0x07, 0x08]);
const FLAG_ENCRYPTED = 0x01;
const FLAG_DESCRIPTOR = 0x08;

const LIMIT = (m: string) => new FileRejected("zip_limits", m);
const bad = (what = "invalid ZIP structure") => new FileRejected("corrupt", `The spreadsheet is corrupt (${what}).`);
const hidden = () => LIMIT("The spreadsheet archive contains data its directory does not list (possible zip bomb).");
const mismatch = () => LIMIT("The spreadsheet archive's entries do not match its directory (possible zip bomb).");
const zip64 = () => LIMIT("ZIP64 spreadsheets are not supported.");

type Directory = { eocd: number; total: number; cdOff: number; cdSize: number };
type CentralEntry = ZipEntryInfo & { nameBytes: Buffer };

function locateDirectory(buf: Buffer, limits: ZipLimits): Directory {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === SIG_END) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad();
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOff === 0xffffffff) throw zip64();
  if (total > limits.maxEntries) throw LIMIT(`The spreadsheet archive has too many parts (max ${limits.maxEntries}).`);
  if (cdOff + cdSize > buf.length) throw bad();
  return { eocd, total, cdOff, cdSize };
}

/** Walk the central directory. `end` is where the last record stops. */
function walkCentral(buf: Buffer, dir: Directory): { entries: CentralEntry[]; end: number } {
  const entries: CentralEntry[] = [];
  let p = dir.cdOff;
  for (let i = 0; i < dir.total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) throw bad();
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    if (p + 46 + nlen > buf.length) throw bad();
    if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) throw zip64();
    if (flags & FLAG_ENCRYPTED) throw new FileRejected("encrypted", "Password-protected spreadsheets are not supported.");
    const nameBytes = buf.subarray(p + 46, p + 46 + nlen);
    entries.push({ name: nameBytes.toString("utf8"), method, csize, usize, offset, flags, nameBytes });
    p += 46 + nlen + elen + clen;
  }
  return { entries, end: p };
}

/** Parse the ZIP central directory (never trusts anything beyond bounds). Throws FileRejected. */
export function readZipDirectory(buf: Buffer, limits = XLSX_ZIP_LIMITS): ZipEntryInfo[] {
  return walkCentral(buf, locateDirectory(buf, limits)).entries.map(({ nameBytes: _, ...e }) => e);
}

type DataRange = { entry: CentralEntry; start: number; end: number };

/**
 * The XLSX reader (read-excel-file -> unzipper Parse) does NOT read the central directory: it streams the LOCAL
 * headers from byte 0, and after the directory it would still read any local header it meets. So the archive
 * is accepted only when both views are the same file list: every byte from 0 to the directory belongs to a
 * listed entry whose local header matches its directory record, the directory is contiguous and ends exactly
 * at the end record. Entry data extents are computed exactly as that reader computes them, and returned so
 * the inflate budget below checks the very bytes the reader will inflate.
 */
function verifyLayout(buf: Buffer, limits: ZipLimits): DataRange[] {
  const dir = locateDirectory(buf, limits);
  const { entries, end } = walkCentral(buf, dir);
  // Anything between the last directory record and the end record would be parsed by the streaming reader.
  if (end !== dir.cdOff + dir.cdSize || end !== dir.eocd) throw hidden();

  const seen = new Set<string>();
  for (const e of entries) {
    // eslint-disable-next-line no-control-regex
    if (!e.nameBytes.length || e.nameBytes.length > 1024 || /[\u0000-\u001f\u007f]/.test(e.name)) throw bad("invalid part name");
    if (seen.has(e.name)) throw bad("duplicate part name");
    seen.add(e.name);
  }

  const ranges: DataRange[] = [];
  let q = 0;
  for (const c of [...entries].sort((a, b) => a.offset - b.offset)) {
    if (c.offset !== q) throw hidden();
    if (q + 30 > dir.cdOff || buf.readUInt32LE(q) !== SIG_LOCAL) throw hidden();
    const flags = buf.readUInt16LE(q + 6);
    const method = buf.readUInt16LE(q + 8);
    const csize = buf.readUInt32LE(q + 18);
    const usize = buf.readUInt32LE(q + 22);
    const nameEnd = q + 30 + buf.readUInt16LE(q + 26);
    const start = nameEnd + buf.readUInt16LE(q + 28);
    if (start > dir.cdOff) throw bad("truncated entry");
    if (!buf.subarray(q + 30, nameEnd).equals(c.nameBytes)) throw mismatch();
    if (flags & FLAG_ENCRYPTED) throw new FileRejected("encrypted", "Password-protected spreadsheets are not supported.");
    if (method !== c.method) throw mismatch();
    if (csize === 0xffffffff || usize === 0xffffffff) throw zip64();
    let dataEnd: number;
    let next: number;
    if (!(flags & FLAG_DESCRIPTOR) || csize > 0) {
      // The reader trusts the LOCAL sizes here (and allocates usize up front).
      if (csize !== c.csize || usize !== c.usize) throw mismatch();
      dataEnd = start + csize;
      next = dataEnd;
    } else {
      // Sizes unknown locally: the reader streams up to the first descriptor signature, then reads 16 bytes.
      const at = buf.subarray(start, Math.min(dir.cdOff, start + c.csize + SIG_DESCRIPTOR.length)).indexOf(SIG_DESCRIPTOR);
      if (at !== c.csize) throw mismatch();
      dataEnd = start + at;
      next = dataEnd + 16;
      if (next > dir.cdOff) throw bad("truncated entry");
      if (buf.readUInt32LE(dataEnd + 8) !== c.csize || buf.readUInt32LE(dataEnd + 12) !== c.usize) throw mismatch();
    }
    if (next > dir.cdOff) throw bad("truncated entry");
    ranges.push({ entry: c, start, end: dataEnd });
    q = next;
  }
  if (q !== dir.cdOff) throw hidden();
  return ranges;
}

/**
 * Inflated size of one raw-deflate entry, counted chunk by chunk and abandoned as soon as it passes `cap`:
 * the output is never held, so a bomb costs at most cap bytes of CPU work and one chunk of memory. zlib runs on
 * the libuv pool, so the main event loop is not blocked meanwhile.
 */
function inflatedSize(comp: Buffer, cap: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const z = createInflateRaw({ chunkSize: 64 * 1024 });
    let n = 0;
    let done = false;
    const settle = (f: () => void) => {
      if (!done) {
        done = true;
        f();
      }
    };
    z.on("data", (chunk: Buffer) => {
      n += chunk.length;
      if (n > cap) {
        settle(() => resolve(n));
        z.destroy();
      }
    });
    z.on("error", (err) => settle(() => reject(err)));
    z.on("end", () => settle(() => resolve(n)));
    z.on("close", () => settle(() => resolve(n)));
    z.end(comp);
  });
}

/**
 * Zip-bomb defence, run in the main thread BEFORE the archive reaches the worker: check declared sizes and
 * ratios, check that the local headers (what the reader uses) are exactly the central directory (what we
 * checked), then really inflate every entry with a streaming byte budget (declared sizes can lie), within an
 * overall deadline. Throws FileRejected.
 */
export async function verifyZipSafe(buf: Buffer, entries: ZipEntryInfo[], limits = XLSX_ZIP_LIMITS): Promise<void> {
  const started = Date.now();
  let declared = 0;
  for (const e of entries) {
    declared += e.usize;
    if (e.usize > limits.maxEntryBytes || declared > limits.maxTotalBytes) throw LIMIT("The spreadsheet expands to too much data (possible zip bomb).");
    if (e.usize > limits.ratioFloorBytes && e.csize > 0 && e.usize / e.csize > limits.maxRatio) throw LIMIT("The spreadsheet has a suspicious compression ratio (possible zip bomb).");
  }
  const ranges = verifyLayout(buf, limits);
  if (ranges.length !== entries.length) throw mismatch();

  let actual = 0;
  for (const { entry: e, start, end } of ranges) {
    if (Date.now() - started > limits.deadlineMs) throw new FileRejected("timeout", "Reading the spreadsheet took too long.");
    const comp = buf.subarray(start, end);
    let size: number;
    if (e.method === 0) size = comp.length;
    else if (e.method === 8) {
      if (!comp.length) size = 0;
      else {
        try {
          size = await inflatedSize(comp, e.usize);
        } catch {
          throw new FileRejected("corrupt", "The spreadsheet is corrupt (bad compressed data).");
        }
      }
    } else throw new FileRejected("unsupported_type", "Unsupported compression in spreadsheet.");
    if (size > e.usize) throw LIMIT("The spreadsheet expands beyond its declared size (possible zip bomb).");
    actual += size;
    if (actual > limits.maxTotalBytes) throw LIMIT("The spreadsheet expands to too much data (possible zip bomb).");
  }
}
