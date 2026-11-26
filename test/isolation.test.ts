import type { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { FileRejected } from "../src/files/errors.js";
import { extractUpload } from "../src/files/extract.js";
import { __setIsolationLimitsForTest, isolationStats, runIsolated } from "../src/files/run-isolated.js";
import { readZipDirectory } from "../src/files/zip.js";
import { buildPdf, buildXlsx } from "./helpers/files.js";
import { benignXlsx, buildRawZip, EVIL_WORKER, hiddenBombXlsx, inflatedLength, zeroBomb, zipEntriesOf } from "./helpers/evil.js";

const MB = 1024 * 1024;
const op = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
const log = (...a: unknown[]) => console.log("[isolation]", ...a);
const ms = (t0: number) => Math.round(performance.now() - t0);

async function rejection(p: Promise<unknown>): Promise<FileRejected> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(FileRejected);
  return e as FileRejected;
}

/** Samples process RSS every 5 ms while `fn` runs; returns the peak growth over the starting RSS. */
async function peakRssGrowth<T>(fn: () => Promise<T>): Promise<{ value: T | FileRejected; growthMb: number }> {
  const rss0 = process.memoryUsage.rss();
  let peak = rss0;
  const iv = setInterval(() => (peak = Math.max(peak, process.memoryUsage.rss())), 5);
  try {
    const value = await fn().catch((e: unknown) => {
      if (e instanceof FileRejected) return e;
      throw e;
    });
    peak = Math.max(peak, process.memoryUsage.rss());
    return { value, growthMb: Math.round((peak - rss0) / MB) };
  } finally {
    clearInterval(iv);
  }
}

describe("extraction runs in a worker thread", () => {
  it("extracts a normal PDF and XLSX through the worker with the same output and meta as before", async () => {
    const before = isolationStats().spawned;
    let t0 = performance.now();
    const pdf = await extractUpload({ name: "a.pdf", mime: "application/pdf", bytes: buildPdf(["Isolated hello", "Page two revenue 42"]) });
    const pdfMs = ms(t0);
    t0 = performance.now();
    const xlsx = await extractUpload({ name: "b.xlsx", bytes: buildXlsx([{ name: "S", rows: [["k", "v"], ["x", 1]] }]) });
    const xlsxMs = ms(t0);
    expect(pdf.text).toBe("=== page 1 ===\n\nIsolated hello\n\n=== page 2 ===\n\nPage two revenue 42");
    expect(Object.keys(pdf.meta)).toEqual(["kind", "pages", "originalMime", "originalSize"]);
    expect(pdf.meta).toMatchObject({ kind: "pdf", pages: 2, originalMime: "application/pdf" });
    expect(xlsx.text).toBe("=== sheet: S ===\nk\tv\nx\t1");
    expect(xlsx.meta).toEqual({ kind: "xlsx", sheets: [{ name: "S", rows: 1, cols: 2, header: ["k", "v"] }], originalMime: null, originalSize: xlsx.meta.originalSize });
    expect(isolationStats().spawned - before).toBe(2);
    expect(isolationStats().active).toBe(0);
    log(`pdf via worker ${pdfMs} ms, xlsx via worker ${xlsxMs} ms`);
  }, 30_000);

  it("runs 3 concurrent extractions correctly (at most 2 worker threads at a time)", async () => {
    const t0 = performance.now();
    const [a, b, c] = await Promise.all([
      extractUpload({ name: "1.pdf", bytes: buildPdf(["first concurrent"]) }),
      extractUpload({ name: "2.xlsx", bytes: buildXlsx([{ name: "Two", rows: [["second"], ["concurrent"]] }]) }),
      extractUpload({ name: "3.pdf", bytes: buildPdf(["third concurrent"]) }),
    ]);
    expect(a.text).toContain("first concurrent");
    expect(b.text).toBe("=== sheet: Two ===\nsecond\nconcurrent");
    expect(c.text).toContain("third concurrent");
    expect(isolationStats().peakActive).toBeLessThanOrEqual(2);
    expect(isolationStats().active).toBe(0);
    log(`3 concurrent extractions ${ms(t0)} ms`);
  }, 30_000);

  it("gives the worker nothing but the job bytes and kind: no env secrets, no execArgv, no inherited data", async () => {
    process.env.MINIMI_ISOLATION_CANARY = "canary-6f1d-secret";
    try {
      const r = await runIsolated("pdf", op("probe"), { entry: EVIL_WORKER });
      const p = JSON.parse(r.text) as { env: Record<string, string>; execArgv: string[]; argv: string[]; workerData: unknown; messageKeys: string[]; bytesType: string };
      const allowed = ["TMPDIR", "TMP", "TEMP", "SystemRoot"];
      expect(Object.keys(p.env).filter((k) => !allowed.includes(k))).toEqual([]);
      expect(JSON.stringify(p.env)).not.toContain("canary");
      expect(p.execArgv).toEqual([]);
      expect(p.argv).toEqual([]);
      expect(p.messageKeys).toEqual(["bytes", "kind"]);
      expect(p.bytesType).toBe("[object Uint8Array]");
      expect(p.workerData).toEqual({ entry: EVIL_WORKER.href }); // test-only entry override; production passes none
    } finally {
      delete process.env.MINIMI_ISOLATION_CANARY;
    }
    // The production worker: exactly { kind, bytes } is posted, and the bytes travel as ONE transferred copy.
    const sent: unknown[][] = [];
    const src = buildPdf(["probe the real worker"]);
    const r = await runIsolated("pdf", src, {
      onSpawn: (w) => {
        const orig = w.postMessage.bind(w);
        w.postMessage = ((m: unknown, t?: readonly ArrayBuffer[]) => {
          sent.push([m, t]);
          return orig(m, t as never);
        }) as typeof w.postMessage;
      },
    });
    expect(r.text).toContain("probe the real worker");
    expect(sent).toHaveLength(1);
    const [msg, transfer] = sent[0] as [Record<string, unknown>, ArrayBuffer[]];
    expect(Object.keys(msg).sort()).toEqual(["bytes", "kind"]);
    expect(msg.kind).toBe("pdf");
    expect(transfer).toHaveLength(1);
    expect(transfer[0]).not.toBe(src.buffer); // a copy: the caller's (possibly pooled) buffer is never detached
    expect(src.length).toBeGreaterThan(0);
  }, 30_000);
});

