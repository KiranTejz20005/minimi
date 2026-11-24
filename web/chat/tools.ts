/*
 * Tool presentation metadata. Pure data + string helpers: no DOM / React imports (unit-tested in test/web-tools.test.ts).
 * Callers: ToolCards.tsx, Message.tsx, RightPanel.tsx, RunsView.tsx, useChat.ts.
 * Unknown tool names never throw: they get a humanised title and a generic icon.
 */

export type ToolIconKey = "globe" | "page" | "memory" | "claims" | "calc" | "file" | "save" | "generic";

export interface ToolMeta {
  /** Short human name, e.g. "Web search". */
  title: string;
  icon: ToolIconKey;
  /** Action phrase used in approval prompts when the server sends no `verb`. */
  verb: string;
  /** Present-participle phrase for running status, e.g. "Fetching page". */
  running: string;
  /** Short result phrase shown before the label once finished. */
  done: string;
  /** Short phrase when the tool failed. */
  failed: string;
  /** True when the tool changes something that persists (asks the user to confirm, worded as a change). */
  persistent?: boolean;
  /** Turns the server's label into what the card/prompt shows. */
  describe(label: string): string;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const quote = (s: string) => (/^["“'].*["”']$/.test(s) ? s : `"${s}"`);
const ident = (label: string) => clean(label);

/** "some_tool-name" -> "Some tool name". */
export function humanizeTool(name: string): string {
  const words = String(name ?? "")
    .replace(/[_\-.]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  if (!words) return "Tool";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const TOOL_META: Record<string, ToolMeta> = {
  web_search: {
    title: "Web search",
    icon: "globe",
    verb: "Web search",
    running: "Searching",
    done: "Searched",
    failed: "Search failed",
    describe: ident,
  },
  fetch_url: {
    title: "Fetch page",
    icon: "page",
    verb: "Fetch page",
    running: "Fetching",
    done: "Fetched",
    failed: "Fetch failed",
    describe: ident,
  },
  memory_search: {
    title: "Memory search",
    icon: "memory",
    verb: "Search memory",
    running: "Searching memory",
    done: "Memory",
    failed: "Memory search failed",
    describe: ident,
  },
  lookup_claims: {
    title: "Claims lookup",
    icon: "claims",
    verb: "Look up claims",
    running: "Looking up claims",
    done: "Claims",
    failed: "Claims lookup failed",
    describe: ident,
  },
  calculate: {
    title: "Calculate",
    icon: "calc",
    verb: "Calculate",
    running: "Calculating",
    done: "Calculated",
    failed: "Calculation failed",
    describe: ident,
  },
  read_attachment: {
    title: "Read file",
    icon: "file",
    verb: "Read attachment",
    running: "Reading",
    done: "Read",
    failed: "Couldn't read",
    describe: ident,
  },
  save_memory: {
    title: "Save to memory",
    icon: "save",
    verb: "Save to memory",
    running: "Saving to memory",
    done: "Memory updated",
    failed: "Memory not saved",
    persistent: true,
    describe: (label) => {
      const t = clean(label);
      return t ? quote(t) : t;
    },
  },
};

const has = (name: string) => Object.prototype.hasOwnProperty.call(TOOL_META, name);

/** Metadata for any tool name, with a graceful fallback for tools this UI has never heard of. */
export function toolMeta(name: string | undefined | null): ToolMeta {
  const n = (name ?? "").trim() || "web_search";
  if (has(n)) return TOOL_META[n]!;
  const title = humanizeTool(n);
  return {
    title,
    icon: "generic",
    verb: title,
    running: `Running ${title.toLowerCase()}`,
    done: title,
    failed: `${title} failed`,
    describe: ident,
  };
}

/** Normalised text for display; never throws on odd input. */
export function describeTool(name: string | undefined | null, label: string | undefined | null): string {
  try {
    return toolMeta(name).describe(String(label ?? ""));
  } catch {
    return clean(String(label ?? ""));
  }
}

export type CardStatus = "running" | "done" | "error" | "declined" | "stopped";

/** Leading phrase of a card header for its status. */
export function statusPhrase(name: string | undefined | null, status: CardStatus): string {
  const m = toolMeta(name);
  if (status === "running") return m.running;
  if (status === "declined") return "Declined";
  if (status === "stopped") return "Stopped";
  if (status === "error") return m.failed;
  return m.done;
}

/** Right-hand status text for finished cards (duration is added by the caller for done). */
export function statusNote(name: string | undefined | null, status: CardStatus, error?: string, duplicate?: boolean): string {
  const m = toolMeta(name);
  switch (status) {
    case "declined":
      return m.persistent
        ? "You declined this change, so nothing was saved and the agent continued without it."
        : "You declined this action, so the agent continued without it.";
    case "stopped":
      return "The run ended before this finished.";
    case "error":
      return readableError(error);
    default:
      return duplicate ? "Reused an earlier result from this answer instead of running it again." : "";
  }
}

/** Server error text made readable: trims, collapses whitespace, caps length, falls back to a generic line. */
export function readableError(error?: string | null): string {
  const t = clean(String(error ?? ""));
  if (!t) return "The tool returned an error.";
  const cap = t.length > 400 ? `${t.slice(0, 399)}…` : t;
  return /[.!?…)"”']$/.test(cap) ? cap : `${cap}.`;
}

/** Status line for the "thinking" row while tool cards run. */
export function runningStatus(cards: { tool?: string; status: string }[]): string | null {
  const running = cards.filter((c) => c.status === "running");
  if (!running.length) return null;
  const tools = [...new Set(running.map((c) => c.tool || "web_search"))];
  if (tools.length === 1 && tools[0] === "web_search") return "Searching the web…";
  return `${toolMeta(tools[0]).running}${tools.length > 1 ? " and more" : ""}…`;
}

/* ── Approval prompt lines ──────────────────────────────────────────────── */

export interface ApprovalAction {
  tool: string;
  label: string;
  verb?: string;
}

export interface ApprovalLine {
  verb: string;
  label: string;
  tool: string;
  persistent: boolean;
}

/** One line per action: server `verb` first, then TOOL_META verb, then the raw tool name. Falls back to plain queries. */
export function approvalLines(queries: string[], actions?: ApprovalAction[] | null): ApprovalLine[] {
  if (actions && actions.length > 0) {
    return actions.map((a) => {
      const tool = String(a?.tool ?? "");
      const meta = toolMeta(tool);
      return {
        tool,
        verb: clean(a?.verb ?? "") || (has(tool) ? meta.verb : tool) || "Action",
        label: meta.describe(String(a?.label ?? "")),
        persistent: !!meta.persistent,
      };
    });
  }
  return (queries ?? []).map((q) => ({ tool: "", verb: "", label: clean(String(q)), persistent: false }));
}

/** Plain-text summary of one line ("Fetch page: https://…"). */
export function approvalLineText(l: ApprovalLine): string {
  return l.verb ? (l.label ? `${l.verb}: ${l.label}` : l.verb) : l.label;
}
