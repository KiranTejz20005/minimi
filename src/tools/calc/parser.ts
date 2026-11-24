import { CalcError, excerpt, formatNumber, type CalcOutput } from "./errors.js";

/**
 * Safe math evaluator: tokenizer + recursive-descent parser + tree walker. No eval / Function / vm, and
 * identifiers resolve only through Maps (so `constructor`, `__proto__` etc. are just unknown names).
 *
 * Grammar (lowest to highest precedence):
 *   additive := term (('+'|'-') term)*          `240 + 15%` means 240 * 1.15 (percent of the left operand)
 *   term     := unary (('*'|'/'|'%') unary)*    binary '%' is modulo, only when an operand follows it
 *   unary    := ('-'|'+') unary | power
 *   power    := postfix ('^'|'**' unary)?       right associative; -2^2 = -4; 2^-2 = 0.25
 *   postfix  := primary ('%' ['of' unary])?     `15%` = 0.15, `15% of 240` = 36
 */

export const MAX_INPUT_CHARS = 500;
const MAX_TOKENS = 200;
const MAX_DEPTH = 64;
const MAX_EXPONENT = 10_000;
const MAX_FACTORIAL = 170;

type Token = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

type Node =
  | { k: "num"; v: number }
  | { k: "pct"; e: Node }
  | { k: "neg"; e: Node }
  | { k: "bin"; op: string; l: Node; r: Node }
  | { k: "addpct"; op: "+" | "-"; l: Node; r: Node }
  | { k: "call"; name: string; args: Node[] };

const CONSTANTS = new Map<string, number>([
  ["pi", Math.PI],
  ["e", Math.E],
  ["tau", Math.PI * 2],
]);

function need(name: string, n: number, args: number[]): void {
  if (args.length !== n) throw new CalcError(`${name} takes ${n} argument${n === 1 ? "" : "s"}, got ${args.length}`);
}
function needRange(name: string, min: number, max: number, args: number[]): void {
  if (args.length < min || args.length > max) {
    throw new CalcError(`${name} takes ${min === max ? min : `${min} to ${max}`} argument(s), got ${args.length}`);
  }
}
function snap(x: number): number {
  return Math.abs(x) < 1e-12 ? 0 : x;
}
function roundHalfAway(x: number, digits: number): number {
  const a = Math.abs(x);
  const s = String(a);
  const r = s.includes("e") ? Math.round(a * 10 ** digits) / 10 ** digits : Number(`${Math.round(Number(`${s}e${digits}`))}e-${digits}`);
  return x < 0 ? -r : r;
}
function domain(name: string, ok: boolean, msg: string): void {
  if (!ok) throw new CalcError(`${name}: ${msg}`);
}

