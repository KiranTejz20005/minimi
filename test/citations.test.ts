import { describe, it, expect } from "vitest";
import {
  citedNumbers,
  stripInvalidCitations,
} from "../src/agent/citations.js";

describe("citations", () => {
  it("strips unknown citation numbers", () => {
    const valid = new Set([1, 2, 3]);
    const { text } = {
      text: stripInvalidCitations("Fact [1] and fake [9] more [2].", valid),
    };
    expect(text).toBe("Fact [1] and fake  more [2].");
    expect(text).not.toContain("[9]");
  });

  it("citedNumbers collects sorted unique", () => {
    expect(citedNumbers("See [2] and [1] and [2] again.")).toEqual([1, 2]);
  });
});
