import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import { FileRejected, type RejectCode } from "./errors.js";
import type { SheetMeta } from "./extract.js";

/**
 * Runs the binary document parsers (pdf.js via unpdf, read-excel-file) in a throw-away worker thread, so a hostile
 * document can at worst kill its own worker, never the server process (and every user's SSE stream with it).
 *
 *  - Wall clock: enforced with worker.terminate(), which also stops synchronous CPU work (Promise.race could not).
 *  - JS heap: V8 resourceLimits; reaching them ends only the worker (ERR_WORKER_OUT_OF_MEMORY).
 *  - ArrayBuffers / Buffers: NOT covered by resourceLimits (Node documents this), and that is exactly where
 *    inflated data lives. A watchdog polls the worker's external memory (worker.getHeapStatistics) plus the process
 *    RSS as a backstop, and terminates the worker past the budget.
 *  - Input: only { kind, bytes } (a transferred copy). No workerData, no execArgv, and an env that holds nothing
 *    but the temp-dir paths (tsx needs a temp dir for its cache). No secrets ever reach the worker.
 *  - Output: one message whose payload is a transferred byte array, size-checked BEFORE it is decoded, then
 *    shape-checked. A misbehaving worker yields a FileRejected, never an exception of another type.
 *  - At most MAX_CONCURRENT workers at a time (memory is bounded per worker, so this bounds the total).
 *
 * Start-up: the worker entry is worker-boot.mjs, plain ESM that registers tsx inside the worker and then loads
 * worker.ts. This works the same whether the server runs under `tsx`, `node --import tsx` or vitest, because the
 * worker inherits nothing from the parent's execArgv.
 */

export type IsolatedKind = "pdf" | "xlsx";
/** What the worker produces; extract.ts adds originalMime / originalSize. */
export type ParsedDoc = { kind: IsolatedKind; text: string; pages?: number; sheets?: SheetMeta[]; truncated?: boolean; truncatedReason?: string };
export type WorkerJob = { kind: IsolatedKind; bytes: Uint8Array };
export type WorkerReply = { ok: true; payload: Uint8Array } | { ok: false; code: RejectCode; message: string };

export type IsolationLimits = {
  /** hard wall clock for one extraction, enforced by terminating the worker */
  timeoutMs: number;
  maxOldGenerationSizeMb: number;
  maxYoungGenerationSizeMb: number;
  /** ArrayBuffer/Buffer memory of the worker (not covered by resourceLimits), enforced by the watchdog */
  maxExternalMb: number;
  /** size of the encoded result accepted from the worker */
  maxResultBytes: number;
  /** watchdog period */
  pollMs: number;
};

export const ISOLATION_LIMITS: Readonly<IsolationLimits> = Object.freeze({
  timeoutMs: 25_000,
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  maxExternalMb: 256,
  maxResultBytes: 8 * 1024 * 1024,
  pollMs: 25,
});

const MAX_CONCURRENT = 1; // one extraction at a time: bounds peak memory on small (512 MB) instances
const MAX_WAITING = 16;
const MB = 1024 * 1024;
const BOOT = new URL("./worker-boot.mjs", import.meta.url);

let limits: IsolationLimits = { ...ISOLATION_LIMITS };

/** Test hook: change the default limits (as used by extractUpload). Returns a function restoring the previous ones. */
export function __setIsolationLimitsForTest(p: Partial<IsolationLimits>): () => void {
  const prev = limits;
  limits = { ...limits, ...p };
  return () => {
    limits = prev;
  };
}

export type RunOptions = Partial<IsolationLimits> & {
  /** Test hook: another worker module exporting serve() (loaded through the same bootstrap and options). */
  entry?: URL;
  /** Test hook: observe the Worker right after it is created. */
  onSpawn?: (worker: Worker) => void;
};

const stats = { spawned: 0, active: 0, peakActive: 0 };
export const isolationStats = (): Readonly<typeof stats> => ({ ...stats });