const FUNCTIONS = new Map<string, (a: number[]) => number>([
  ["sqrt", (a) => (need("sqrt", 1, a), domain("sqrt", a[0]! >= 0, "a negative number has no real square root"), Math.sqrt(a[0]!))],
  ["cbrt", (a) => (need("cbrt", 1, a), Math.cbrt(a[0]!))],
  ["abs", (a) => (need("abs", 1, a), Math.abs(a[0]!))],
  ["sign", (a) => (need("sign", 1, a), Math.sign(a[0]!))],
  ["floor", (a) => (need("floor", 1, a), Math.floor(a[0]!))],
  ["ceil", (a) => (need("ceil", 1, a), Math.ceil(a[0]!))],
  ["trunc", (a) => (need("trunc", 1, a), Math.trunc(a[0]!))],
  [
    "round",
    (a) => {
      needRange("round", 1, 2, a);
      const d = a[1] ?? 0;
      domain("round", Number.isInteger(d) && d >= 0 && d <= 15, "digits must be an integer from 0 to 15");
      return roundHalfAway(a[0]!, d);
    },
  ],
  ["ln", (a) => (need("ln", 1, a), domain("ln", a[0]! > 0, "requires a positive number (domain error)"), Math.log(a[0]!))],
  [
    "log",
    (a) => {
      needRange("log", 1, 2, a);
      domain("log", a[0]! > 0, "requires a positive number (domain error)");
      if (a.length === 1) return Math.log10(a[0]!);
      domain("log", a[1]! > 0 && a[1] !== 1, "base must be positive and not 1");
      return Math.log(a[0]!) / Math.log(a[1]!);
    },
  ],
  ["log10", (a) => (need("log10", 1, a), domain("log10", a[0]! > 0, "requires a positive number (domain error)"), Math.log10(a[0]!))],
  ["log2", (a) => (need("log2", 1, a), domain("log2", a[0]! > 0, "requires a positive number (domain error)"), Math.log2(a[0]!))],
  ["exp", (a) => (need("exp", 1, a), Math.exp(a[0]!))],
  ["sin", (a) => (need("sin", 1, a), snap(Math.sin(a[0]!)))],
  ["cos", (a) => (need("cos", 1, a), snap(Math.cos(a[0]!)))],
  ["tan", (a) => (need("tan", 1, a), snap(Math.tan(a[0]!)))],
  ["asin", (a) => (need("asin", 1, a), domain("asin", Math.abs(a[0]!) <= 1, "domain is [-1, 1]"), Math.asin(a[0]!))],
  ["acos", (a) => (need("acos", 1, a), domain("acos", Math.abs(a[0]!) <= 1, "domain is [-1, 1]"), Math.acos(a[0]!))],
  ["atan", (a) => (need("atan", 1, a), Math.atan(a[0]!))],
  ["atan2", (a) => (need("atan2", 2, a), Math.atan2(a[0]!, a[1]!))],
  ["radians", (a) => (need("radians", 1, a), (a[0]! * Math.PI) / 180)],
  ["degrees", (a) => (need("degrees", 1, a), (a[0]! * 180) / Math.PI)],
  ["min", (a) => (domain("min", a.length >= 1, "takes at least 1 argument"), Math.min(...a))],
  ["max", (a) => (domain("max", a.length >= 1, "takes at least 1 argument"), Math.max(...a))],
  ["pow", (a) => (need("pow", 2, a), power(a[0]!, a[1]!))],
  ["mod", (a) => (need("mod", 2, a), modulo(a[0]!, a[1]!))],
  [
    "factorial",
    (a) => {
      need("factorial", 1, a);
      const n = a[0]!;
      domain("factorial", Number.isInteger(n) && n >= 0, "requires a non-negative integer");
      domain("factorial", n <= MAX_FACTORIAL, `is limited to n <= ${MAX_FACTORIAL}`);
      let r = 1;
      for (let i = 2; i <= n; i++) r *= i;
      return r;
    },
  ],
]);

function modulo(a: number, b: number): number {
  if (b === 0) throw new CalcError("modulo by zero");
  return a % b;
}

function power(b: number, e: number): number {
  if (Math.abs(e) > MAX_EXPONENT) throw new CalcError(`exponent too large (magnitude must be at most ${MAX_EXPONENT})`);
  if (b === 0 && e < 0) throw new CalcError("division by zero (0 raised to a negative power)");
  const r = Math.pow(b, e);
  if (Number.isNaN(r)) throw new CalcError("no real result (negative base with a fractional exponent)");
  return r;
}

function normalize(src: string): string {
  return src
    .replace(/×/g, "*")
    .replace(/÷/g, "/")
    .replace(/[−–]/g, "-")
    .replace(/π/g, " pi ")
    .trim();
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;
  const push = (tok: Token) => {
    if (out.length >= MAX_TOKENS) throw new CalcError(`expression has too many tokens (limit ${MAX_TOKENS})`);
    out.push(tok);
  };
  while (i < n) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
    } else if ((c >= "0" && c <= "9") || (c === "." && src[i + 1]! >= "0" && src[i + 1]! <= "9")) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i, i + 64))!;
      const v = Number(m[0]);
      if (!Number.isFinite(v)) throw new CalcError(`number too large: ${excerpt(m[0])}`);
      i += m[0].length;
      if (i < n && /[A-Za-z_]/.test(src[i]!)) {
        throw new CalcError("implicit multiplication is not supported; write the * explicitly (e.g. 2 * pi)");
      }
      push({ t: "num", v });
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      push({ t: "id", v: src.slice(i, j).toLowerCase() });
      i = j;
    } else if (c === "*" && src[i + 1] === "*") {
      push({ t: "op", v: "^" });
      i += 2;
    } else if ("+-*/%^(),".includes(c)) {
      push({ t: "op", v: c });
      i++;
    } else {
      throw new CalcError(`unexpected character '${excerpt(c, 1)}'`);
    }
  }
  return out;
}

