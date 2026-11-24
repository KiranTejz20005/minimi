import { describe, it, expect } from "vitest";
import { assertPublicHost, isBlockedHost, isBlockedIp, resolvePublicAddresses } from "../src/tools/ssrf.js";

describe("ssrf: IPv4", () => {
  const blocked = [
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "127.0.0.1", "127.255.255.254", "169.254.169.254",
    "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "100.127.255.255",
    "192.0.0.1", "192.0.2.5", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9",
    "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
  ];
  for (const ip of blocked) it(`blocks ${ip}`, () => expect(isBlockedIp(ip)).toBe(true));
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "100.63.0.1", "93.184.216.34", "198.20.0.1"]) {
    it(`allows ${ip}`, () => expect(isBlockedIp(ip)).toBe(false));
  }
  it("fails closed on junk", () => {
    expect(isBlockedIp("999.1.1.1")).toBe(true);
    expect(isBlockedIp("010.0.0.1")).toBe(true);
    expect(isBlockedIp("")).toBe(true);
  });
});

describe("ssrf: IPv6", () => {
  const blocked = [
    "::", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:7f00:0001",
    "::ffff:a9fe:a9fe", "::ffff:10.1.2.3", "::127.0.0.1", "::7f00:1",
    "64:ff9b::7f00:1", "64:ff9b::a00:1", "64:ff9b::169.254.169.254", "64:ff9b:1::1",
    "fec0::1", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0", "febf::1",
    "ff02::1", "ff00::", "2001:db8::1", "2002:7f00:1::1", "2001:0::1",
  ];
  for (const ip of blocked) it(`blocks ${ip}`, () => expect(isBlockedIp(ip)).toBe(true));
  for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"]) {
    it(`allows ${ip}`, () => expect(isBlockedIp(ip)).toBe(false));
  }
  it("fails closed on junk", () => {
    expect(isBlockedIp("::1::2")).toBe(true);
    expect(isBlockedIp("gggg::1")).toBe(true);
  });
});

describe("ssrf: hostnames and URL forms", () => {
  it("blocks local names including trailing dot", () => {
    for (const h of ["localhost", "LOCALHOST", "localhost.", "foo.localhost", "printer.local", "metadata.google.internal", "svc.internal", "[::1]", ""]) {
      expect(isBlockedHost(h)).toBe(true);
    }
  });
  it("blocks non-canonical numeric hosts", () => {
    for (const h of ["2130706433", "0x7f000001", "0x7f.0.0.1", "017700000001", "127.1", "1.2.3"]) {
      expect(isBlockedHost(h)).toBe(true);
    }
  });
  it("WHATWG URL normalises obfuscated IPs to something we block", () => {
    for (const u of ["http://2130706433/", "http://0x7f.1/", "http://0177.0.0.1/", "http://127.1/", "http://[::ffff:7f00:1]/", "http://[::ffff:127.0.0.1]/", "http://localhost./"]) {
      expect(isBlockedHost(new URL(u).hostname)).toBe(true);
    }
  });
  it("allows ordinary public hostnames and literals", () => {
    expect(isBlockedHost("example.com")).toBe(false);
    expect(isBlockedHost("8.8.8.8")).toBe(false);
  });
  it("rejects hosts with smuggled characters", () => {
    expect(isBlockedHost("evil.com@127.0.0.1")).toBe(true);
    expect(isBlockedHost("a b")).toBe(true);
  });
});

describe("ssrf: resolution", () => {
  it("returns validated addresses for public answers", async () => {
    const out = await resolvePublicAddresses("example.com", async () => [{ address: "93.184.216.34", family: 4 }]);
    expect(out).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });
  it("rejects when ANY answer is private", async () => {
    await expect(
      assertPublicHost("example.com", async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ]),
    ).rejects.toThrow(/private/);
  });
  it("rejects hex-mapped v6 answers", async () => {
    await expect(assertPublicHost("x.example", async () => [{ address: "::ffff:7f00:1", family: 6 }])).rejects.toThrow();
  });
  it("rejects unresolvable and empty", async () => {
    await expect(assertPublicHost("x.example", async () => { throw new Error("nx"); })).rejects.toThrow(/resolve/);
    await expect(assertPublicHost("x.example", async () => [])).rejects.toThrow(/resolve/);
  });
  it("does not call the resolver for blocked literals", async () => {
    let called = false;
    await expect(assertPublicHost("127.0.0.1", async () => { called = true; return []; })).rejects.toThrow();
    expect(called).toBe(false);
  });
});
