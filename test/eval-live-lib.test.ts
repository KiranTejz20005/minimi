import { describe, expect, it } from "vitest";
import {
  check,
  citationsValid,
  claimsNoRecord,
  classifyAmbiguity,
  convertedAmount,
  countWords,
  endsCleanly,
  excerpt,
  extractNumbers,
  findToolMarkup,
  formatTable,
  grade,
  hasNumberNear,
  hasNumberWithin,
  hasToolMarkup,
  isPrivateTarget,
  mentionsDate,
  mentionsTemperature,
  numbersInRange,
  placeholderLeaks,
  redact,
  reportFileName,
  scanProviderBody,
  summarize,
  warn,
} from "../scripts/eval-live-lib.js";

describe("countWords", () => {
  it("counts words, not markdown symbols", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("Hello, world!")).toBe(2);
    expect(countWords("## TCP's slow-start\n\n- **cwnd** doubles  every RTT.")).toBe(6);
    expect(countWords("It costs 42.5 units")).toBe(5); // "42" and "5" are separate runs
  });
  it("handles non-Latin scripts", () => {
    expect(countWords("नमस्ते दुनिया")).toBe(2);
  });
});

describe("endsCleanly", () => {
  it("accepts finished sentences, including trailing emphasis, quotes and citations", () => {
    expect(endsCleanly("It works.")).toBe(true);
    expect(endsCleanly("Really?  \n")).toBe(true);
    expect(endsCleanly("That is **the key point.**")).toBe(true);
    expect(endsCleanly('He said "done."')).toBe(true);
    expect(endsCleanly("Congestion avoidance follows. [3]")).toBe(true);
    expect(endsCleanly("(see RFC 5681.)")).toBe(true);
    expect(endsCleanly("```js\nx()\n```")).toBe(true);
  });
  it("rejects cut-off text", () => {
    expect(endsCleanly("")).toBe(false);
    expect(endsCleanly("The window then grows linearly until")).toBe(false);
    expect(endsCleanly("Key phases:")).toBe(false);
    expect(endsCleanly("- slow start\n- conge")).toBe(false);
  });
});

describe("findToolMarkup / hasToolMarkup", () => {
  it("detects tool calls written as text", () => {
    expect(hasToolMarkup("<calculate><expression>2+2</expression></calculate>")).toBe(true);
    expect(hasToolMarkup('Let me check. <read_attachment file="a.pdf" action="read">')).toBe(true);
    expect(hasToolMarkup("<function=calculate><parameter=expression>2+2</parameter></function>")).toBe(true);
    expect(hasToolMarkup('<tool_call>{"name": "calculate", "arguments": {"expression": "1+1"}}</tool_call>')).toBe(true);
    expect(hasToolMarkup('{"name": "get_weather", "arguments": {"location": "Pune"}}')).toBe(true);
    expect(hasToolMarkup("[TOOL_CALLS] something")).toBe(true);
    expect(hasToolMarkup("<invoke name=\"x\">")).toBe(true);
  });
  it("uses the live tool list it is given", () => {
    expect(hasToolMarkup("<get_latest_news>funding</get_latest_news>", ["get_latest_news"])).toBe(true);
    expect(hasToolMarkup("<get_latest_news>funding</get_latest_news>", ["calculate"])).toBe(false);
  });
  it("ignores ordinary text, comparisons and HTML-ish words that are not tool names", () => {
    expect(hasToolMarkup("15% of 240 is 36. If a < b and b > c, then calculate it by hand.")).toBe(false);
    expect(hasToolMarkup("Use <br> or <b>bold</b>; the calculated value is 4.")).toBe(false);
    expect(hasToolMarkup("The function returns a map (calculate_total is a helper).")).toBe(false);
    expect(hasToolMarkup('{"name": "Ada", "age": 36}')).toBe(false);
  });
  it("returns the snippets", () => {
    expect(findToolMarkup("ok <calculate> x </calculate>")).toEqual(["<calculate>", "</calculate>"]);
  });
});

