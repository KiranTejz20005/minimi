/**
 * Recovery for models that write a tool call as plain text instead of using the function-calling interface.
 *
 * Small open models (e.g. via NVIDIA NIM) do this after a few successful native calls:
 *   <read_attachment><file>fil_x</file><action>read</action><page>3</page></read_attachment>
 *   <tool_call>{"name": "calculate", "arguments": {"expression": "2+2"}}</tool_call>
 *   <function=calculate><parameter=expression>2+2</parameter></function>
 * Left alone, that text becomes the "answer" (and renders as run-together words once the tags are stripped).
 * Here we turn it back into real calls, or strip it so it is never shown.
 *
 * Only registered tool names are accepted, every argument still goes through the tool's own validate(), and the
 * parser is linear (indexOf only, input capped), so hostile model output cannot hang it.
 */

export type ToolShape = { name: string; input_schema?: unknown };
export type TextToolCall = { name: string; input: Record<string, unknown> };

const MAX_SCAN = 20_000;

function propTypes(shape: ToolShape | undefined): Record<string, string> {
  const props = (shape?.input_schema as { properties?: Record<string, { type?: unknown }> } | undefined)?.properties ?? {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) if (typeof v?.type === "string") out[k] = v.type;
  return out;
}

function coerce(value: string, type: string | undefined): unknown {
  const v = value.trim();
  if (type === "number" || type === "integer") {
    const n = Number(v);
    return v !== "" && Number.isFinite(n) ? n : v;
  }
  if (type === "boolean") return v === "true" ? true : v === "false" ? false : v;
  if (type === "array" || type === "object") {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

/** Index just past the first `</name>` at or after `from` (case-insensitive), or -1. */
function closeEnd(lower: string, from: number, name: string): number {
  const tag = `</${name.toLowerCase()}>`;
  const i = lower.indexOf(tag, from);
  return i < 0 ? -1 : i + tag.length;
}

/** `<a>1</a><b>2</b>` -> [["a","1"],["b","2"]]. Also `<parameter=a>1</parameter>`. */
function childPairs(body: string): [string, string][] {
  const out: [string, string][] = [];
  const lower = body.toLowerCase();
  let i = 0;
  while (i < body.length && out.length < 32) {
    const lt = body.indexOf("<", i);
    if (lt < 0) break;
    const gt = body.indexOf(">", lt + 1);
    if (gt < 0) break;
    let name = body.slice(lt + 1, gt).trim();
    if (name.startsWith("/") || name === "") {
      i = gt + 1;
      continue;
    }
    if (name.startsWith("parameter=")) name = name.slice("parameter=".length).replace(/^["']|["']$/g, "");
    let valueEnd = -1;
    let closeLen = 0;
    for (const ct of [`</${name}>`, "</parameter>"]) {
      const at = lower.indexOf(ct.toLowerCase(), gt + 1);
      if (at >= 0 && (valueEnd < 0 || at < valueEnd)) {
        valueEnd = at;
        closeLen = ct.length;
      }
    }
    if (valueEnd < 0) {
      i = gt + 1;
      continue;
    }
    out.push([name, body.slice(gt + 1, valueEnd)]);
    i = valueEnd + closeLen;
  }
  return out;
}

function fromJson(raw: string, names: Set<string>): TextToolCall | null {
  try {
    const j = JSON.parse(raw.trim()) as { name?: unknown; arguments?: unknown; parameters?: unknown; input?: unknown };
    const name = typeof j.name === "string" ? j.name : "";
    const args = j.arguments ?? j.parameters ?? j.input ?? {};
    if (!names.has(name) || typeof args !== "object" || args === null || Array.isArray(args)) return null;
    return { name, input: args as Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * Does this text contain something that looks like a tool call (even a broken one)?
 * Used to decide whether held-back streamed text is prose or markup.
 */
export function looksLikeToolMarkup(text: string, toolNames: string[]): boolean {
  const t = text.slice(0, MAX_SCAN).toLowerCase();
  if (/<(tool_call|function_call|toolcall|tool_use|function=|invoke\b)/.test(t)) return true;
  for (const n of toolNames) {
    const l = n.toLowerCase();
    if (t.includes(`<${l}>`) || t.includes(`<${l} `)) return true;
  }
  return false;
}

/** Could the text so far still turn out to be markup? (it starts with "<": decide once the stream is done) */
export function mightBeMarkup(textSoFar: string): boolean {
  return textSoFar.trimStart().startsWith("<");
}

function build(name: string, pairs: [string, string][], shape: ToolShape | undefined): TextToolCall {
  const types = propTypes(shape);
  const input: Record<string, unknown> = {};
  for (const [k, v] of pairs) input[k] = coerce(v, types[k]);
  return { name, input };
}

export function parseTextToolCalls(text: string, tools: ToolShape[]): { calls: TextToolCall[]; rest: string } {
  const src = text.slice(0, MAX_SCAN);
  const lower = src.toLowerCase();
  const byName = new Map(tools.map((t) => [t.name, t]));
  const names = new Set(byName.keys());
  const calls: TextToolCall[] = [];
  let rest = "";
  let i = 0;

  while (i < src.length && calls.length < 8) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      rest += src.slice(i);
      break;
    }
    rest += src.slice(i, lt);
    const gt = src.indexOf(">", lt + 1);
    if (gt < 0) break; // dangling "<..." with no end: drop it
    const head = src.slice(lt + 1, gt).trim();
    const headName = head.split(/[\s=]/)[0]!.toLowerCase();

    // <tool_call>{json}</tool_call>  or  <tool_call><function=x>...</function></tool_call>
    if (headName === "tool_call" || headName === "function_call" || headName === "toolcall" || headName === "tool_use") {
      const end = closeEnd(lower, gt + 1, headName);
      const inner = src.slice(gt + 1, end < 0 ? src.length : end - `</${headName}>`.length);
      const asJson = fromJson(inner, names);
      if (asJson) calls.push(asJson);
      else calls.push(...parseTextToolCalls(inner, tools).calls);
      i = end < 0 ? src.length : end;
      continue;
    }

    // <function=name><parameter=a>v</parameter></function>
    if (head.startsWith("function=")) {
      const name = head.slice("function=".length).replace(/^["']|["']$/g, "");
      const end = closeEnd(lower, gt + 1, "function");
      const body = src.slice(gt + 1, end < 0 ? src.length : end - "</function>".length);
      if (names.has(name)) calls.push(build(name, childPairs(body), byName.get(name)));
      i = end < 0 ? src.length : end;
      continue;
    }

    // <registered_tool> <arg>v</arg> ... </registered_tool>
    const exact = [...names].find((n) => n.toLowerCase() === headName);
    if (exact) {
      const end = closeEnd(lower, gt + 1, exact);
      const body = src.slice(gt + 1, end < 0 ? src.length : end - `</${exact}>`.length);
      calls.push(build(exact, childPairs(body), byName.get(exact)));
      i = end < 0 ? src.length : end;
      continue;
    }

    rest += src.slice(lt, gt + 1); // an ordinary tag / less-than: leave it in the text
    i = gt + 1;
  }
  return { calls, rest: rest.trim() };
}

/** Remove tool-call markup so it is never shown to the user (used when no tools can be run). */
export function stripToolMarkup(text: string, tools: ToolShape[]): string {
  return parseTextToolCalls(text, tools).rest;
}
