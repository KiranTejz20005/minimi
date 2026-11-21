import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_COLOR, PROJECT_COLORS, normalizeProjectColor, parseProjectColor } from "../src/projects.js";

describe("project colors", () => {
  it("accepts every palette color", () => {
    for (const c of PROJECT_COLORS) expect(parseProjectColor(c)).toBe(c);
  });

  it("trims and lowercases", () => {
    expect(parseProjectColor("  Purple ")).toBe("purple");
  });

  it("rejects anything outside the palette", () => {
    for (const bad of ["", "teal", "#ff0000", "red;drop table", null, undefined, 5, {}]) {
      expect(parseProjectColor(bad)).toBeNull();
    }
  });

  it("normalizes unknown or missing values to the default blue", () => {
    expect(DEFAULT_PROJECT_COLOR).toBe("blue");
    expect(normalizeProjectColor(null)).toBe("blue");
    expect(normalizeProjectColor("nope")).toBe("blue");
    expect(normalizeProjectColor("green")).toBe("green");
  });
});
