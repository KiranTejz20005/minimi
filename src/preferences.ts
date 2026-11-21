import type { DatabaseSync } from "node:sqlite";

/** User preferences, persisted one row each in the `settings` table as `pref.<name>`. Read by GET/PUT /api/preferences and runTurn. */
export type Preferences = {
  displayName: string;
  customInstructions: string;
  useInstructions: boolean;
  webSearch: boolean;
};

export const PREF_DEFAULTS: Preferences = {
  displayName: "",
  customInstructions: "",
  useInstructions: true,
  webSearch: true,
};

export const MAX_NAME = 60;
export const MAX_INSTRUCTIONS = 2000;

export type PrefResult = { ok: true; patch: Partial<Preferences> } | { ok: false; error: string };

/** Validates a partial update from the client. Unknown keys are rejected, never silently stored. */
export function sanitizePrefs(input: unknown): PrefResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Expected a JSON object." };
  const patch: Partial<Preferences> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    switch (k) {
      case "displayName": {
        if (typeof v !== "string") return { ok: false, error: "displayName must be text." };
        const s = v.replace(/\s+/g, " ").trim();
        if (s.length > MAX_NAME) return { ok: false, error: `Name is too long (max ${MAX_NAME} characters).` };
        patch.displayName = s;
        break;
      }
      case "customInstructions": {
        if (typeof v !== "string") return { ok: false, error: "customInstructions must be text." };
        const s = v.replace(/\r\n/g, "\n").trim();
        if (s.length > MAX_INSTRUCTIONS) return { ok: false, error: `Instructions are too long (max ${MAX_INSTRUCTIONS} characters).` };
        patch.customInstructions = s;
        break;
      }
      case "useInstructions":
      case "webSearch":
        if (typeof v !== "boolean") return { ok: false, error: `${k} must be true or false.` };
        patch[k] = v;
        break;
      default:
        return { ok: false, error: `Unknown setting: ${k.slice(0, 40)}` };
    }
  }
  return { ok: true, patch };
}

export function readPrefs(db: DatabaseSync): Preferences {
  const rows = db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'pref.%'`).all() as { key: string; value: string }[];
  const out: Preferences = { ...PREF_DEFAULTS };
  for (const r of rows) {
    const k = r.key.slice(5);
    if (k === "displayName" || k === "customInstructions") out[k] = r.value;
    else if (k === "useInstructions" || k === "webSearch") out[k] = r.value === "1";
  }
  return out;
}

export function writePrefs(db: DatabaseSync, patch: Partial<Preferences>): Preferences {
  const stmt = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  for (const [k, v] of Object.entries(patch)) {
    stmt.run(`pref.${k}`, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
  }
  return readPrefs(db);
}
