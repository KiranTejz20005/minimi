import { getTool, labelForCall, listTools, stableStringify } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";

/**
 * One action the user is asked to confirm. This exact shape is sent to the UI (SSE `approval_request.actions`):
 * `verb` is the tool's actionLabel ("Fetch page", "Save to memory"), `label` the specific target (URL, text...).
 */
export type ApprovalAction = {
  tool: string;
  label: string;
  verb: string;
};

/** A call as the loop sees it. `id` is the model's tool_use id; without one the decision key is name + input. */
export type GateCall = { id?: string; name: string; input: unknown };

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

/**
 * What kind of decision a call needs:
 *  - "network": a plain network tool in "request" mode. ONE answer covers the rest of the turn (documented
 *    trade-off: re-asking before every search would make research turns unusable; the user opted in to
 *    "ask before the web" and approving the first batch approves the web for this turn).
 *  - "call":    sensitive tools and calls the tool itself flags via needsApproval(input). Decided PER CALL:
 *    approving one never approves another call, even the same tool with the same input in a later step.
 */
type GateClass = "network" | "call";

/**
 * Turn-scoped, registry-driven permission gate. Policy comes from each tool's definition
 * (`approval`, `needsApproval`, `actionLabel`), not from name lists here.
 *
 * UX: the loop batches every call needing a decision in a step into ONE request (`actionsNeedingPrompt` ->
 * `requestApproval` -> `record(ok, calls)`). The UI answer is all-or-nothing for that batch, but the decision
 * is stored per call key, so a later step's new gated call prompts again.
 */
export class PermissionGate {
  private networkDecision: boolean | null = null;
  private readonly decisions = new Map<string, boolean>();

  constructor(
    _enabled = true,
    private readonly mode: ApprovalMode = "auto",
    private readonly ctx: ToolContext = {} as ToolContext,
  ) {
    // `_enabled` kept for call-site compat.
  }

  private keyOf(c: GateCall): string {
    // id AND the call itself: providers that reuse ids (e.g. "0") must not carry an approval over to a different call.
    return `${c.id ?? ""}|${c.name}|${stableStringify(c.input)}`;
  }

  private classify(name: string, input: unknown): GateClass | null {
    if (this.mode === "full") return null;
    const def = getTool(name);
    if (!def) return null; // unknown tool: the dispatcher reports it
    let valid: unknown;
    try {
      valid = def.validate(input);
    } catch {
      return null; // invalid input never runs, so there is nothing to approve
    }
    // A sensitive tool with no needsApproval is always asked about; one WITH needsApproval is asked only
    // when that says so (e.g. save_memory writes yes, list/search no).
    let flagged = def.approval === "sensitive" && !def.needsApproval;
    if (def.needsApproval) {
      try {
        flagged = !!def.needsApproval(valid, this.ctx);
      } catch {
        flagged = true; // fail closed
      }
    }
    if (flagged) return "call";
    if (this.mode === "request" && def.approval === "network") return "network";
    return null;
  }

  get active(): boolean {
    if (this.mode === "full") return false;
    return this.mode === "request" || getToolsNeedingGate();
  }

  /** True once a turn-wide network decision exists (kept for older call sites). */
  get decided(): boolean {
    return this.networkDecision !== null || this.decisions.size > 0;
  }

  /**
   * Record the user's answer. With `calls` it is stored per call (and, if the batch held plain network calls,
   * as the turn-wide network answer). Without `calls` (legacy) it is the turn-wide network answer only.
   */
  record(approved: boolean, calls?: GateCall[]): void {
    if (!calls) {
      this.networkDecision = approved;
      return;
    }
    for (const c of calls) {
      const cls = this.classify(c.name, c.input);
      if (cls === null) continue;
      if (cls === "network") this.networkDecision = approved;
      else this.decisions.set(this.keyOf(c), approved);
    }
  }

  /** The calls that still need an answer this step (empty -> nothing to ask). */
  callsNeedingPrompt<T extends GateCall>(calls: T[]): T[] {
    return calls.filter((c) => {
      const cls = this.classify(c.name, c.input);
      if (cls === "network") return this.networkDecision === null;
      if (cls === "call") return !this.decisions.has(this.keyOf(c));
      return false;
    });
  }

  actionFor(c: GateCall): ApprovalAction {
    const def = getTool(c.name);
    let label = labelForCall(c.name, c.input);
    // Let a tool spell out the exact effect (e.g. the text of the memory about to be forgotten, not just its id).
    if (def?.describe) {
      try {
        label = def.describe(def.validate(c.input), this.ctx) || label;
      } catch {
        /* keep the plain label */
      }
    }
    return { tool: c.name, label, verb: def?.actionLabel ?? c.name };
  }

  actionsNeedingPrompt(calls: GateCall[]): ApprovalAction[] {
    return this.callsNeedingPrompt(calls).map((c) => this.actionFor(c));
  }

  /** May this call run? Undecided per-call actions are NOT allowed (never silently approved). */
  allows(name: string, input: unknown, id?: string): boolean {
    const cls = this.classify(name, input);
    if (cls === null) return true;
    if (cls === "network") return this.networkDecision !== false;
    return this.decisions.get(this.keyOf({ id, name, input })) === true;
  }
}

function getToolsNeedingGate(): boolean {
  return listTools().some((t) => t.approval === "sensitive" || !!t.needsApproval);
}

