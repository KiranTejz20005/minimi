import { constants, createInflateRaw, deflateRawSync } from "node:zlib";
import { parentPort, workerData } from "node:worker_threads";
import { buildXlsx } from "./files.js";

/**
 * Hostile fixtures for test/isolation.test.ts. Nothing here allocates the expanded data in the test process:
 * the bombs are built from ONE compressed MiB repeated, and their size is verified by a streaming count.
 */

const MB = 1024 * 1024;

/**
 * Raw-deflate stream that inflates to `mb` MiB of zeros. Each 1 MiB segment ends with Z_FULL_FLUSH (byte aligned,
 * history reset), so the same compressed segment can be repeated; 03 00 is an empty final block. ~1 KiB per MiB.
 */
export function zeroBomb(mb: number): Buffer {
  const seg = deflateRawSync(Buffer.alloc(MB), { level: 9, finishFlush: constants.Z_FULL_FLUSH });
  return Buffer.concat([...Array.from({ length: mb }, () => seg), Buffer.from([0x03, 0x00])]);
}

/** Inflated size of a raw-deflate stream, counted chunk by chunk (never holds the output). */
export function inflatedLength(raw: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    let n = 0;
    const z = createInflateRaw({ chunkSize: MB });
    z.on("data", (c: Buffer) => (n += c.length));
    z.on("error", reject);
    z.on("end", () => resolve(n));
    z.end(raw);
  });
}

export type RawEntry = {
  name: string;
  /** compressed bytes as stored */
  comp: Buffer;
  method: number;
  usize: number;
  crc: number;
  /** general-purpose flag bit 3: sizes/crc zero in the local header, a signed data descriptor follows the data */
  descriptor?: boolean;
  /** in the local headers only: the central directory does not list it */
  hidden?: boolean;
  /** placed between the central directory and the end record */
  afterCd?: boolean;
  /** lie in the local header only */
  local?: { name?: string; usize?: number; csize?: number; method?: number };
};

/** Entries of a ZIP written by helpers/files.ts buildZip (central directory order == physical order). */
export function zipEntriesOf(zip: Buffer): RawEntry[] {
  const eocd = zip.length - 22;
  const total = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const out: RawEntry[] = [];
  for (let i = 0; i < total; i++) {
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const csize = zip.readUInt32LE(p + 20);
    const usize = zip.readUInt32LE(p + 24);
    const nlen = zip.readUInt16LE(p + 28);
    const off = zip.readUInt32LE(p + 42);
    const name = zip.toString("utf8", p + 46, p + 46 + nlen);
    const start = off + 30 + zip.readUInt16LE(off + 26) + zip.readUInt16LE(off + 28);
    out.push({ name, comp: Buffer.from(zip.subarray(start, start + csize)), method, usize, crc });
    p += 46 + nlen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  return out;
}

/** ZIP writer that can lie: hidden local-only entries, entries after the directory, data descriptors, local/central mismatches. */
export function buildRawZip(entries: RawEntry[], opts: { junkBeforeCd?: Buffer } = {}): Buffer {
  const local = (e: RawEntry): Buffer => {
    const name = Buffer.from(e.local?.name ?? e.name, "utf8");
    const dd = !!e.descriptor;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(dd ? 0x08 : 0, 6);
    h.writeUInt16LE(e.local?.method ?? e.method, 8);
    h.writeUInt32LE(dd ? 0 : e.crc, 14);
    h.writeUInt32LE(dd ? 0 : (e.local?.csize ?? e.comp.length), 18);
    h.writeUInt32LE(dd ? 0 : (e.local?.usize ?? e.usize), 22);
    h.writeUInt16LE(name.length, 26);
    const parts = [h, name, e.comp];
    if (dd) {
      const d = Buffer.alloc(16);
      d.writeUInt32LE(0x08074b50, 0);
      d.writeUInt32LE(e.crc, 4);
      d.writeUInt32LE(e.local?.csize ?? e.comp.length, 8);
      d.writeUInt32LE(e.local?.usize ?? e.usize, 12);
      parts.push(d);
    }
    return Buffer.concat(parts);
  };
  const central = (e: RawEntry, offset: number): Buffer => {
    const name = Buffer.from(e.name, "utf8");
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(20, 6);
    h.writeUInt16LE(e.descriptor ? 0x08 : 0, 8);
    h.writeUInt16LE(e.method, 10);
    h.writeUInt32LE(e.crc, 16);
    h.writeUInt32LE(e.comp.length, 20);
    h.writeUInt32LE(e.usize, 24);
    h.writeUInt16LE(name.length, 28);
    h.writeUInt32LE(offset, 42);
    return Buffer.concat([h, name]);
  };
  const body: Buffer[] = [];
  const cd: Buffer[] = [];
  let offset = 0;
  let listed = 0;
  for (const e of entries.filter((x) => !x.afterCd)) {
    const rec = local(e);
    if (!e.hidden) {
      cd.push(central(e, offset));
      listed++;
    }
    body.push(rec);
    offset += rec.length;
  }
  if (opts.junkBeforeCd) {
    body.push(opts.junkBeforeCd);
    offset += opts.junkBeforeCd.length;
  }
  const cdBuf = Buffer.concat(cd);
  const after = Buffer.concat(entries.filter((x) => x.afterCd).map(local));
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(listed, 8);
  eocd.writeUInt16LE(listed, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...body, cdBuf, after, eocd]);
}

