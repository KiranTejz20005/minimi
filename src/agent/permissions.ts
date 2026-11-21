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

/** Tools that reach the network; asked about before every use in "request" mode. */
const NETWORK_TOOLS = new Set<string>(["web_search", "fetch_url"]);

/**
 * The composer's approval mode.
 *  - request: ask once per turn before any network action (web_search / fetch_url)
 *  - auto:    ask only for potentially unsafe actions (sensitive tools, fetches of private-looking targets)
 *  - full:    never ask
 */
export type ApprovalMode = "request" | "auto" | "full";

/** Client input is untrusted: anything unrecognised falls back to the safe middle setting. */
export function parseApprovalMode(value: unknown): ApprovalMode {
  return value === "request" || value === "auto" || value === "full" ? value : "auto";
}

/** True for URLs that point at the user's own machine or network rather than the public web. */
export function looksPrivateUrl(raw: unknown): boolean {
  if (typeof raw !== "string" || !raw.trim()) return false;
  let host: string;
  try {
    host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return true; // unparseable targets are not something to run silently
  }
  host = host.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return true;
  if (host.includes(":")) return host === "::1" || host === "::" || /^f[cd]/.test(host) || host.startsWith("fe80");
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return !host.includes("."); // single-label hosts (intranet, router) are internal
}

function urlOf(input: unknown): unknown {
  return input && typeof input === "object" && "url" in input ? (input as { url: unknown }).url : undefined;
}

/**
 * Turn-scoped permission gate. One decision covers the whole turn.
 */
export class PermissionGate {
  private decision: boolean | null = null;

  constructor(_enabled = true, private readonly mode: ApprovalMode = "auto") {
    // `_enabled` kept for call-site compat.
  }

  private gated(name: string, input?: unknown): boolean {
    if (this.mode === "full") return false;
    if (SENSITIVE_TOOLS.has(name)) return true;
    if (this.mode === "request") return NETWORK_TOOLS.has(name);
    return name === "fetch_url" && looksPrivateUrl(urlOf(input));
  }

  get active(): boolean {
    return this.mode !== "full" && (SENSITIVE_TOOLS.size > 0 || this.mode === "request");
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
      if (!this.gated(c.name, c.input)) continue;
      out.push({ tool: c.name, label: labelFor(c.name, c.input) });
    }
    return out;
  }

  allows(name: string, input: unknown): boolean {
    if (!this.gated(name, input)) return true;
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