describe("placeholderLeaks", () => {
  it("finds [object X] and bare undefined/NaN", () => {
    expect(placeholderLeaks("Total: [object Object]")).toEqual(["[object Object]"]);
    expect(placeholderLeaks("It is undefined°C in undefined")).toEqual(["undefined", "undefined"]);
    expect(placeholderLeaks("Value NaN")).toEqual(["NaN"]);
  });
  it("ignores code spans and, with allowWords, prose words", () => {
    expect(placeholderLeaks("`map.get(k)` returns `undefined` when missing")).toEqual([]);
    expect(placeholderLeaks("Lookup of a missing key is undefined behaviour in C", { allowWords: true })).toEqual([]);
    expect(placeholderLeaks("[object Object]", { allowWords: true })).toEqual(["[object Object]"]);
  });
});

describe("extractNumbers and tolerance checks", () => {
  it("parses grouping, decimals and signs", () => {
    expect(extractNumbers("15% of 240 is 36.")).toEqual([15, 240, 36]);
    expect(extractNumbers("₹21,370.25 and 1,23,456.78 and 1,000,000")).toEqual([21370.25, 123456.78, 1000000]);
    expect(extractNumbers("It is -3°C (feels -5.5)")).toEqual([-3, -5.5]);
    expect(extractNumbers("26.2 miles = 42.1648 km")).toEqual([26.2, 42.1648]);
  });
  it("never reads date separators as minus signs", () => {
    expect(extractNumbers("on 2027-02-22")).toEqual([2027, 2, 22]);
  });
  it("matches within absolute and relative tolerance", () => {
    expect(hasNumberNear("about 42.16 km", 42.16, 0.07)).toBe(true);
    expect(hasNumberNear("about 42.1 km", 42.16, 0.07)).toBe(true);
    expect(hasNumberNear("about 42.2 km", 42.16, 0.07)).toBe(true);
    expect(hasNumberNear("about 41.9 km", 42.16, 0.07)).toBe(false);
    expect(hasNumberNear("The answer is 36", 36)).toBe(true);
    expect(hasNumberNear("The answer is 360", 36)).toBe(false);
    expect(hasNumberWithin("≈ ₹21,000", 21_370.25, 0.02)).toBe(true);
    expect(hasNumberWithin("≈ ₹20,000", 21_370.25, 0.02)).toBe(false);
    expect(numbersInRange("250 USD is about 21,370 INR", 15_000, 30_000)).toEqual([21370]);
  });
  it("reads the converted amount from a convert_currency result", () => {
    const c = `<currency_conversion from="USD" amount="250">\n250 USD = 21,370.25 INR (1 USD = 85.481 INR)\n</currency_conversion>`;
    expect(convertedAmount(c, "INR")).toBe(21370.25);
    expect(convertedAmount(c, "inr")).toBe(21370.25);
    expect(convertedAmount(c, "EUR")).toBeNull();
  });
});

describe("mentionsDate", () => {
  it("accepts ISO and common English formats", () => {
    for (const s of [
      "It is 2027-02-22.",
      "That is 22 February 2027",
      "February 22, 2027",
      "Feb 22nd 2027",
      "**22 Feb, 2027**",
      "22/02/2027",
      "02/22/2027",
      "22.02.2027",
      "Monday, 22nd of February 2027",
    ]) {
      expect(mentionsDate(s, "2027-02-22"), s).toBe(true);
    }
  });
  it("rejects other dates", () => {
    expect(mentionsDate("February 21, 2027", "2027-02-22")).toBe(false);
    expect(mentionsDate("22 March 2027", "2027-02-22")).toBe(false);
    expect(mentionsDate("2026-02-22", "2027-02-22")).toBe(false);
    expect(() => mentionsDate("x", "22/02/2027")).toThrow();
  });
});

describe("mentionsTemperature", () => {
  it("finds readings in several notations", () => {
    for (const s of ["28°C", "28 °C", "28℃", "82°F", "about 28 degrees", "-3.5 C", "27.3° now"]) expect(mentionsTemperature(s), s).toBe(true);
  });
  it("ignores other numbers", () => {
    expect(mentionsTemperature("humidity 70% and wind 12 km/h")).toBe(false);
  });
});

