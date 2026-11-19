import { describe, expect, it } from "vitest";
import { parallelOkFromTraces } from "../src/eval/parallel-trace.js";

describe("parallelOkFromTraces", () => {
  it("passes when parallelMin <= 1", () => {
    expect(parallelOkFromTraces([], 1)).toBe(true);
  });

  it("requires first search batch to be parallel with enough queries", () => {
    const ok = parallelOkFromTraces(
      [
        {
          stage: "search",
          detail: JSON.stringify({
            parallel: true,
            count: 5,
            queries: [{ query: "a", durationMs: 1 }],
          }),
        },
      ],
      5,
    );
    expect(ok).toBe(true);
  });

  it("fails when count is below parallelMin", () => {
    const no = parallelOkFromTraces(
      [
        {
          stage: "search",
          detail: JSON.stringify({ parallel: true, count: 3 }),
        },
      ],
      5,
    );
    expect(no).toBe(false);
  });
});