class Parser {
  private pos = 0;
  private depth = 0;
  constructor(private readonly toks: Token[]) {}

  parse(): Node {
    if (this.toks.length === 0) throw new CalcError("empty expression");
    const node = this.additive();
    const t = this.toks[this.pos];
    if (t) {
      if (t.t === "op" && t.v === ")") throw new CalcError("unexpected ')' (unbalanced parentheses)");
      throw new CalcError(`unexpected ${this.describe(t)}`);
    }
    return node;
  }

  private describe(t: Token | undefined): string {
    if (!t) return "end of expression";
    return t.t === "num" ? `number ${t.v}` : t.t === "id" ? `"${excerpt(t.v)}"` : `'${t.v}'`;
  }
  private peek(o = 0): Token | undefined {
    return this.toks[this.pos + o];
  }
  private isOp(v: string, o = 0): boolean {
    const t = this.peek(o);
    return !!t && t.t === "op" && t.v === v;
  }
  private enter(): void {
    if (++this.depth > MAX_DEPTH) throw new CalcError("expression is nested too deeply");
  }

  private additive(): Node {
    this.enter();
    let l = this.term();
    while (this.isOp("+") || this.isOp("-")) {
      const op = (this.toks[this.pos++] as { v: "+" | "-" }).v;
      const r = this.term();
      l = r.k === "pct" ? { k: "addpct", op, l, r } : { k: "bin", op, l, r };
    }
    this.depth--;
    return l;
  }

  private term(): Node {
    let l = this.unary();
    for (;;) {
      const t = this.peek();
      if (t && t.t === "op" && (t.v === "*" || t.v === "/" || t.v === "%")) {
        this.pos++;
        l = { k: "bin", op: t.v, l, r: this.unary() };
      } else return l;
    }
  }

  private unary(): Node {
    this.enter();
    try {
      if (this.isOp("-")) {
        this.pos++;
        return { k: "neg", e: this.unary() };
      }
      if (this.isOp("+")) {
        this.pos++;
        return this.unary();
      }
      return this.power();
    } finally {
      this.depth--;
    }
  }

  private power(): Node {
    const base = this.postfix();
    if (this.isOp("^")) {
      this.pos++;
      return { k: "bin", op: "^", l: base, r: this.unary() };
    }
    return base;
  }

  /** Is the token at offset o something that can begin an operand? (decides modulo vs postfix percent) */
  private startsOperand(o: number): boolean {
    const t = this.peek(o);
    if (!t) return false;
    if (t.t === "num") return true;
    if (t.t === "id") return t.v !== "of";
    return t.v === "(";
  }

  private postfix(): Node {
    let node = this.primary();
    if (this.isOp("%") && !this.startsOperand(1)) {
      this.pos++;
      node = { k: "pct", e: node };
      const t = this.peek();
      if (t && t.t === "id" && t.v === "of") {
        this.pos++;
        node = { k: "bin", op: "*", l: node, r: this.unary() };
      }
    }
    return node;
  }

  private primary(): Node {
    const t = this.peek();
    if (!t) throw new CalcError("unexpected end of expression");
    this.pos++;
    if (t.t === "num") return { k: "num", v: t.v };
    if (t.t === "op") {
      if (t.v === "(") {
        const inner = this.additive();
        if (!this.isOp(")")) throw new CalcError("missing closing parenthesis ')'");
        this.pos++;
        return inner;
      }
      throw new CalcError(`unexpected '${t.v}'`);
    }
    // identifier
    if (this.isOp("(")) {
      if (!FUNCTIONS.has(t.v)) {
        throw new CalcError(
          CONSTANTS.has(t.v) ? `"${t.v}" is a constant, not a function` : `unknown function "${excerpt(t.v)}"`,
        );
      }
      this.pos++;
      const args: Node[] = [];
      if (!this.isOp(")")) {
        for (;;) {
          args.push(this.additive());
          if (this.isOp(",")) this.pos++;
          else break;
        }
      }
      if (!this.isOp(")")) throw new CalcError("missing closing parenthesis ')'");
      this.pos++;
      return { k: "call", name: t.v, args };
    }
    if (CONSTANTS.has(t.v)) return { k: "num", v: CONSTANTS.get(t.v)! };
    if (FUNCTIONS.has(t.v)) throw new CalcError(`${t.v} is a function; call it with parentheses, e.g. ${t.v}(x)`);
    throw new CalcError(`unknown identifier "${excerpt(t.v)}"`);
  }
}

