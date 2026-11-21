import { describe, expect, it } from "vitest";
import { friendlyError, maskKey, parseTestTarget, validateTavilyKey } from "../src/integrations.js";

describe("validateTavilyKey", () => {
  it("accepts a normal key and trims", () => {
    expect(validateTavilyKey("  tvly-abc123XYZ  ")).toEqual({ ok: true, key: "tvly-abc123XYZ" });
  });
  it.each([["", "Paste"], ["short", "short"], ["has space inside1", "spaces"], ["tvly-é€€€€€€€", "look like"], ["a".repeat(300), "long"]])(
    "rejects %j",
    (v, frag) => {
      const r = validateTavilyKey(v);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(frag);
    },
  );
  it("rejects non-strings", () => {
    expect(validateTavilyKey(123).ok).toBe(false);
    expect(validateTavilyKey(undefined).ok).toBe(false);
  });
});

describe("maskKey", () => {
  it("never reveals more than the last 4 chars", () => {
    expect(maskKey("tvly-abcdefgh1234")).toBe("••••1234");
    expect(maskKey("abc")).toBe("••••");
    expect(maskKey("")).toBeNull();
    expect(maskKey(undefined)).toBeNull();
  });
});

describe("parseTestTarget", () => {
  it("only allows llm/search", () => {
    expect(parseTestTarget("llm")).toBe("llm");
    expect(parseTestTarget("search")).toBe("search");
    expect(parseTestTarget("db")).toBeNull();
  });
});

describe("friendlyError", () => {
  it("scrubs keys and maps common failures", () => {
    expect(friendlyError(new Error("401 Unauthorized tvly-secret123"))).toContain("rejected");
    expect(friendlyError(new Error("The operation was aborted due to timeout"))).toContain("timed out");
    expect(friendlyError(new Error("boom tvly-secret123"))).not.toContain("secret123");
  });
});
