import { describe, it, expect } from "vitest";
import { evaluateMath } from "../src/tools/calc/parser.js";
import { CalcError } from "../src/tools/calc/errors.js";

const ok: [string, string][] = [
  ["1+1", "2"],
  ["2 + 3 * 4", "14"],
  ["(2 + 3) * 4", "20"],
  ["10 - 4 - 3", "3"], // left assoc
  ["100 / 10 / 5", "2"], // left assoc
  ["2 ^ 3 ^ 2", "512"], // right assoc
  ["2 ** 3 ** 2", "512"],
  ["-2 ^ 2", "-4"],
  ["(-2) ^ 2", "4"],
  ["2 ^ -2", "0.25"],
  ["-(-3)", "3"],
  ["--3", "3"],
  ["+5", "5"],
  ["3 * -2", "-6"],
  ["10 % 3", "1"],
  ["-7 % 3", "-1"],
  ["mod(10, 4)", "2"],
  ["0.1 + 0.2", "0.3"],
  ["1.1 * 1.1", "1.21"],
  ["0.3 - 0.1", "0.2"],
  ["1 / 3", "0.333333333333"],
  ["2 / 3", "0.666666666667"],
  ["1e3", "1000"],
  ["1.5e-3 * 2", "0.003"],
  ["2E2", "200"],
  [".5 + .5", "1"],
  ["5.", "5"],
  ["pi", "3.14159265359"],
  ["e", "2.71828182846"],
  ["2 * pi", "6.28318530718"],
  ["sqrt(16)", "4"],
  ["sqrt(2)", "1.41421356237"],
  ["cbrt(27)", "3"],
  ["cbrt(-8)", "-2"],
  ["abs(-4.5)", "4.5"],
  ["round(2.5)", "3"],
  ["round(-2.5)", "-3"],
  ["round(3.14159, 2)", "3.14"],
  ["round(1.005, 2)", "1.01"],
  ["floor(-1.5)", "-2"],
  ["ceil(1.2)", "2"],
  ["ln(e)", "1"],
  ["log(1000)", "3"],
  ["log(8, 2)", "3"],
  ["log10(100)", "2"],
  ["log2(1024)", "10"],
  ["exp(0)", "1"],
  ["sin(0)", "0"],
  ["sin(pi)", "0"],
  ["cos(pi)", "-1"],
  ["tan(0)", "0"],
  ["atan(1) * 4", "3.14159265359"],
  ["asin(1)*2", "3.14159265359"],
  ["acos(1)", "0"],
  ["min(3, 1, 2)", "1"],
  ["max(3, 1, 2)", "3"],
  ["pow(2, 10)", "1024"],
  ["factorial(5)", "120"],
  ["factorial(0)", "1"],
  ["sqrt(abs(-16)) + 2", "6"],
  ["15% of 240", "36"],
  ["15 % of 240", "36"],
  ["240 + 15%", "276"],
  ["240 - 15%", "204"],
  ["50 * 10%", "5"],
  ["200 / 50%", "400"],
  ["20% of 50% of 100", "10"],
  ["15%", "0.15"],
  ["what is 15% of 240", "36"],
  ["9007199254740991", "9007199254740991"],
  ["2^53", "9007199254740992"],
  ["1000000 * 1000000", "1000000000000"],
  ["((((1+2))))", "3"],
  ["PI", "3.14159265359"],
  ["SQRT(9)", "3"],
  ["3 × 4", "12"],
  ["12 ÷ 4", "3"],
];

describe("evaluateMath: correctness table", () => {
  it.each(ok)("%s => %s", (expr, expected) => {
    expect(evaluateMath(expr).result).toBe(expected);
  });
  it("has at least 40 cases", () => expect(ok.length).toBeGreaterThanOrEqual(40));
});