describe("hard limits: the worker is killed, the server keeps serving", () => {
  it("terminates a worker stuck in a synchronous loop at the wall-clock limit, and the thread is gone", async () => {
    let w: Worker | undefined;
    const t0 = performance.now();
    const e = await rejection(runIsolated("pdf", op("spin"), { entry: EVIL_WORKER, timeoutMs: 1500, onSpawn: (x) => (w = x) }));
    const took = ms(t0);
    expect(e.code).toBe("timeout");
    expect(e.status).toBe(422);
    expect(e.message).toBe("Extracting the file took too long.");
    expect(took).toBeGreaterThanOrEqual(1400);
    expect(took).toBeLessThan(4000);
    expect(w!.threadId).toBe(-1); // -1 once the thread has stopped
    expect(isolationStats().active).toBe(0);
    log(`spinning worker killed after ${took} ms (limit 1500 ms)`);
  }, 15_000);

  it("applies the same wall clock to the real extraction worker through extractUpload, then recovers", async () => {
    const restore = __setIsolationLimitsForTest({ timeoutMs: 5 });
    try {
      const e = await rejection(extractUpload({ name: "slow.pdf", bytes: buildPdf(["never finishes in 5 ms"]) }));
      expect(e.code).toBe("timeout");
    } finally {
      restore();
    }
    expect(isolationStats().active).toBe(0);
    const ok = await extractUpload({ name: "ok.pdf", bytes: buildPdf(["back to normal"]) });
    expect(ok.text).toContain("back to normal");
  }, 30_000);

  it("maps a JS-heap OOM (ERR_WORKER_OUT_OF_MEMORY) to a clean rejection and keeps serving", async () => {
    let t0 = performance.now();
    const x = await rejection(runIsolated("xlsx", op("heap"), { entry: EVIL_WORKER, maxOldGenerationSizeMb: 48 }));
    const xMs = ms(t0);
    expect(x.code).toBe("zip_limits");
    expect(x.status).toBe(422);
    t0 = performance.now();
    const p = await rejection(runIsolated("pdf", op("heap"), { entry: EVIL_WORKER, maxOldGenerationSizeMb: 48 }));
    const pMs = ms(t0);
    expect(p.code).toBe("corrupt");
    expect(isolationStats().active).toBe(0);
    const ok = await extractUpload({ name: "after-oom.xlsx", bytes: buildXlsx([{ name: "S", rows: [["still"], ["serving"]] }]) });
    expect(ok.text).toBe("=== sheet: S ===\nstill\nserving");
    log(`heap OOM rejected in ${xMs} ms (xlsx) / ${pMs} ms (pdf), next extraction ok`);
  }, 30_000);

  it("caps ArrayBuffer/Buffer memory, which resourceLimits does not cover, with the external-memory watchdog", async () => {
    let w: Worker | undefined;
    const t0 = performance.now();
    const { value, growthMb } = await peakRssGrowth(() => runIsolated("pdf", op("external"), { entry: EVIL_WORKER, maxExternalMb: 64, onSpawn: (x) => (w = x) }));
    expect(value).toBeInstanceOf(FileRejected);
    expect((value as FileRejected).code).toBe("corrupt");
    expect(w!.threadId).toBe(-1);
    expect(growthMb).toBeLessThan(300);
    log(`external-memory hog killed after ${ms(t0)} ms, peak RSS growth ${growthMb} MB (cap 64 MB external)`);
  }, 15_000);

  it("refuses an oversized result message and maps crashes / early exits to corrupt", async () => {
    const flood = await rejection(runIsolated("pdf", op("flood"), { entry: EVIL_WORKER }));
    expect(flood.code).toBe("corrupt");
    const crash = await rejection(runIsolated("xlsx", op("crash"), { entry: EVIL_WORKER }));
    expect(crash.code).toBe("corrupt");
    expect(crash.message).toBe("This spreadsheet is corrupt or unreadable.");
    const exit = await rejection(runIsolated("pdf", op("exit"), { entry: EVIL_WORKER }));
    expect(exit.code).toBe("corrupt");
    expect(exit.message).toBe("This PDF is corrupt or unreadable.");
    expect(isolationStats().active).toBe(0);
  }, 30_000);
});