// ── messages (same style as the rest of the upload pipeline) ────────────────────────────────────────────────
const unreadable = (kind: IsolatedKind) =>
  new FileRejected("corrupt", kind === "pdf" ? "This PDF is corrupt or unreadable." : "This spreadsheet is corrupt or unreadable.");
const tooMuchMemory = (kind: IsolatedKind) =>
  kind === "pdf"
    ? new FileRejected("corrupt", "This PDF needs too much memory to read (it may be corrupt or malicious).")
    : new FileRejected("zip_limits", "The spreadsheet needs too much memory to read (possible zip bomb).");
const tooSlow = () => new FileRejected("timeout", "Extracting the file took too long.");
const busy = () => new FileRejected("timeout", "The server is busy reading other files. Try again in a moment.");

/** Codes a parser may legitimately report; anything else from the worker is treated as "corrupt". */
const WORKER_CODES = new Set<RejectCode>(["corrupt", "encrypted", "no_text", "empty", "zip_limits", "timeout", "too_large", "unsupported_type", "signature_mismatch"]);

// ── concurrency gate ────────────────────────────────────────────────────────────────────────────────────────
let running = 0;
const waiting: (() => void)[] = [];

function acquire(waitMs: number): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++;
    return Promise.resolve();
  }
  if (waiting.length >= MAX_WAITING) return Promise.reject(busy());
  return new Promise((resolve, reject) => {
    const grant = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      const i = waiting.indexOf(grant);
      if (i >= 0) waiting.splice(i, 1);
      reject(busy());
    }, waitMs);
    waiting.push(grant);
  });
}

/** Called only once a worker thread has really exited: its slot passes to the next job in line. */
function release(): void {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

/** Only the temp-dir paths (tsx keeps its transpile cache there; without them Windows resolves "undefined\temp"). */
function workerEnv(): Record<string, string> {
  const t = tmpdir();
  const env: Record<string, string> = { TMPDIR: t, TMP: t, TEMP: t };
  if (process.platform === "win32" && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

// ── result validation ───────────────────────────────────────────────────────────────────────────────────────
const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

function toDoc(kind: IsolatedKind, v: unknown): ParsedDoc | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.kind !== kind || typeof o.text !== "string") return null;
  const doc: ParsedDoc = { kind, text: o.text };
  if (o.pages !== undefined) {
    if (!isCount(o.pages)) return null;
    doc.pages = o.pages;
  }
  if (o.sheets !== undefined) {
    if (!Array.isArray(o.sheets) || o.sheets.length > 1000) return null;
    const sheets: SheetMeta[] = [];
    for (const s of o.sheets as Record<string, unknown>[]) {
      if (!s || typeof s.name !== "string" || !isCount(s.rows) || !isCount(s.cols)) return null;
      const m: SheetMeta = { name: s.name, rows: s.rows, cols: s.cols };
      if (s.header !== undefined) {
        if (!Array.isArray(s.header) || !s.header.every((h) => typeof h === "string")) return null;
        m.header = s.header as string[];
      }
      sheets.push(m);
    }
    doc.sheets = sheets;
  }
  if (o.truncated === true) {
    doc.truncated = true;
    if (typeof o.truncatedReason === "string") doc.truncatedReason = o.truncatedReason;
  }
  return doc;
}

function fromReply(kind: IsolatedKind, m: unknown, maxResultBytes: number): ParsedDoc | FileRejected {
  if (!m || typeof m !== "object") return unreadable(kind);
  const r = m as Record<string, unknown>;
  if (r.ok === false) {
    const code = r.code as RejectCode;
    if (!WORKER_CODES.has(code) || typeof r.message !== "string" || !r.message || r.message.length > 500) return unreadable(kind);
    return new FileRejected(code, r.message);
  }
  if (r.ok !== true || !(r.payload instanceof Uint8Array)) return unreadable(kind);
  if (r.payload.byteLength > maxResultBytes) return unreadable(kind);
  try {
    return toDoc(kind, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(r.payload))) ?? unreadable(kind);
  } catch {
    return unreadable(kind);
  }
}

