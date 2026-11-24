/** Side-effect module: pins the environment for integration tests. Must be the FIRST import of helpers/integration.ts. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ANTHROPIC_API_KEY = "";
process.env.NVIDIA_API_KEY = "";
process.env.TAVILY_API_KEY = "";
process.env.FORCE_SEARCH = "1";
process.env.MAX_STEPS = "6";
process.env.MAX_TOOL_CALLS_PER_TURN = "24";
process.env.MAX_PARALLEL_TOOLS = "6";
process.env.MAX_SEARCHES_PER_STEP = "12";
process.env.MAX_SEARCHES_PER_TURN = "16";
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "minimi-it-")), "agent.db");

export {};