function finite(x: number): number {
  if (!Number.isFinite(x)) throw new CalcError("result is too large or undefined (not finite)");
  return x;
}

function evalNode(n: Node): number {
  switch (n.k) {
    case "num":
      return n.v;
    case "pct":
      return evalNode(n.e) / 100;
    case "neg":
      return -evalNode(n.e);
    case "addpct": {
      const l = evalNode(n.l);
      const p = evalNode(n.r.k === "pct" ? n.r.e : n.r) / 100;
      return finite(n.op === "+" ? l * (1 + p) : l * (1 - p));
    }
    case "bin": {
      const l = evalNode(n.l);
      const r = evalNode(n.r);
      switch (n.op) {
        case "+":
          return finite(l + r);
        case "-":
          return finite(l - r);
        case "*":
          return finite(l * r);
        case "/":
          if (r === 0) throw new CalcError("division by zero");
          return finite(l / r);
        case "%":
          return finite(modulo(l, r));
        default:
          return finite(power(l, r));
      }
    }
    case "call":
      return finite(FUNCTIONS.get(n.name)!(n.args.map(evalNode)));
  }
}

function evalString(src: string): number {
  if (src.length > MAX_INPUT_CHARS) throw new CalcError(`expression is too long (limit ${MAX_INPUT_CHARS} characters)`);
  return evalNode(new Parser(tokenize(normalize(src))).parse());
}

const WHAT_PCT_OF_IS = /^what\s+(?:percent|percentage|%)\s+of\s+(.+?)\s+is\s+(.+)$/i;
const IS_WHAT_PCT_OF = /^(.+?)\s+is\s+what\s+(?:percent|percentage|%)\s+of\s+(.+)$/i;
const PCT_CHANGE = /^(?:percent(?:age)?|%)\s+change\s+from\s+(.+?)\s+to\s+(.+)$/i;

/** Evaluate a math expression. Throws CalcError on any invalid / unsafe / non-finite input. */
export function evaluateMath(input: string): CalcOutput {
  if (input.length > MAX_INPUT_CHARS) throw new CalcError(`expression is too long (limit ${MAX_INPUT_CHARS} characters)`);
  const src = input.replace(/\s+/g, " ").trim().replace(/^(?:what is|what's|calculate|compute)\s+/i, "");
  if (!src) throw new CalcError("empty expression");

  let m = WHAT_PCT_OF_IS.exec(src);
  if (m) {
    const a = evalString(m[1]!);
    const b = evalString(m[2]!);
    if (a === 0) throw new CalcError("cannot take a percentage of zero");
    const pct = formatNumber((b / a) * 100);
    return { result: pct, text: `${m[2]} is ${pct}% of ${m[1]}` };
  }
  m = IS_WHAT_PCT_OF.exec(src);
  if (m) {
    const a = evalString(m[1]!);
    const b = evalString(m[2]!);
    if (b === 0) throw new CalcError("cannot take a percentage of zero");
    const pct = formatNumber((a / b) * 100);
    return { result: pct, text: `${m[1]} is ${pct}% of ${m[2]}` };
  }
  m = PCT_CHANGE.exec(src);
  if (m) {
    const a = evalString(m[1]!);
    const b = evalString(m[2]!);
    if (a === 0) throw new CalcError("percent change from zero is undefined");
    const pct = formatNumber(((b - a) / Math.abs(a)) * 100);
    return { result: pct, text: `change from ${m[1]} to ${m[2]} is ${pct}%` };
  }

  const result = formatNumber(evalString(src));
  return { result, text: `${src} = ${result}` };
}
