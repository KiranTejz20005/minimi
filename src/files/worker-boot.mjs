// Entry of the document-extraction worker (started by run-isolated.ts).
//
// Plain ESM on purpose. The worker is created with execArgv: [] so it inherits nothing from the parent: not
// tsx's --import/--require hooks (present under `tsx src/server.ts` and `node --import tsx src/server.ts`,
// absent under vitest), not --inspect, nothing. Node alone cannot load worker.ts (its type stripping does not
// map the "./x.js" specifiers used across src/ to .ts files), so tsx is registered here, inside this thread
// only, and the TypeScript worker is loaded after that. Same code path in every run mode.
import { workerData } from "node:worker_threads";
import { register } from "tsx/esm/api";

register();
// workerData.entry is a test-only override (run-isolated's `entry` option); production passes no workerData.
const entry = typeof workerData?.entry === "string" ? workerData.entry : new URL("./worker.ts", import.meta.url).href;
const mod = await import(entry);
mod.serve();