describe("claimsNoRecord", () => {
  it("detects 'nothing on record' answers", () => {
    for (const s of [
      "I don't have any information about your favourite colour.",
      "I do not have a record of that.".replace("a record", "any record"),
      "I can't recall any details about that.",
      "You haven't told me your favourite colour yet.",
      "I don't know your favourite colour.",
      "There is no record of that in our chats.".replace("There is no record of", "no record of"),
    ]) {
      expect(claimsNoRecord(s), s).toBe(true);
    }
  });
  it("accepts real recall answers", () => {
    expect(claimsNoRecord("You told me your favourite colours are blue and green.")).toBe(false);
    expect(claimsNoRecord("Blue (and green), from our earlier chat.")).toBe(false);
  });
});

describe("citations and private targets", () => {
  it("validates [n] against the source count", () => {
    expect(citationsValid("no cites", 0)).toBe(true);
    expect(citationsValid("a [1] b [2]", 2)).toBe(true);
    expect(citationsValid("a [3]", 2)).toBe(false);
    expect(citationsValid("a [0]", 2)).toBe(false);
  });
  it("flags metadata, loopback, private and single-label hosts", () => {
    for (const u of ["http://169.254.169.254", "169.254.169.254/latest/meta-data", "http://localhost:3000", "http://127.0.0.1", "http://10.0.0.5", "http://192.168.1.1", "http://172.20.0.1", "http://[::1]/", "http://intranet/", "http://metadata.google.internal/"]) {
      expect(isPrivateTarget(u), u).toBe(true);
    }
    for (const u of ["https://example.com", "https://8.8.8.8", "http://172.32.0.1", "news.ycombinator.com"]) expect(isPrivateTarget(u), u).toBe(false);
  });
});

describe("redact / excerpt", () => {
  // Built at runtime so no key-shaped literal sits in the source.
  const fakeNv = "nvapi-" + "Ab3".repeat(8);
  const fakeSk = "sk-ant-" + "x9Y".repeat(8);
  it("removes exact secrets and key-shaped tokens", () => {
    const secret = "my-own-secret-value-123";
    const out = redact(`key ${secret} and ${fakeNv} and ${fakeSk} and Authorization: Bearer abcdefgh12345678`, [secret, undefined, null, ""]);
    expect(out).not.toContain(secret);
    expect(out).not.toContain(fakeNv);
    expect(out).not.toContain(fakeSk);
    expect(out).not.toContain("abcdefgh12345678");
    expect(out).toContain("[REDACTED]");
  });
  it("redacts key=value pairs but keeps the key name", () => {
    expect(redact('{"api_key": "abc123def456"}')).toBe('{"api_key": "[REDACTED]"}');
    expect(redact("password=hunter2xyz")).toBe("password=[REDACTED]");
  });
  it("leaves normal prose alone", () => {
    const s = "TCP congestion control uses slow start, AIMD and fast retransmit (RFC 5681).";
    expect(redact(s)).toBe(s);
  });
  it("excerpts are redacted, collapsed and capped", () => {
    const e = excerpt(`line one\n\n  line two ${fakeNv} ` + "x ".repeat(400), 50);
    expect(e.length).toBeLessThanOrEqual(50);
    expect(e.startsWith("line one line two [REDACTED]")).toBe(true);
    expect(e.endsWith("…")).toBe(true);
    expect(excerpt("short", 300)).toBe("short");
  });
});