// ── the runner ──────────────────────────────────────────────────────────────────────────────────────────────
/** Parse one PDF/XLSX in a fresh worker. Resolves/rejects only after that worker thread has exited. */
export async function runIsolated(kind: IsolatedKind, bytes: Uint8Array, opts: RunOptions = {}): Promise<ParsedDoc> {
  const lim: IsolationLimits = { ...limits };
  for (const k of Object.keys(ISOLATION_LIMITS) as (keyof IsolationLimits)[]) if (opts[k] !== undefined) lim[k] = opts[k] as number;
  await acquire(lim.timeoutMs);

  // A private copy: the caller's bytes may be a slice of Node's shared Buffer pool, which must never be detached.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);

  let worker: Worker;
  try {
    worker = new Worker(BOOT, {
      execArgv: [],
      argv: [],
      env: workerEnv(),
      workerData: opts.entry ? { entry: opts.entry.href } : undefined,
      resourceLimits: { maxOldGenerationSizeMb: lim.maxOldGenerationSizeMb, maxYoungGenerationSizeMb: lim.maxYoungGenerationSizeMb },
      stdout: true,
      stderr: true,
    });
  } catch {
    release();
    throw unreadable(kind);
  }
  stats.spawned++;
  stats.active++;
  stats.peakActive = Math.max(stats.peakActive, stats.active);
  // Discard the worker's console output: a hostile document must not be able to flood the server log.
  worker.stdout.resume();
  worker.stderr.resume();

  return new Promise<ParsedDoc>((resolve, reject) => {
    let outcome: ParsedDoc | FileRejected | undefined;
    let settled = false;
    const rss0 = process.memoryUsage.rss();
    const rssBudget = (lim.maxOldGenerationSizeMb + lim.maxYoungGenerationSizeMb + lim.maxExternalMb + 128) * MB;
    // worker.getHeapStatistics exists from Node 22.16 / 24; without it only the RSS backstop applies.
    const canStat = typeof worker.getHeapStatistics === "function";
    let statsPending = false;
    let fallback: NodeJS.Timeout | undefined;

    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(fallback);
      const o = outcome ?? unreadable(kind);
      if (o instanceof FileRejected) reject(o);
      else resolve(o);
    };
    const decide = (o: ParsedDoc | FileRejected) => {
      if (outcome) return;
      outcome = o;
      clearTimeout(timer);
      clearInterval(watchdog);
      void worker.terminate().catch(() => {});
      // If the thread cannot be stopped (stuck in native code), answer anyway; its slot stays taken until it exits.
      fallback = setTimeout(settle, 5_000).unref();
    };

    const timer = setTimeout(() => decide(tooSlow()), lim.timeoutMs);
    const watchdog = setInterval(() => {
      if (process.memoryUsage.rss() - rss0 > rssBudget) return decide(tooMuchMemory(kind));
      if (statsPending || !canStat) return;
      statsPending = true;
      worker.getHeapStatistics().then(
        (s) => {
          statsPending = false;
          if (s.external_memory > lim.maxExternalMb * MB) decide(tooMuchMemory(kind));
        },
        () => {
          statsPending = false;
        },
      );
    }, lim.pollMs);

    worker.once("message", (m: unknown) => decide(fromReply(kind, m, lim.maxResultBytes)));
    worker.once("messageerror", () => decide(unreadable(kind)));
    worker.on("error", (err: Error & { code?: string }) => {
      if (err.code === "ERR_WORKER_OUT_OF_MEMORY") return decide(tooMuchMemory(kind));
      if (!outcome) console.warn(`[files] extraction worker failed: ${String(err.code ?? err.name).slice(0, 60)} ${String(err.message).slice(0, 200)}`);
      decide(unreadable(kind));
    });
    worker.once("exit", () => {
      stats.active--;
      release();
      clearTimeout(timer);
      clearInterval(watchdog);
      if (!outcome) outcome = unreadable(kind); // exited without answering
      settle();
    });

    opts.onSpawn?.(worker);
    const job: WorkerJob = { kind, bytes: copy };
    worker.postMessage(job, [copy.buffer]);
  });
}
