/** Pure helpers for the Integrations routes (kept free of I/O so they are unit-tested). */

export type KeyCheck = { ok: true; key: string } | { ok: false; error: string };

const MAX_KEY_LEN = 256;

/** Validate a pasted Tavily API key. Empty string means "remove the key" and is handled by the caller. */
export function validateTavilyKey(raw: unknown): KeyCheck {
  if (typeof raw !== "string") return { ok: false, error: "Key must be a string." };
  const key = raw.trim();
  if (!key) return { ok: false, error: "Paste a key first." };
  if (key.length > MAX_KEY_LEN) return { ok: false, error: "That key is too long." };
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(key)) return { ok: false, error: "A key can't contain spaces or line breaks." };
  if (!/^[A-Za-z0-9._\-]+$/.test(key)) return { ok: false, error: "That doesn't look like an API key." };
  if (key.length < 8) return { ok: false, error: "That key is too short." };
  return { ok: true, key };
}

/** "tvly-abcd…wxyz" style hint so the UI can show which key is saved without echoing it. */
export function maskKey(key: string | undefined | null): string | null {
  const k = (key ?? "").trim();
  if (!k) return null;
  if (k.length <= 8) return "••••";
  return `••••${k.slice(-4)}`;
}

export type TestTarget = "llm" | "search";

export function parseTestTarget(raw: unknown): TestTarget | null {
  return raw === "llm" || raw === "search" ? raw : null;
}

/** Turn provider errors into one short sentence that never leaks a key. */
export function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const clean = msg.replace(/(tvly|nvapi|sk)-[A-Za-z0-9._-]+/gi, "[key]").replace(/Bearer\s+\S+/gi, "Bearer [key]");
  if (/abort|timeout|timed out/i.test(clean)) return "The request timed out. Check your network and try again.";
  if (/401|403|unauthori[sz]ed|invalid.*key|forbidden/i.test(clean)) return "The provider rejected the key (401/403).";
  if (/429|rate.?limit/i.test(clean)) return "Rate limited by the provider. Try again shortly.";
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|network/i.test(clean)) return "Couldn't reach the provider. Check your network.";
  return clean.slice(0, 160) || "Request failed.";
}