describe("evaluateMath: explicit percentage forms", () => {
  it("what percent of B is A", () => {
    const r = evaluateMath("what percent of 80 is 20");
    expect(r.result).toBe("25");
    expect(r.text).toContain("25%");
  });
  it("A is what percent of B", () => {
    expect(evaluateMath("20 is what percent of 80").result).toBe("25");
    expect(evaluateMath("1+1 is what % of 8").result).toBe("25");
  });
  it("percent change", () => {
    expect(evaluateMath("percent change from 50 to 75").result).toBe("50");
    expect(evaluateMath("percent change from 80 to 60").result).toBe("-25");
  });
  it("percent change from zero is an error", () => {
    expect(() => evaluateMath("percent change from 0 to 5")).toThrow(CalcError);
  });
  it("what percent of 0 is an error", () => {
    expect(() => evaluateMath("5 is what percent of 0")).toThrow(/zero/i);
  });
});

const bad: [string, RegExp][] = [
  ["", /empty|expression/i],
  ["(1+2", /parenthes|\)/i],
  ["1+2)", /parenthes|unexpected/i],
  ["1 +", /unexpected|end/i],
  ["* 3", /unexpected/i],
  ["1 2", /unexpected/i],
  ["2pi", /implicit|unexpected/i],
  ["2(3)", /unexpected/i],
  ["foo + 1", /unknown identifier/i],
  ["foo(1)", /unknown function|unknown identifier/i],
  ["process.exit()", /unexpected|unknown/i],
  ['constructor.constructor("return 1")()', /unexpected|unknown/i],
  ["constructor", /unknown identifier/i],
  ["__proto__", /unknown identifier/i],
  ["toString", /unknown identifier/i],
  ["hasOwnProperty(1)", /unknown/i],
  ["`${1+1}`", /unexpected/i],
  ["'a'", /unexpected/i],
  ["1; 2", /unexpected/i],
  ["a = 1", /unexpected|unknown/i],
  ["[1,2]", /unexpected/i],
  ["{}", /unexpected/i],
  ["1 / 0", /division by zero/i],
  ["5 % 0", /zero/i],
  ["sqrt(-1)", /negative|real/i],
  ["ln(0)", /positive|domain/i],
  ["log(-5)", /positive|domain/i],
  ["asin(2)", /domain|range/i],
  ["factorial(171)", /too large|limit|at most/i],
  ["factorial(-1)", /non-negative|integer/i],
  ["factorial(2.5)", /integer/i],
  ["9**9**9", /exponent|too large/i],
  ["10^1000000", /exponent|too large/i],
  ["10^400", /too large|finite/i],
  ["pow(10, 309)", /too large|finite/i],
  ["0 ^ -1", /zero|finite|undefined/i],
  ["(-8) ^ 0.5", /real|undefined/i],
  ["sqrt(1, 2)", /argument/i],
  ["max()", /argument/i],
  ["pi(1)", /function|unexpected/i],
  ["sqrt 16", /parenthes|\(/i],
  ["1e999", /too large|finite/i],
  ["(".repeat(200) + "1" + ")".repeat(200), /too (deep|long|many)|nest/i],
  ["-".repeat(300) + "1", /too (deep|long|many)|nest/i],
  ["1+".repeat(300) + "1", /too many|too long/i],
  ["1".repeat(501), /too long/i],
  ["e1e", /unexpected|unknown/i],
];

describe("evaluateMath: rejections", () => {
  it.each(bad)("rejects %j", (expr, re) => {
    let err: unknown;
    try {
      evaluateMath(expr);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CalcError);
    expect((err as Error).message).toMatch(re);
  });

  it("does not leak prototype members as constants", () => {
    for (const name of ["constructor", "__proto__", "prototype", "valueOf"]) {
      expect(() => evaluateMath(name)).toThrow(CalcError);
    }
  });

  it("very long input is rejected quickly", () => {
    const t0 = Date.now();
    expect(() => evaluateMath("1+".repeat(100_000))).toThrow(CalcError);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
