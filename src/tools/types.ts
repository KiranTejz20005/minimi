import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryStore } from "../memory/store.js";
import type { SearchProvider } from "../search/types.js";
import type { TurnCitationRegistry } from "../search/tool.js";

/**
 * The tool contract. A tool is ONE ToolDefinition registered in src/tools/registry.ts;
 * the loop, the permission gate and the dispatcher read everything they need from it.
 * Adding a tool = write a definition + add it to BUILTIN_TOOLS. No other file changes.
 */

/** Per-call context. `counts` is the per-turn use counter, keyed by tool name (the dispatcher maintains it). */
export type ToolContext = {
  db: DatabaseSync;
  store?: MemoryStore;
  searchProvider?: SearchProvider;
  registry: TurnCitationRegistry;
  /** Turn-level cancellation. The dispatcher layers the tool's own timeout on top of this. */
  signal?: AbortSignal;
  /** Set once the turn row exists; tools that write (save_memory) attribute changes to it. */
  turnId?: string;
  conversationId?: string;
  counts: Record<string, number>;
  /** Duplicate-call memo for this turn (dispatcher-owned): dedupe key -> first result. */
  seen?: Map<string, ToolExecResult>;
};

export type ToolSearchMeta = {
  query: string;
  count: number;
  cached: boolean;
  results?: { title: string; url: string }[];
  error?: string;
};

/** What a tool's run() returns. The dispatcher turns it into a ToolExecResult. */
export type ToolResult = {
  /** Text handed back to the model as the tool_result (XML-ish; untrusted data is escaped and labelled). */
  content: string;
  /** Short human label for the UI / approval prompt (defaults to the definition's label()). */
  label?: string;
  /** Set when the call failed in a way the model should know about. */
  error?: string;
  /** Optional hook payload: the web_search card in the UI reads this. */
  search?: ToolSearchMeta;
};

/** Thrown by validate(); the dispatcher turns it into a tool error the model can read and fix. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

/** Only tools with effect "read" are ever retried automatically. */
export type RetryPolicy = { retries: number; backoffMs: number };

export type ToolDefinition<Input = any> = {
  /** Must equal schema.name. */
  name: string;
  /** What the model sees. */
  schema: Tool;
  /** Parse + validate the model's raw arguments. Throw ToolInputError (or a ZodError) when invalid. */
  validate: (raw: unknown) => Input;
  run: (input: Input, ctx: ToolContext) => Promise<ToolResult>;

  /** UI label for a call, computed from raw (possibly invalid) input. */
  label?: (raw: unknown) => string;
  /** Exact, human-readable description of THIS call for the approval prompt (may read the DB). Falls back to label(). */
  describe?: (input: Input, ctx: ToolContext) => string;
  /** Verb phrase for the approval prompt, e.g. "Fetch page". */
  actionLabel?: string;

  /** Search-style tool: the loop emits search_start/search_done SSE events and the search trace batch for it. */
  isSearch?: boolean;
  /** "read" (default) tools may be retried and deduplicated freely; "write" tools never are. */
  effect?: "read" | "write";
  /**
   * Approval class used by PermissionGate:
   *  - "network":   asked about in "request" mode (reaches the internet)
   *  - "sensitive": always asked unless mode is "full" (changes persistent user data)
   */
  approval?: "network" | "sensitive";
  /** Extra check for "auto" mode: true when this specific call is unusual enough to confirm (e.g. a private-looking URL). */
  needsApproval?: (input: Input, ctx: ToolContext) => boolean;

  /** Resources the tool needs; the dispatcher returns an explicit error instead of crashing when missing. */
  needs?: ("db" | "store")[];
  /** Max calls per turn (successful or not). A function so it can read live config. */
  maxPerTurn?: number | (() => number);
  /** Hard wall-clock limit for one call (ms). Composed with ctx.signal via AbortSignal.any. */
  timeoutMs?: number;
  retry?: RetryPolicy;
  /** Normalised key for duplicate-call prevention. Default: tool name + stable JSON of the validated input. */
  dedupeKey?: (input: Input) => string;

  /** Text for a declined call. */
  declined?: (label: string) => string;
  /** Text for a failed call (validation, limit, timeout, crash). */
  errorContent?: (label: string, error: string) => string;
};

export type ToolExecResult = {
  id: string;
  name: string;
  label: string;
  content: string;
  ms: number;
  search?: ToolSearchMeta;
  error?: string;
  declined?: boolean;
  /** True when this call was answered from an earlier identical call in the same turn. */
  duplicate?: boolean;
};