describe("ZIP: local headers must match the central directory", () => {
  it("fixture check: the bomb is real (300 MiB of zeros in < 1 MiB) and invisible to a central-directory-only check", async () => {
    const t0 = performance.now();
    const raw = zeroBomb(300);
    expect(raw.length).toBeLessThan(MB);
    const { value, growthMb } = await peakRssGrowth(() => inflatedLength(raw));
    expect(value).toBe(300 * MB);
    const evil = hiddenBombXlsx({ mb: 300, descriptor: true });
    expect(readZipDirectory(evil).map((e) => e.name)).not.toContain("xl/hidden.xml");
    log(`bomb: ${raw.length} bytes -> ${300 * MB} bytes (stream-counted in ${ms(t0)} ms, RSS growth ${growthMb} MB)`);
  }, 30_000);

  for (const variant of [
    { label: "local-only entry with a data descriptor", o: { mb: 300, descriptor: true } },
    { label: "local-only entry with honest local sizes", o: { mb: 300 } },
    { label: "entry between the central directory and the end record", o: { mb: 300, afterCd: true } },
  ]) {
    it(`rejects a 300 MiB deflate bomb hidden as a ${variant.label}, before any worker starts`, async () => {
      const evil = hiddenBombXlsx(variant.o);
      const spawned = isolationStats().spawned;
      const t0 = performance.now();
      const { value, growthMb } = await peakRssGrowth(() => extractUpload({ name: "evil.xlsx", bytes: evil }));
      const took = ms(t0);
      expect(value).toBeInstanceOf(FileRejected);
      expect((value as FileRejected).code).toBe("zip_limits");
      expect((value as FileRejected).status).toBe(422);
      expect(isolationStats().spawned).toBe(spawned); // the cheap main-thread check stopped it
      expect(growthMb).toBeLessThan(32);
      expect(took).toBeLessThan(1000);
      log(`hidden bomb (${variant.label}) rejected in ${took} ms, RSS growth ${growthMb} MB`);
    });
  }

  it("defence in depth: if the pre-check were bypassed, the watchdog still kills the real XLSX reader inflating the bomb", async () => {
    const evil = hiddenBombXlsx({ mb: 300, descriptor: true });
    let w: Worker | undefined;
    const t0 = performance.now();
    const { value, growthMb } = await peakRssGrowth(() => runIsolated("xlsx", evil, { maxExternalMb: 64, onSpawn: (x) => (w = x) }));
    expect(value).toBeInstanceOf(FileRejected);
    expect((value as FileRejected).code).toBe("zip_limits");
    expect(w!.threadId).toBe(-1);
    expect(growthMb).toBeLessThan(300);
    log(`unchecked bomb in the real worker killed after ${ms(t0)} ms, peak RSS growth ${growthMb} MB`);
  }, 15_000);

  it("rejects a declared-size lie consistently written in BOTH headers without materialising the output", async () => {
    const entries = [...zipEntriesOf(benignXlsx()), { name: "xl/liar.xml", comp: zeroBomb(300), method: 8, usize: 1000, crc: 0 }];
    const t0 = performance.now();
    const { value, growthMb } = await peakRssGrowth(() => extractUpload({ name: "liar.xlsx", bytes: buildRawZip(entries) }));
    expect((value as FileRejected).code).toBe("zip_limits");
    expect(growthMb).toBeLessThan(32);
    log(`consistent size lie rejected in ${ms(t0)} ms, RSS growth ${growthMb} MB`);
  });

  it("rejects local headers that disagree with the central directory", async () => {
    const base = zipEntriesOf(benignXlsx());
    const sheet = base.findIndex((e) => e.name === "xl/worksheets/sheet1.xml");
    const variants: [string, Partial<NonNullable<(typeof base)[number]["local"]>>][] = [
      ["bigger local size", { usize: base[sheet].usize * 50 }],
      ["different local name", { name: "xl/worksheets/sheetX.xml" }],
      ["different local method", { method: 0 }],
      ["different local compressed size", { csize: base[sheet].comp.length - 1 }],
    ];
    for (const [label, local] of variants) {
      const entries = base.map((e, i) => (i === sheet ? { ...e, local } : e));
      const e = await rejection(extractUpload({ name: "x.xlsx", bytes: buildRawZip(entries) }));
      expect(["zip_limits", "corrupt"], label).toContain(e.code);
      expect(e.status, label).toBe(422);
    }
  });

  it("rejects bytes the central directory does not account for", async () => {
    const e = await rejection(extractUpload({ name: "gap.xlsx", bytes: buildRawZip(zipEntriesOf(benignXlsx()), { junkBeforeCd: Buffer.alloc(64, 0x41) }) }));
    expect(e.code).toBe("zip_limits");
  });

  it("still accepts a valid workbook written with data descriptors (streaming ZIP writers)", async () => {
    const entries = zipEntriesOf(benignXlsx()).map((e) => ({ ...e, descriptor: true }));
    const r = await extractUpload({ name: "dd.xlsx", bytes: buildRawZip(entries) });
    expect(r.text).toBe("=== sheet: Data ===\nk\tv\nx\t1");
  }, 30_000);

  it("keeps the entry-count limit", async () => {
    const extra = Array.from({ length: 1001 }, (_, i) => ({ name: `xl/media/p${i}.bin`, data: "x" }));
    const e = await rejection(extractUpload({ name: "many.xlsx", bytes: buildXlsx([{ name: "S", rows: [["a"]] }], extra) }));
    expect(e.code).toBe("zip_limits");
  });
});
