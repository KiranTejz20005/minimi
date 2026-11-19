/**
 * Measures real end-to-end latency: the production pipeline against the live LLM and live web search
 * (keys from .env). Uses a throwaway database so the search cache starts cold and your data is untouched.
 *
 *   npm run eval:latency            # 3 runs per query class
 *   npm run eval:latency -- 5       # N runs
 */
import "dotenv/config";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, "data"), { recursive: true });
const dbPath = join(root, "data", "latency.db");
const cleanup = () => {
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(f, { force: true });
};
cleanup();
process.env.DB_PATH = dbPath;

const { FixedClock } = await import("../src/clock.js");
const { getDb } = await import("../src/db.js");
const { runTurn } = await import("../src/agent/run-turn.js");
const { loadEvalFixtures } = await import("./eval-fixtures.js");

const RUNS = Number(process.argv[2]) || 3;
const CLASSES: { name: string; query: string }[] = [
  { name: "No search", query: "Explain in two sentences what a mutex is." },
  { name: "Recall only", query: "What did I ask you on Monday?" },
  { name: "One search round", query: "What is the latest LTS version of Node.js?" },
  {
    name: "Recall + verify 5 items",
    query:
      "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
  },
];

const p50 = (n: number[]) => [...n].sort((a, b) => a - b)[Math.floor(n.length / 2)]!;
const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

const db = getDb();
loadEvalFixtures(db);
// Frozen "now" (Tue 10 Nov 2026) so "Monday" resolves to the seeded history.
const clock = new FixedClock(new Date("2026-11-10T13:30:00.000Z"));

console.log("| Query class | Model calls | First token p50 | Total p50 | Searches |");
console.log("|---|---|---|---|---|");
for (const c of CLASSES) {
  const ttft: number[] = [];
  const total: number[] = [];
  let searches = 0;
  let steps = 0;
  for (let i = 0; i < RUNS; i++) {
    // Wall-clock timing: the frozen clock above only controls date resolution, not elapsed time.
    const t0 = performance.now();
    let first: number | null = null;
    const r = await runTurn(
      { message: c.query, tz: "Asia/Kolkata", db, clock },
      { onToken: () => (first ??= performance.now() - t0) },
    );
    if (first != null) ttft.push(first);
    total.push(performance.now() - t0);
    searches = Math.max(searches, r.searchCount);
    steps = Math.max(steps, r.steps);
  }
  console.log(
    `| ${c.name} | ${steps} | ${ttft.length ? sec(p50(ttft)) : "-"} | ${sec(p50(total))} | ${searches} |`,
  );
}
// The background digest may still be writing; exit explicitly instead of closing the DB under it.
process.exit(0); // latency.db is cleared at the start of the next run
