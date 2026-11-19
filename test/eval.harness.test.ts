import { describe, it, expect } from "vitest";
import { EVAL_CASES } from "../scripts/eval-cases.js";

describe("eval harness", () => {
  it("defines E1–E20", () => {
    expect(EVAL_CASES.map((c) => c.id).sort()).toEqual(
      [
        "E1",
        "E2",
        "E3",
        "E4",
        "E5",
        "E6",
        "E7",
        "E8",
        "E9",
        "E10",
        "E11",
        "E12",
        "E13",
        "E14",
        "E15",
        "E16",
        "E17",
        "E18",
        "E19",
        "E20",
      ].sort(),
    );
  });
});
