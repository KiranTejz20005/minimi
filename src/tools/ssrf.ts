import { isIP } from "node:net";
import { promises as dns } from "node:dns";

/**
 * SSRF guard. Callers: src/tools/fetch-url.ts and src/tools/safe-fetch.ts (isBlockedHost / assertPublicHost /
 * resolvePublicAddresses). Everything here is fail-closed: anything we cannot parse is treated as blocked.
 */

export type ResolvedAddress = { address: string; family: number };
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const defaultResolver: Resolver = async (hostname) =>
  dns.lookup(hostname, { all: true, verbatim: true });

/** Strict dotted-quad parser. Returns null for anything else (octal/hex/decimal forms, leading zeros, ...). */
export function parseIPv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    if (p.length > 1 && p.startsWith("0")) return null; // ambiguous octal form
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out as [number, number, number, number];
}

/** Parse an IPv6 literal (optional zone id, optional embedded dotted v4 tail) into 8 16-bit groups. */
export function parseIPv6(input: string): number[] | null {
  let s = input.trim().toLowerCase();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  if (!s.includes(":")) return null;
  // embedded IPv4 tail
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const dbl = s.split("::");
  if (dbl.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };
  const head = parseGroups(dbl[0] ?? "");
  if (!head) return null;
  if (dbl.length === 1) return head.length === 8 ? head : null;
  const rest = parseGroups(dbl[1] ?? "");
  if (!rest) return null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest];
}

function isBlockedV4(p: readonly number[]): boolean {
  const [a, b, c] = p as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a >= 224) return true; // multicast, reserved (240/4), broadcast
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true;
  if (a === 168 && b === 63 && c === 129 && (p as number[])[3] === 16) return true; // Azure wire server
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol + TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  return false;
}

function v4FromGroups(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 255, lo >> 8, lo & 255];
}

function isBlockedV6(g: readonly number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const first5Zero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (first5Zero && g5 === 0xffff) return isBlockedV4(v4FromGroups(g6, g7)); // ::ffff:a.b.c.d (any notation)
  if (first5Zero && g5 === 0) return true; // ::, ::1, IPv4-compatible ::a.b.c.d
  // ::ffff:0:a.b.c.d (SIIT)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
    return isBlockedV4(v4FromGroups(g6, g7));
  }
  // 64:ff9b::/96 NAT64 well-known prefix -> check embedded v4; 64:ff9b:1::/48 local-use -> blocked
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isBlockedV4(v4FromGroups(g6, g7));
    return true;
  }
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // 100::/64 discard
  if (g0 === 0x2001 && g1 === 0) return true; // Teredo 2001::/32
  if (g0 === 0x2001 && g1 === 0xdb8) return true; // documentation
  if (g0 === 0x2002) return isBlockedV4(v4FromGroups(g1, g2)); // 6to4 embeds v4
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** True when the literal IP is private/reserved or cannot be parsed. */
export function isBlockedIp(ip: string): boolean {
  const s = ip.trim().replace(/^\[|\]$/g, "");
  if (s.includes(":")) {
    const g = parseIPv6(s);
    return g ? isBlockedV6(g) : true;
  }
  const v4 = parseIPv4(s);
  return v4 ? isBlockedV4(v4) : true;
}

const NUMERIC_HOST = /^(0x[0-9a-f]*|\d+)(\.(0x[0-9a-f]*|\d+))*$/i;

/** Sync check for literal IPs / obvious local names. Hostnames still need assertPublicHost. */
export function isBlockedHost(hostname: string): boolean {
  let host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  host = host.replace(/\.+$/, ""); // "localhost." trailing-dot trick
  if (!host) return true;
  if (/[\s\0/\\@#?]/.test(host)) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localdomain")) return true;
  if (host === "metadata.google.internal") return true;
  if (host.includes(":")) return isBlockedIp(host);
  if (isIP(host) === 4 || parseIPv4(host)) return isBlockedIp(host);
  // numeric-looking but not a canonical dotted quad (decimal/hex/octal/short forms): never a legit public host
  if (NUMERIC_HOST.test(host)) return true;
  return false;
}

/**
 * Resolve once and validate EVERY answer. Returns the validated addresses so the caller can pin the
 * connection to one of them (closes the DNS-rebinding window between check and connect).
 */
export async function resolvePublicAddresses(
  hostname: string,
  resolve: Resolver = defaultResolver,
): Promise<ResolvedAddress[]> {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (isBlockedHost(host)) throw new Error("that host is not allowed");
  if (host.includes(":")) return [{ address: host, family: 6 }];
  if (parseIPv4(host)) return [{ address: host, family: 4 }];
  let addrs: ResolvedAddress[];
  try {
    addrs = await resolve(host);
  } catch {
    throw new Error("could not resolve host");
  }
  if (!addrs.length) throw new Error("could not resolve host");
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw new Error("that host resolves to a private address");
  }
  return addrs;
}

/** Resolve hostname and reject if any address is private/link-local (SSRF hardening). */
export async function assertPublicHost(hostname: string, resolve: Resolver = defaultResolver): Promise<void> {
  await resolvePublicAddresses(hostname, resolve);
}
