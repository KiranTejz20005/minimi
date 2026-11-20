import { isIP } from "node:net";
import { promises as dns } from "node:dns";

/** Sync check for literal IPs / obvious local names. Hostnames need assertPublicHost. */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return true;
  }
  if (host === "0.0.0.0" || host === "::" || host === "::1") return true;
  if (host === "metadata.google.internal") return true;

  const ipVersion = isIP(host);
  if (ipVersion === 4) return isPrivateV4(host);
  if (ipVersion === 6) return isPrivateV6(host);
  return false;
}

/** Resolve hostname and reject if any address is private/link-local (SSRF hardening). */
export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (isBlockedHost(host)) {
    throw new Error("that host is not allowed");
  }
  if (isIP(host)) return;
  let addrs: { address: string; family: number }[];
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error("could not resolve host");
  }
  if (!addrs.length) throw new Error("could not resolve host");
  for (const a of addrs) {
    if (isBlockedHost(a.address)) {
      throw new Error("that host resolves to a private address");
    }
  }
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateV6(ip: string): boolean {
  const norm = ip.toLowerCase();
  if (norm === "::1" || norm === "::") return true;
  if (norm.startsWith("fc") || norm.startsWith("fd")) return true;
  if (norm.startsWith("fe80")) return true;
  const mapped = norm.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateV4(mapped[1]);
  return false;
}
