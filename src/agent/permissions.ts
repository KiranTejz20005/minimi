import { parseSearchInput } from "../search/tool.js";

/** One action the user may need to confirm (high-impact only). */
export type ApprovalAction = {
  tool: string;
  label: string;
};

/**
 * Tools that change user data or leave the machine in a lasting way.
 * Read-only tools (web_search, fetch_url, memory_search, lookup_claims) are never listed here.
 * User: only ask permission for really important things, not trivial matters.
 */
const SENSITIVE_TOOLS = new Set<string>([
  // e.g. "save_user_note", "delete_memory" — add when those tools exist
]);

/**
 * Turn-scoped permission gate for high-impact tools only.
 * Always active for SENSITIVE_TOOLS (no composer toggle). Read-only work auto-runs.
 */
export class PermissionGate {
  private decision: boolean | null = null;

  constructor(_enabled = true) {
    // `_enabled` kept for call-site compat; sensitive tools always gate.
  }

  get active(): boolean {
    return SENSITIVE_TOOLS.size > 0;
  }

  get decided(): boolean {
    return this.decision !== null;
  }

  record(approved: boolean): void {
    this.decision = approved;
  }

  /** Sensitive actions that still need a prompt this step (empty → auto-allow). */
  actionsNeedingPrompt(calls: { name: string; input: unknown }[]): ApprovalAction[] {
    if (this.decision !== null) return [];
    const out: ApprovalAction[] = [];
    for (const c of calls) {
      if (!SENSITIVE_TOOLS.has(c.name)) continue;
      out.push({ tool: c.name, label: labelFor(c.name, c.input) });
    }
    return out;
  }

  allows(name: string, _input: unknown): boolean {
    if (!SENSITIVE_TOOLS.has(name)) return true;
    if (this.decision === false) return false;
    return true;
  }
}

function labelFor(name: string, input: unknown): string {
  if (name === "web_search") {
    const parsed = parseSearchInput(input);
    return parsed?.query || queryField(input) || "web search";
  }
  if (name === "fetch_url") {
    const url =
      input && typeof input === "object" && "url" in input
        ? String((input as { url: unknown }).url)
        : "";
    return url || "fetch page";
  }
  if (input && typeof input === "object" && "query" in input) {
    return String((input as { query: unknown }).query) || name;
  }
  return name;
}

function queryField(input: unknown): string {
  if (input && typeof input === "object" && "query" in input) {
    return String((input as { query: unknown }).query);
  }
  return "";
}
