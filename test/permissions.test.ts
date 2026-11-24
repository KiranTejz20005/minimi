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
    // Actions now also carry the registry's verb (def.actionLabel) for the approval UI.
    expect(g.actionsNeedingPrompt(calls)).toEqual([{ tool: "fetch_url", label: "http://192.168.1.10/router", verb: "Fetch page" }]);
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

// ---- per-call, registry-driven approvals ----------------------------------------------------------
import { afterAll, beforeAll } from "vitest";
import { registerTool, unregisterTool } from "../src/tools/registry.js";
import type { ToolDefinition } from "../src/tools/types.js";

const sensitiveTool: ToolDefinition = {
  name: "t_sensitive",
  schema: { name: "t_sensitive", description: "x", input_schema: { type: "object", properties: {} } },
  validate: (raw) => raw,
  run: async () => ({ content: "ok" }),
  effect: "write",
  approval: "sensitive",
  actionLabel: "Save to memory",
  label: (raw) => String((raw as { text?: string })?.text ?? "note"),
};
const plainTool: ToolDefinition = {
  name: "t_plain",
  schema: { name: "t_plain", description: "x", input_schema: { type: "object", properties: {} } },
  validate: (raw) => raw,
  run: async () => ({ content: "ok" }),
  needsApproval: (input) => (input as { risky?: boolean })?.risky === true,
  actionLabel: "Do thing",
};
beforeAll(() => {
  registerTool(sensitiveTool);
  registerTool(plainTool);
});
afterAll(() => {
  unregisterTool("t_sensitive");
  unregisterTool("t_plain");
});

describe("PermissionGate per-call decisions", () => {
  const save = (id: string, text: string) => ({ id, name: "t_sensitive", input: { text } });

  it("sensitive tools are asked in auto and request mode, never in full", () => {
    for (const mode of ["auto", "request"] as const) {
      const g = new PermissionGate(true, mode);
      expect(g.actionsNeedingPrompt([save("a", "likes tea")]), mode).toEqual([{ tool: "t_sensitive", label: "likes tea", verb: "Save to memory" }]);
    }
    expect(new PermissionGate(true, "full").actionsNeedingPrompt([save("a", "x")])).toEqual([]);
    expect(new PermissionGate(true, "full").allows("t_sensitive", {}, "a")).toBe(true);
  });

  it("an approval covers only the calls in the answered batch", () => {
    const g = new PermissionGate(true, "auto");
    const first = [save("a", "one")];
    expect(g.actionsNeedingPrompt(first)).toHaveLength(1);
    g.record(true, first);
    expect(g.allows("t_sensitive", { text: "one" }, "a")).toBe(true);
    // A later, different sensitive call is a new decision.
    expect(g.actionsNeedingPrompt([save("b", "two")])).toHaveLength(1);
    expect(g.allows("t_sensitive", { text: "two" }, "b")).toBe(false);
    // The already-decided call is not asked again.
    expect(g.actionsNeedingPrompt([save("a", "one")])).toEqual([]);
  });

  it("one prompt covers all gated calls of a step and the answer is all-or-nothing", () => {
    const g = new PermissionGate(true, "request");
    const batch = [save("a", "one"), save("b", "two"), { id: "c", ...search }];
    const actions = g.actionsNeedingPrompt(batch);
    expect(actions.map((a) => a.tool)).toEqual(["t_sensitive", "t_sensitive", "web_search"]);
    g.record(false, batch);
    expect(batch.every((c) => !g.allows(c.name, c.input, c.id))).toBe(true);
  });

  it("a decline of one sensitive call does not block a later new one from being asked", () => {
    const g = new PermissionGate(true, "auto");
    g.record(false, [save("a", "one")]);
    expect(g.allows("t_sensitive", { text: "one" }, "a")).toBe(false);
    expect(g.actionsNeedingPrompt([save("b", "one")])).toHaveLength(1);
  });

  it("request mode: network approval is once per turn, but does not approve sensitive calls", () => {
    const g = new PermissionGate(true, "request");
    const b1 = [{ id: "s1", ...search }];
    g.record(true, b1);
    expect(g.actionsNeedingPrompt([{ id: "s2", name: "web_search", input: { query: "other" } }, fetchOf("https://example.com")])).toEqual([]);
    expect(g.allows("web_search", { query: "other" }, "s2")).toBe(true);
    expect(g.actionsNeedingPrompt([save("x", "n")])).toHaveLength(1);
    expect(g.allows("t_sensitive", { text: "n" }, "x")).toBe(false);
  });

  it("an undecided sensitive call is never silently allowed", () => {
    const g = new PermissionGate(true, "auto");
    expect(g.allows("t_sensitive", { text: "z" }, "zz")).toBe(false);
  });

  it("needsApproval(input) drives auto mode for any tool", () => {
    const g = new PermissionGate(true, "auto");
    expect(g.actionsNeedingPrompt([{ id: "1", name: "t_plain", input: {} }])).toEqual([]);
    expect(g.actionsNeedingPrompt([{ id: "2", name: "t_plain", input: { risky: true } }])).toEqual([{ tool: "t_plain", label: "Do thing", verb: "Do thing" }]);
  });

  it("request mode: a risky network call is still decided per call", () => {
    const g = new PermissionGate(true, "request");
    const pub = { id: "p", ...fetchOf("https://example.com") };
    g.record(true, [pub]);
    const priv = { id: "q", ...fetchOf("http://10.0.0.1/admin") };
    expect(g.actionsNeedingPrompt([priv])).toHaveLength(1);
    expect(g.allows(priv.name, priv.input, priv.id)).toBe(false);
  });

  it("unknown tools and invalid inputs never prompt (the dispatcher reports them)", () => {
    const g = new PermissionGate(true, "request");
    expect(g.actionsNeedingPrompt([{ id: "u", name: "no_such_tool", input: {} }, { id: "v", name: "fetch_url", input: { url: 5 } }])).toEqual([]);
  });

  it("a throwing needsApproval fails closed (asks)", () => {
    const boom: ToolDefinition = { ...plainTool, name: "t_boom", schema: { ...plainTool.schema, name: "t_boom" }, needsApproval: () => { throw new Error("x"); } };
    registerTool(boom);
    try {
      expect(new PermissionGate(true, "auto").actionsNeedingPrompt([{ id: "1", name: "t_boom", input: {} }])).toHaveLength(1);
    } finally {
      unregisterTool("t_boom");
    }
  });
});
