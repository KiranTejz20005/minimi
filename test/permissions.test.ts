import { describe, expect, it } from "vitest";
import { looksPrivateUrl, parseApprovalMode, PermissionGate } from "../src/agent/permissions.js";

const search = { name: "web_search", input: { query: "nvidia ceo" } };
const memory = { name: "memory_search", input: { query: "pricing" } };
const fetchOf = (url: string) => ({ name: "fetch_url", input: { url } });

describe("parseApprovalMode", () => {
  it("accepts the three modes", () => {
    expect(parseApprovalMode("request")).toBe("request");
    expect(parseApprovalMode("auto")).toBe("auto");
    expect(parseApprovalMode("full")).toBe("full");
  });
  it("falls back to auto for anything else", () => {
    for (const v of [undefined, null, "", "FULL", "everything", 1, true, {}, ["full"]]) expect(parseApprovalMode(v)).toBe("auto");
  });
});

describe("looksPrivateUrl", () => {
  it("flags local and internal targets", () => {
    for (const u of [
      "http://localhost:3000/x",
      "http://127.0.0.1",
      "http://10.1.2.3/admin",
      "http://192.168.0.5",
      "http://172.20.0.1",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]:8080",
      "http://intranet/wiki",
      "https://printer.local",
      "not a url at all",
    ])
      expect(looksPrivateUrl(u), u).toBe(true);
  });
  it("lets public pages through", () => {
    for (const u of ["https://example.com", "https://docs.nvidia.com/nim", "http://172.32.0.1", "http://8.8.8.8", "example.org/page"]) expect(looksPrivateUrl(u), u).toBe(false);
  });
  it("ignores a missing url", () => {
    expect(looksPrivateUrl(undefined)).toBe(false);
    expect(looksPrivateUrl("")).toBe(false);
  });
});

describe("PermissionGate modes", () => {
  it("request: asks before every network tool, never for memory tools", () => {
    const g = new PermissionGate(true, "request");
    expect(g.active).toBe(true);
    expect(g.actionsNeedingPrompt([search, fetchOf("https://example.com"), memory]).map((a) => a.tool)).toEqual(["web_search", "fetch_url"]);
  });

  it("request: a decline blocks network tools for the rest of the turn and is not asked twice", () => {
    const g = new PermissionGate(true, "request");
    g.record(false);
    expect(g.actionsNeedingPrompt([search])).toEqual([]);
    expect(g.allows("web_search", search.input)).toBe(false);
    expect(g.allows("memory_search", memory.input)).toBe(true);
  });

  it("request: an approval allows the turn", () => {
    const g = new PermissionGate(true, "request");
    g.record(true);
    expect(g.allows("web_search", search.input)).toBe(true);
  });

  it("auto: public searches and fetches run without asking", () => {
    const g = new PermissionGate(true, "auto");
    expect(g.actionsNeedingPrompt([search, fetchOf("https://example.com/a"), memory])).toEqual([]);
    expect(g.allows("fetch_url", { url: "https://example.com/a" })).toBe(true);
  });

  it("auto: private-looking fetches are asked about, and blocked if declined", () => {
    const g = new PermissionGate(true, "auto");
    const calls = [search, fetchOf("http://192.168.1.10/router")];
    expect(g.actionsNeedingPrompt(calls)).toEqual([{ tool: "fetch_url", label: "http://192.168.1.10/router" }]);
    g.record(false);
    expect(g.allows("fetch_url", { url: "http://192.168.1.10/router" })).toBe(false);
    expect(g.allows("web_search", search.input)).toBe(true);
  });

  it("full: never asks and never blocks", () => {
    const g = new PermissionGate(true, "full");
    expect(g.active).toBe(false);
    expect(g.actionsNeedingPrompt([search, fetchOf("http://localhost:3000")])).toEqual([]);
    expect(g.allows("fetch_url", { url: "http://localhost:3000" })).toBe(true);
  });

  it("defaults to auto", () => {
    expect(new PermissionGate().actionsNeedingPrompt([search])).toEqual([]);
  });
});
