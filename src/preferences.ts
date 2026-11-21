import type { DatabaseSync } from "node:sqlite";

/**
 * User preferences, persisted one row each in the `settings` table as `pref.<name>`.
 * Read by GET/PUT /api/preferences and runTurn. Every field is validated by SCHEMA below; unknown keys are rejected.
 */
export type Delivery = "browser" | "off";

export type Preferences = {
  displayName: string;
  firstName: string;
  lastName: string;
  role: string;
  /** IANA zone; "" = use the browser's. */
  timezone: string;
  email: string;
  personalContext: string;
  workspaceName: string;
  companyContext: string;
  customInstructions: string;
  useInstructions: boolean;
  webSearch: boolean;
  /** Recall earlier conversations by date/topic before answering. */
  memoryRecall: boolean;
  notifyApprovals: Delivery;
  notifyFinished: Delivery;
  notifyFailed: Delivery;
  notifySound: boolean;
};

export const PREF_DEFAULTS: Preferences = {
  displayName: "",
  firstName: "",
  lastName: "",
  role: "",
  timezone: "",
  email: "",
  personalContext: "",
  workspaceName: "Minimi",
  companyContext: "",
  customInstructions: "",
  useInstructions: true,
  webSearch: true,
  memoryRecall: true,
  notifyApprovals: "browser",
  notifyFinished: "browser",
  notifyFailed: "browser",
  notifySound: true,
};

export const MAX_NAME = 60;
export const MAX_INSTRUCTIONS = 2000;
export const MAX_PERSONAL = 500;
export const MAX_WORKSPACE_NAME = 40;
export const ROLES = ["Engineer", "Designer", "Product", "Founder", "Marketing", "Sales", "Operations", "Research", "Student", "Other"] as const;

type Rule =
  | { kind: "text"; max: number; label: string; multiline?: boolean; nonEmpty?: boolean }
  | { kind: "bool" }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "tz" }
  | { kind: "email" };

const SCHEMA: { [K in keyof Preferences]: Rule } = {
  displayName: { kind: "text", max: MAX_NAME, label: "Name" },
  firstName: { kind: "text", max: MAX_NAME, label: "First name" },
  lastName: { kind: "text", max: MAX_NAME, label: "Last name" },
  role: { kind: "enum", values: ["", ...ROLES] },
  timezone: { kind: "tz" },
  email: { kind: "email" },
  personalContext: { kind: "text", max: MAX_PERSONAL, label: "Personal context", multiline: true },
  workspaceName: { kind: "text", max: MAX_WORKSPACE_NAME, label: "Workspace name", nonEmpty: true },
  companyContext: { kind: "text", max: MAX_INSTRUCTIONS, label: "Company context", multiline: true },
  customInstructions: { kind: "text", max: MAX_INSTRUCTIONS, label: "Instructions", multiline: true },
  useInstructions: { kind: "bool" },
  webSearch: { kind: "bool" },
  memoryRecall: { kind: "bool" },
  notifyApprovals: { kind: "enum", values: ["browser", "off"] },
  notifyFinished: { kind: "enum", values: ["browser", "off"] },
  notifyFailed: { kind: "enum", values: ["browser", "off"] },
  notifySound: { kind: "bool" },
};

export type PrefResult = { ok: true; patch: Partial<Preferences> } | { ok: false; error: string };

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const EMAIL_RE = /^[^\s@<>()]{1,64}@[^\s@<>()]{1,255}\.[^\s@<>()]{2,24}$/;

/** Validates a partial update from the client. Unknown keys are rejected, never silently stored. */
export function sanitizePrefs(input: unknown): PrefResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Expected a JSON object." };
  const patch: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const rule = (SCHEMA as Record<string, Rule | undefined>)[k];
    if (!rule) return { ok: false, error: `Unknown setting: ${k.slice(0, 40)}` };
    switch (rule.kind) {
      case "bool":
        if (typeof v !== "boolean") return { ok: false, error: `${k} must be true or false.` };
        patch[k] = v;
        break;
      case "text": {
        if (typeof v !== "string") return { ok: false, error: `${rule.label} must be text.` };
        const s = rule.multiline ? v.replace(/\r\n/g, "\n").trim() : v.replace(/\s+/g, " ").trim();
        if (s.length > rule.max) return { ok: false, error: `${rule.label} is too long (max ${rule.max} characters).` };
        if (rule.nonEmpty && !s) return { ok: false, error: `${rule.label} can't be empty.` };
        patch[k] = s;
        break;
      }
      case "enum":
        if (typeof v !== "string" || !rule.values.includes(v)) return { ok: false, error: `${k} has an unsupported value.` };
        patch[k] = v;
        break;
      case "tz":
        if (typeof v !== "string" || (v !== "" && !isValidTimeZone(v))) return { ok: false, error: "Unknown time zone." };
        patch[k] = v;
        break;
      case "email": {
        if (typeof v !== "string") return { ok: false, error: "Email must be text." };
        const s = v.trim();
        if (s && !EMAIL_RE.test(s)) return { ok: false, error: "That doesn't look like an email address." };
        patch[k] = s;
        break;
      }
    }
  }
  return { ok: true, patch: patch as Partial<Preferences> };
}

export function readPrefs(db: DatabaseSync): Preferences {
  const rows = db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'pref.%'`).all() as { key: string; value: string }[];
  const out: Record<string, string | boolean> = { ...PREF_DEFAULTS };
  for (const r of rows) {
    const k = r.key.slice(5);
    const rule = (SCHEMA as Record<string, Rule | undefined>)[k];
    if (!rule) continue;
    out[k] = rule.kind === "bool" ? r.value === "1" : r.value;
  }
  return out as unknown as Preferences;
}

export function writePrefs(db: DatabaseSync, patch: Partial<Preferences>): Preferences {
  const stmt = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  for (const [k, v] of Object.entries(patch)) {
    stmt.run(`pref.${k}`, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
  }
  return readPrefs(db);
}

/**
 * Everything the user told the assistant about themselves, as one block of plain text for the system prompt
 * (escaped and framed as low priority by customInstructionsBlock). Pure, so it is unit tested.
 */
export function composeUserContext(p: Pick<Preferences, "displayName" | "role" | "personalContext" | "workspaceName" | "companyContext" | "customInstructions" | "useInstructions">): string {
  const parts: string[] = [];
  const who = [p.displayName && `Name: ${p.displayName}`, p.role && `Role: ${p.role}`].filter(Boolean).join(". ");
  const about = [who, p.personalContext].filter(Boolean).join("\n");
  if (about) parts.push(`About the user:\n${about}`);
  if (p.companyContext) parts.push(`About the user's company${p.workspaceName ? ` (${p.workspaceName})` : ""}:\n${p.companyContext}`);
  if (p.useInstructions && p.customInstructions) parts.push(`Custom instructions:\n${p.customInstructions}`);
  return parts.join("\n\n");
}