export const benignXlsx = () => buildXlsx([{ name: "Data", rows: [["k", "v"], ["x", 1]] }]);

/** A benign, fully valid workbook in the central directory, plus one deflate bomb the directory does not mention. */
export function hiddenBombXlsx(o: { mb: number; descriptor?: boolean; afterCd?: boolean }): Buffer {
  const bomb: RawEntry = {
    name: "xl/hidden.xml",
    comp: zeroBomb(o.mb),
    method: 8,
    usize: o.mb * MB,
    crc: 0,
    descriptor: o.descriptor,
    hidden: !o.afterCd,
    afterCd: o.afterCd,
  };
  return buildRawZip([...zipEntriesOf(benignXlsx()), bomb]);
}

// ── evil worker entry (loaded by src/files/worker-boot.mjs when a test passes `entry`) ─────────────────────
export const EVIL_WORKER = new URL("./evil.ts", import.meta.url);

/** Same contract as src/files/worker.ts serve(): one job in, one reply out. The op is the job's bytes as text. */
export function serve(): void {
  const port = parentPort;
  if (!port) throw new Error("serve() must run in a worker thread");
  port.once("message", (msg: { kind: string; bytes: Uint8Array }) => {
    const op = Buffer.from(msg.bytes).toString("utf8");
    const reply = (doc: unknown) => {
      const payload = new TextEncoder().encode(JSON.stringify(doc));
      port.postMessage({ ok: true, payload }, [payload.buffer as ArrayBuffer]);
    };
    if (op === "spin") {
      for (;;) {
        /* a synchronous loop no Promise.race can interrupt */
      }
    }
    if (op === "heap") {
      const keep: unknown[] = [];
      for (;;) keep.push({ a: Math.random(), s: `x${Math.random()}`.repeat(8) });
    }
    if (op === "external") {
      const keep: Uint8Array[] = [];
      for (;;) keep.push(new Uint8Array(8 * MB).fill(1));
    }
    if (op === "flood") {
      const payload = new Uint8Array(64 * MB);
      port.postMessage({ ok: true, payload }, [payload.buffer]);
      return;
    }
    if (op === "crash") {
      setTimeout(() => {
        throw new Error("boom");
      });
      return;
    }
    if (op === "exit") process.exit(3);
    if (op === "probe") {
      reply({
        kind: msg.kind,
        pages: 1,
        text: JSON.stringify({
          env: { ...process.env },
          execArgv: process.execArgv,
          argv: process.argv.slice(2),
          workerData,
          messageKeys: Object.keys(msg).sort(),
          bytesType: Object.prototype.toString.call(msg.bytes),
        }),
      });
      return;
    }
    reply({ kind: msg.kind, text: `unknown op ${op}`, pages: 1 });
  });
}
