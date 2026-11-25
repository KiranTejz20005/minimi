/**
 * Minimal, safe JSON fetch for tools that call a FIXED set of public APIs (weather, exchange rates).
 * Unlike fetch_url this never takes a URL from the model: the host must be on the allowlist, redirects are refused,
 * the body is read with a byte cap, and the call has a deadline.
 */

const ALLOWED_HOSTS = new Set(["api.open-meteo.com", "geocoding-api.open-meteo.com", "api.frankfurter.dev"]);
const MAX_BYTES = 300_000;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function getJson<T>(url: string, signal?: AbortSignal, timeoutMs = 8_000): Promise<T> {
  const u = new URL(url);
  if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname)) throw new ApiError("that API host is not allowed");
  const deadline = AbortSignal.timeout(timeoutMs);
  const res = await fetch(u, {
    redirect: "error",
    headers: { Accept: "application/json", "User-Agent": "MinimiAgent/1.0" },
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) throw new ApiError("response too large");
  const reader = res.body?.getReader();
  if (!reader) throw new ApiError("empty response");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new ApiError("response too large");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new ApiError("the API returned something that is not JSON");
  }
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
