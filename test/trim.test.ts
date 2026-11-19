import { describe, it, expect } from "vitest";
import { splitPassages, trimContent } from "../src/search/trim.js";
import { MAX_CHARS_PER_RESULT } from "../src/search/types.js";

describe("trim", () => {
  it("splitPassages handles chunk markers and paragraphs", () => {
    const parts = splitPassages("Intro\n\n<chunk 1> Detail line\n\nTail");
    expect(parts.length).toBeGreaterThan(1);
  });

  it("trimContent respects maxChars", () => {
    const long = "word ".repeat(500);
    const out = trimContent("pricing", long, 200);
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it("trimContent keeps price-relevant passage for pricing query", () => {
    const body = [
      "Company blog about culture and team events.",
      "Sales Hub Professional costs $90 per seat per month when billed annually.",
    ].join("\n\n");
    const out = trimContent(
      "Sales Hub Professional $90 seat month",
      body,
      MAX_CHARS_PER_RESULT,
    );
    expect(out).toMatch(/\$90/);
  });
});