describe("scanProviderBody", () => {
  it("reads OpenAI-compatible SSE finish reasons and usage", () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":1500}}',
      "data: [DONE]",
      "",
    ].join("\n");
    expect(scanProviderBody(body)).toEqual({ finishReasons: ["length"], usage: { inputTokens: 120, outputTokens: 1500 } });
  });
  it("reads Anthropic SSE stop_reason and usage", () => {
    const body = [
      "event: message_start",
      'data: {"type":"message_start","message":{"usage":{"input_tokens":900,"output_tokens":1}}}',
      "event: message_delta",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":321}}',
    ].join("\n");
    expect(scanProviderBody(body)).toEqual({ finishReasons: ["end_turn"], usage: { inputTokens: 900, outputTokens: 321 } });
  });
  it("reads a plain JSON response and tolerates junk", () => {
    expect(scanProviderBody('{"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":7}}')).toEqual({
      finishReasons: ["stop"],
      usage: { inputTokens: 5, outputTokens: 7 },
    });
    expect(scanProviderBody("data: {broken\nnot sse")).toEqual({ finishReasons: [], usage: null });
  });
});

describe("grade / summarize / classifyAmbiguity", () => {
  it("fails on any failed fail-severity assertion, never on warnings", () => {
    expect(grade([check("a", true), warn("w", false, "meh")])).toEqual({ status: "PASS", reasons: [], warnings: ["w: meh"] });
    expect(grade([check("a", true), check("b", false, "why")]).status).toBe("FAIL");
    expect(grade([check("b", false, "why")]).reasons).toEqual(["b: why"]);
    expect(grade([]).status).toBe("FAIL");
    expect(grade([warn("only a warning", true)]).status).toBe("FAIL");
  });
  it("summarizes pass rate overall and per category (SKIPs excluded from the rate)", () => {
    const s = summarize([
      { id: "a", category: "tools", status: "PASS", ms: 100 },
      { id: "b", category: "tools", status: "FAIL", ms: 200 },
      { id: "c", category: "files", status: "PASS", ms: 50 },
      { id: "d", category: "news", status: "SKIP", ms: 0 },
    ]);
    expect(s).toMatchObject({ total: 4, pass: 2, fail: 1, skip: 1, passRate: 0.667, totalMs: 350 });
    expect(s.byCategory.tools).toEqual({ pass: 1, fail: 1, skip: 0, passRate: 0.5 });
    expect(s.byCategory.news!.passRate).toBeNull();
  });
  it("classifies what the agent did with an ambiguous file question", () => {
    const base = { fileNames: ["alpha.txt", "beta.txt"] };
    expect(classifyAmbiguity({ ...base, answer: "Which file do you mean, alpha.txt or beta.txt?", readFiles: [], coverage: [false, false] })).toBe("asked-which-file");
    expect(classifyAmbiguity({ ...base, answer: "alpha is on track; beta is delayed.", readFiles: ["alpha.txt", "beta.txt"], coverage: [true, true] })).toBe("read-both");
    expect(classifyAmbiguity({ ...base, answer: "alpha is on track; beta is delayed.", readFiles: ["*"], coverage: [true, true] })).toBe("read-both");
    expect(classifyAmbiguity({ ...base, answer: "alpha is on track; beta is delayed.", readFiles: [], coverage: [true, true] })).toBe("covered-both");
    expect(classifyAmbiguity({ ...base, answer: "It says the project is on track.", readFiles: [], coverage: [true, false] })).toBe("covered-one");
    expect(classifyAmbiguity({ ...base, answer: "Sorry.", readFiles: [], coverage: [false, false] })).toBe("other");
  });
});

describe("formatTable / reportFileName", () => {
  it("aligns columns and cuts long cells", () => {
    const t = formatTable(["a", "bb"], [["1", "x".repeat(10)], ["22", "y"]], 5);
    expect(t.split("\n")).toEqual(["a   bb", "--  -----", "1   xxxx…", "22  y"]);
  });
  it("builds a Windows-safe report name", () => {
    expect(reportFileName("2026-11-25T10:30:05.123Z", "poolside/laguna-xs-2.1")).toBe("2026-11-25T10-30-05Z-poolside_laguna-xs-2.1.json");
    expect(reportFileName("2026-11-25T10:30:05Z", "claude-sonnet-5-5")).toBe("2026-11-25T10-30-05Z-claude-sonnet-5-5.json");
  });
});
