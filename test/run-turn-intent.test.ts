import { describe, expect, it } from "vitest";
import {
  isCalculation,
  isDateTimeQuestion,
  isGreeting,
  isMemoryRequest,
  isSaveOrForget,
  needsFreshData,
  referencesAttachment,
  searchQueryFrom,
} from "../src/agent/run-turn.js";

/** [message, expected forced search] */
const CASES: [string, boolean][] = [
  // time-sensitive factual cues: force
  ["What is the latest iPhone?", true],
  ["when does GTA 6 release", true],
  ["Who won the match last night? score today", true],
  ["current price of bitcoin", true],
  ["weather in Mumbai tomorrow", false], // get_weather tool, not a forced web search
  ["nvidia stock price", true],
  ["Who is the CEO of OpenAI?", true],
  ["Any news about the Mars mission this week?", true],
  ["what's the exchange rate usd to inr", false], // convert_currency tool
  ["convert 100 USD to INR", false], // convert_currency tool
  ["upcoming movies in 2027", true],
  ["is the new Claude model out yet? latest version", true],
  ["aaj ka mausam kaisa hai today", true],
  ["今天的新闻", true],
  ["noticias de hoy", true],
  ["météo aujourd'hui à Paris", true],
  // arithmetic / units / dates: calculate tool or system clock, no web
  ["what is 15% of 240", false],
  ["2+2", false],
  ["12 * (3 + 4) / 7", false],
  ["calculate 18 * 24 please", false],
  ["how much is 5 plus 7 times 3", false],
  ["convert 5 km to miles", false],
  ["10 kg in pounds", false],
  ["what is 72 fahrenheit in celsius", false],
  ["square root of 144", false],
  ["calcula 15% de 200", false],
  ["what is the date today", false],
  ["what day is it", false],
  ["what time is it in Tokyo", false],
  ["how many days until Christmas", false],
  ["time zone difference between IST and PST", false],
  // attachments
  ["summarize this file", false],
  ["what does the attached pdf say about pricing", false],
  ["what's in my uploaded spreadsheet", false],
  ["explain the chart in report.pdf", false],
  // memory / recall / save / forget
  ["what did we talk about earlier", false],
  ["do you remember my favorite color", false],
  ["what's my name", false],
  ["remember that I prefer dark mode", false],
  ["please forget my address", false],
  ["from now on answer in Spanish", false],
  ["save this to memory", false],
  // writing / coding / explanation tasks
  ["write a poem about the latest trends today", false],
  ["translate 'good morning' to French", false],
  ["fix this bug: TypeError undefined is not a function", false],
  ["explain how recursion works", false],
  ["refactor my function to use async await", false],
  ["draft an email saying I will arrive today", false],
  ["summarize the following text: lorem ipsum", false],
  // greetings and tiny / non-English chatter
  ["hi", false],
  ["hello!", false],
  ["thanks", false],
  ["ok", false],
  ["hola", false],
  ["namaste", false],
  ["你好", false],
  ["danke schön", false],
  ["", false],
  // plain knowledge questions: model decides itself
  ["why is the sky blue", false],
  ["what is a monad", false],
];

describe("needsFreshData", () => {
  it("has a broad table", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40);
  });

  for (const [msg, want] of CASES) {
    it(`${want ? "forces" : "does not force"} a search: ${JSON.stringify(msg)}`, () => {
      expect(needsFreshData(msg, false, false)).toBe(want);
    });
  }

  it("never forces when files are attached or memory already answered", () => {
    expect(needsFreshData("latest news today", true, false)).toBe(false);
    expect(needsFreshData("latest news today", false, true)).toBe(false);
  });

  it("does not force for pasted long content even with fresh cues in it", () => {
    expect(needsFreshData("Here is my essay about today's news. " + "word ".repeat(300), false, false)).toBe(false);
    expect(needsFreshData("```js\nconst latest = 1;\n```\nwhy is this wrong?", false, false)).toBe(false);
  });
});

describe("intent detectors", () => {
  it("isGreeting", () => {
    for (const m of ["hi", "Hello!", "hey there", "thanks a lot", "good morning", "bye", "hola", "你好"]) expect(isGreeting(m), m).toBe(true);
    for (const m of ["hi, what is the latest iphone", "hello world program in c"]) expect(isGreeting(m), m).toBe(false);
  });
  it("isCalculation", () => {
    for (const m of ["2+2", "15% of 80", "convert 3 miles to km", "what is 9 squared"]) expect(isCalculation(m), m).toBe(true);
    for (const m of ["convert 100 usd to eur", "iphone 15 price", "latest on gpt 5", "I have 3 cats"]) expect(isCalculation(m), m).toBe(false);
  });
  it("isDateTimeQuestion", () => {
    for (const m of ["what's the date today", "what time is it", "days until new year", "time zone for Delhi"]) expect(isDateTimeQuestion(m), m).toBe(true);
    for (const m of ["what is the score today", "release date of dune 3"]) expect(isDateTimeQuestion(m), m).toBe(false);
  });
  it("referencesAttachment", () => {
    for (const m of ["this file", "the pdf", "attached document", "see notes.docx", "my uploaded image"]) expect(referencesAttachment(m), m).toBe(true);
    for (const m of ["what is a pdf", "latest news"]) expect(referencesAttachment(m), m).toBe(false);
  });
  it("isMemoryRequest / isSaveOrForget", () => {
    expect(isMemoryRequest("what did I ask you yesterday")).toBe(true);
    expect(isMemoryRequest("what's the weather")).toBe(false);
    expect(isSaveOrForget("remember that my sister is Ana")).toBe(true);
    expect(isSaveOrForget("forget that")).toBe(true);
    expect(isSaveOrForget("do not forget the milk is a good title")).toBe(false);
  });
});

describe("searchQueryFrom", () => {
  it("cleans punctuation and caps length", () => {
    expect(searchQueryFrom("latest iphone??!!")).toBe("latest iphone");
    expect(searchQueryFrom("a b c d e f g h i j k l m n o p q").split(" ")).toHaveLength(14);
  });
});
