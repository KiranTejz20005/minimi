import { describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock.js";
import { buildContext, estimateTokens } from "../src/agent/context.js";
import type { MessageRow } from "../src/memory/store.js";

const clock = new FixedClock(new Date("2026-11-10T13:30:00.000Z"));
let n = 0;
const row = (role: "user" | "assistant", content: string): MessageRow => ({
  id: `m${n++}`,
  conversation_id: "c",
  role,
  content,
  created_at: new Date(1_700_000_000_000 + n * 1000).toISOString(),
});
const build = (history: MessageRow[], extra: Partial<Parameters<typeof buildContext>[0]> = {}) =>
  buildContext({ clock, tz: "UTC", history, userMessage: "now what?", ...extra });
const text = (m: { content: unknown }) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));

function pairs(count: number, size: number): MessageRow[] {
  const out: MessageRow[] = [];
  for (let i = 0; i < count; i++) {
    out.push(row("user", `q${i} ` + "u".repeat(size)));
    out.push(row("assistant", `a${i} ` + "a".repeat(size)));
  }
  return out;
}

describe("estimateTokens", () => {
  it("is ~3.5 chars per token, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a".repeat(7))).toBe(2);
    expect(estimateTokens("a".repeat(35))).toBe(10);
  });
});

describe("buildContext history budget", () => {
  it("keeps short histories whole (more than the old 12-message limit)", () => {
    const { messages } = build(pairs(10, 20));
    expect(messages.length).toBe(21);
  });

  it("drops oldest messages first when over budget, newest kept", () => {
    const { messages } = build(pairs(40, 400), { historyTokenBudget: 1500 });
    const all = messages.map(text).join("\n");
    expect(all).toContain("q39 ");
    expect(all).toContain("a39 ");
    expect(all).not.toContain("q0 ");
    expect(messages.length).toBeLessThan(40);
  });

  it("always keeps the latest exchange, truncating (with a marker) instead of dropping", () => {
    const hist = [row("user", "old"), row("assistant", "old"), row("user", "U".repeat(40_000)), row("assistant", "A".repeat(40_000))];
    const { messages } = build(hist, { historyTokenBudget: 1000 });
    const body = messages.slice(0, -1).map(text);
    expect(body.length).toBe(2);
    expect(body[0]).toContain("truncated");
    expect(body[1]).toContain("truncated");
    expect(body[0]!.length).toBeLessThan(10_000);
  });

  it("truncates a huge older message with an ellipsis marker rather than dropping it silently", () => {
    const hist = [row("user", "first"), row("assistant", "X".repeat(30_000)), row("user", "q2"), row("assistant", "a2")];
    const { messages } = build(hist, { historyTokenBudget: 3000 });
    const long = messages.map(text).find((t) => t.startsWith("XXXX"));
    expect(long).toBeDefined();
    expect(long).toContain("truncated");
    expect(long!.length).toBeLessThan(12_000);
  });

  it("starts with a user message and alternates roles, ending with the new user message", () => {
    const hist = [row("assistant", "orphan"), row("user", "a"), row("user", "b"), row("assistant", "c"), row("assistant", "d"), row("user", "dangling")];
    const { messages } = build(hist);
    expect(messages[0]!.role).toBe("user");
    for (let i = 1; i < messages.length; i++) expect(messages[i]!.role).not.toBe(messages[i - 1]!.role);
    expect(messages.at(-1)!.role).toBe("user");
    expect(text(messages.at(-1)!)).toContain("<user_message>now what?</user_message>");
    expect(messages.map(text).join("\n")).not.toContain("orphan");
  });

  it("budget cutting never leaves a leading assistant message", () => {
    const { messages } = build(pairs(30, 300), { historyTokenBudget: 700 });
    expect(messages[0]!.role).toBe("user");
  });

  it("works with empty history", () => {
    const { messages } = build([]);
    expect(messages).toHaveLength(1);
  });
});

describe("buildContext user message", () => {
  it("escapes the user message", () => {
    const { messages } = build([], { userMessage: "a <b> & c" });
    expect(text(messages[0]!)).toContain("a &lt;b&gt; &amp; c");
  });

  it("injects saved memory, recalled memory and previous tool results before the user message, in that order", () => {
    const { messages } = build([], {
      savedMemoryXml: "<saved_memory>S</saved_memory>",
      memoryXml: "<memory>M</memory>",
      previousToolResultsXml: "<previous_tool_results>P</previous_tool_results>",
    });
    const t = text(messages[0]!);
    const idx = ["<saved_memory>", "<memory>", "<previous_tool_results>", "<user_message>"].map((s) => t.indexOf(s));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it("omits blank blocks", () => {
    const { messages } = build([], { savedMemoryXml: "  ", previousToolResultsXml: "" });
    expect(text(messages[0]!).startsWith("<user_message>")).toBe(true);
  });

  it("caps a huge context message, keeping the head (manifest) and the tail (the real question)", () => {
    const big = "<attachments>" + "F".repeat(200_000) + "</attachments>\n\nWhat is the total?";
    const { messages } = build([], { userMessage: big });
    const t = text(messages[0]!);
    expect(t.length).toBeLessThan(60_000);
    expect(t).toContain("&lt;attachments&gt;");
    expect(t).toContain("What is the total?");
    expect(t).toContain("truncated");
  });
});
