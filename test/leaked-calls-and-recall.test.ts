import { answer, freshDb, messageText, rows, scriptedLlm, tools, turn, use } from "./helpers/integration.js";
import { describe, expect, it } from "vitest";
import { looksLikeToolMarkup, parseTextToolCalls, stripToolMarkup } from "../src/agent/text-tool-calls.js";
import { tokenize } from "../src/memory/bm25.js";
import { listTools } from "../src/tools/registry.js";

const shapes = () => listTools().map((t) => t.schema);
const names = () => listTools().map((t) => t.name);

describe("tool calls written as text are recovered (the garbled 'read_attachmentfilefil_e_…actionreadpage3' answer)", () => {
  it("parses <tool>…<arg>v</arg>… with schema-typed arguments", () => {
    const { calls, rest } = parseTextToolCalls(
      "Reading on.\n<read_attachment><file>fil_e_2a7a</file><action>read</action><page>3</page></read_attachment>",
      shapes(),
    );
    expect(rest).toBe("Reading on.");
    expect(calls).toEqual([{ name: "read_attachment", input: { file: "fil_e_2a7a", action: "read", page: 3 } }]);
  });

  it("parses the JSON <tool_call> and <function=…><parameter=…> styles", () => {
    expect(parseTextToolCalls('<tool_call>{"name":"calculate","arguments":{"expression":"2+2"}}</tool_call>', shapes()).calls).toEqual([
      { name: "calculate", input: { expression: "2+2" } },
    ]);
    expect(parseTextToolCalls("<function=calculate><parameter=expression>3*3</parameter></function>", shapes()).calls).toEqual([
      { name: "calculate", input: { expression: "3*3" } },
    ]);
  });

  it("ignores unknown tools and leaves ordinary text and tags alone", () => {
    expect(parseTextToolCalls("<rm_rf><path>/</path></rm_rf>", shapes()).calls).toEqual([]);
    expect(stripToolMarkup("a < b and <b>bold</b>", shapes())).toBe("a < b and <b>bold</b>");
    expect(looksLikeToolMarkup("just words", names())).toBe(false);
  });

  it("stays fast on hostile input", () => {
    const t0 = Date.now();
    parseTextToolCalls("<calculate>".repeat(5000) + "<a".repeat(5000), shapes());
    parseTextToolCalls("<function=".repeat(5000), shapes());
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("the loop runs a leaked call as a real tool call and never shows the markup", async () => {
    const db = freshDb();
    const s = scriptedLlm([answer("<calculate><expression>15% of 240</expression></calculate>"), answer("15% of 240 is 36.")]);
    const tokens: string[] = [];
    const res = await turn(db, s.llm, "what is 15% of 240", {}, { onToken: (t) => tokens.push(t) });
    expect(res.answer).toBe("15% of 240 is 36.");
    expect(tokens.join("")).not.toContain("<calculate>");
    expect(rows<{ name: string }>(db, "SELECT name FROM tool_results WHERE turn_id = ?", res.turnId).map((r) => r.name)).toEqual(["calculate"]);
    expect(s.requests).toHaveLength(2);
  });

  it("prose followed by a leaked call on a later step: the prose streams, the markup does not", async () => {
    const db = freshDb();
    const s = scriptedLlm([
      tools([use("a", "calculate", { expression: "1+1" })]),
      answer("Let me check once more.<calculate><expression>2+2</expression></calculate>"),
      answer("The result is 4."),
    ]);
    const tokens: string[] = [];
    const res = await turn(db, s.llm, "add some numbers", {}, { onToken: (t) => tokens.push(t) });
    const shown = tokens.join("");
    expect(shown).toContain("Let me check once more.");
    expect(shown).not.toContain("<calculate>");
    expect(res.answer).toBe("The result is 4.");
  });
});

describe("personal questions are answered from what the user said in earlier chats", () => {
  it("search folds spelling and plurals: favourite colour == favorite colors", () => {
    expect(tokenize("what is my favourite colour?")).toEqual(tokenize("my favorite colors"));
  });

  it("'what is my favourite color?' in a NEW chat finds 'my favorite colors are blue and green'", async () => {
    const db = freshDb();
    await turn(db, scriptedLlm([answer("Noted, I'll keep that in mind.")]).llm, "my favorite colors are blue and green");
    const s = scriptedLlm([answer("Blue and green.")]);
    await turn(db, s.llm, "what is my favourite color?");
    const prompt = messageText(s.requests[0]!.messages.at(-1)!);
    expect(prompt).toContain("<memory_results");
    expect(prompt.toLowerCase()).toContain("blue and green");
  });

  it("does not match its own question or earlier 'no record' replies", async () => {
    const db = freshDb();
    await turn(db, scriptedLlm([answer("I don't have any record of your favourite color.")]).llm, "what is my favourite color?");
    const s = scriptedLlm([answer("I don't know yet.")]);
    await turn(db, s.llm, "what is my favourite color?");
    expect(messageText(s.requests[0]!.messages.at(-1)!)).not.toContain("<memory_results");
  });
});
