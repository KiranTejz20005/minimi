import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { defaultResolver, resolvePublicAddresses, type ResolvedAddress, type Resolver } from "./ssrf.js";

/**
 * SSRF-safe HTTP GET used by fetch_url (src/tools/fetch-url.ts). Properties:
 *  - redirects are followed manually (max hops); EVERY hop's scheme and resolved addresses are validated BEFORE connecting
 *  - DNS is resolved once per hop, all answers validated, and the socket is pinned to a validated address
 *    (TLS still verifies against the original hostname, so rebinding between check and connect is impossible)
 *  - the body is streamed and aborted past maxBytes; a total deadline cuts slow-drip responses
 *  - no credentials in URLs, http(s) only, no response decompression (Accept-Encoding: identity)
 */

export class SafeFetchError extends Error {
  constructor(
    message: string,
    readonly code: "blocked" | "scheme" | "credentials" | "redirects" | "too_large" | "timeout" | "aborted" | "network" | "invalid_url",
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export type TransportRequest = {
  url: URL;
  /** Validated address the socket MUST connect to. */
  address: ResolvedAddress;
  headers: Record<string, string>;
  signal: AbortSignal;
};

export type TransportResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
};

export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export type SafeFetchOptions = {
  maxBytes?: number;
  maxRedirects?: number;
  /** Total deadline across all hops and the body read. */
  timeoutMs?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Injectable DNS (tests). */
  resolve?: Resolver;
  /** Injectable transport (tests). */
  transport?: Transport;
  /** TEST ONLY: skip address validation. Production code must never set this. */
  allowPrivate?: boolean;
};

export type SafeFetchResult = {
  /** Final URL after redirects. */
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
  redirects: number;
};

const DEFAULT_MAX_BYTES = 1_500_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;

export const nodeTransport: Transport = (req) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const { url, address, headers, signal } = req;
    const isHttps = url.protocol === "https:";
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    // Pin: whatever Node asks us to look up, answer with the validated address.
    const lookup: LookupFunction = (_host, options, cb) => {
      const opts = options as { all?: boolean };
      if (opts && opts.all) {
        (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
          { address: address.address, family: address.family },
        ]);
      } else {
        cb(null, address.address, address.family);
      }
    };
    const mod = isHttps ? https : http;
    const r = mod.request(
      {
        protocol: url.protocol,
        hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers,
        lookup,
        agent: false,
        signal,
        // servername defaults to hostname (SNI + certificate verification use the original name, not the pinned IP)
      },
      (res) => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: res as AsyncIterable<Uint8Array>,
          destroy: () => res.destroy(),
        });
      },
    );
    r.on("error", reject);
    r.end();
  });

function headerValue(h: string | string[] | undefined): string {
  return Array.isArray(h) ? (h[0] ?? "") : (h ?? "");
}

function abortError(signal: AbortSignal): SafeFetchError {
  const reason = signal.reason as { name?: string } | undefined;
  return reason?.name === "TimeoutError"
    ? new SafeFetchError("timeout", "timeout")
    : new SafeFetchError("request cancelled", "aborted");
}

function validateUrl(u: URL): void {
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new SafeFetchError("only http(s) URLs are allowed", "scheme");
  }
  if (u.username || u.password) {
    throw new SafeFetchError("URLs with credentials are not allowed", "credentials");
  }
}

async function pickAddress(host: string, opts: SafeFetchOptions): Promise<ResolvedAddress> {
  const resolve = opts.resolve ?? defaultResolver;
  if (opts.allowPrivate) {
    const h = host.replace(/^\[|\]$/g, "");
    if (/^[\d.]+$/.test(h)) return { address: h, family: 4 };
    if (h.includes(":")) return { address: h, family: 6 };
    const a = await resolve(h);
    if (!a.length) throw new SafeFetchError("could not resolve host", "blocked");
    return a[0]!;
  }
  try {
    const addrs = await resolvePublicAddresses(host, resolve);
    return addrs[0]!;
  } catch (e) {
    throw new SafeFetchError(e instanceof Error ? e.message : "that host is not allowed", "blocked");
  }
}

/** Race a promise against the abort signal so hung sockets/iterators cannot outlive the deadline. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export async function safeFetch(rawUrl: string | URL, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const deadline = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const transport = options.transport ?? nodeTransport;
  const headers: Record<string, string> = {
    Accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5",
    "User-Agent": "MinimiBot/1.0 (+local; read-only)",
    "Accept-Encoding": "identity",
    ...options.headers,
  };

  let current: URL;
  try {
    current = rawUrl instanceof URL ? new URL(rawUrl.href) : new URL(rawUrl);
  } catch {
    throw new SafeFetchError("invalid URL", "invalid_url");
  }

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (signal.aborted) throw abortError(signal);
    validateUrl(current);
    const address = await raceAbort(pickAddress(current.hostname, options), signal);

    let res: TransportResponse;
    try {
      res = await raceAbort(transport({ url: current, address, headers, signal }), signal);
    } catch (e) {
      if (e instanceof SafeFetchError) throw e;
      if (signal.aborted) throw abortError(signal);
      throw new SafeFetchError("request failed", "network");
    }
    const onAbort = () => res.destroy();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const loc = headerValue(res.headers["location"]);
      if (res.status >= 300 && res.status < 400 && loc) {
        res.destroy();
        if (hop === maxRedirects) throw new SafeFetchError("too many redirects", "redirects");
        try {
          current = new URL(loc, current);
        } catch {
          throw new SafeFetchError("invalid redirect target", "invalid_url");
        }
        continue; // next iteration re-validates scheme + addresses BEFORE connecting
      }

      const declared = Number(headerValue(res.headers["content-length"]));
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.destroy();
        throw new SafeFetchError("page too large", "too_large");
      }
      const chunks: Buffer[] = [];
      let total = 0;
      const it = res.body[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = await raceAbort(it.next(), signal);
          if (next.done) break;
          const chunk = Buffer.from(next.value);
          total += chunk.length;
          if (total > maxBytes) {
            res.destroy();
            throw new SafeFetchError("page too large", "too_large");
          }
          chunks.push(chunk);
        }
      } catch (e) {
        res.destroy();
        if (e instanceof SafeFetchError) throw e;
        if (signal.aborted) throw abortError(signal);
        throw new SafeFetchError("request failed", "network");
      }
      return {
        url: current.href,
        status: res.status,
        contentType: headerValue(res.headers["content-type"]).toLowerCase(),
        body: Buffer.concat(chunks, total),
        redirects: hop,
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
  throw new SafeFetchError("too many redirects", "redirects");
}
