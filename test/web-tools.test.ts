import { describe, expect, it } from "vitest";
import {
  TOOL_META,
  approvalLineText,
  approvalLines,
  describeTool,
  humanizeTool,
  readableError,
  runningStatus,
  statusNote,
  statusPhrase,
  toolMeta,
} from "../web/chat/tools.js";
import { MAX_BINARY_BYTES, MAX_TEXT_BYTES, bytesToBase64, classifyFile, fileKindLabel, isExtractedBinary, validateFile } from "../web/chat/attach.js";

describe("tool metadata", () => {
  it("covers all known tools", () => {
    for (const t of ["web_search", "fetch_url", "memory_search", "lookup_claims", "calculate", "read_attachment", "save_memory"]) {
      expect(TOOL_META[t]).toBeTruthy();
      expect(toolMeta(t).title).toBeTruthy();
    }
    expect(toolMeta("save_memory").persistent).toBe(true);
  });

  it("humanises unknown tool names without throwing", () => {
    expect(humanizeTool("some_tool")).toBe("Some tool");
    expect(toolMeta("some_tool").title).toBe("Some tool");
    expect(toolMeta("some_tool").icon).toBe("generic");
    expect(toolMeta("some-other.toolName").title).toBe("Some other tool name");
    expect(toolMeta("").title).toBe("Web search");
    expect(toolMeta(undefined).title).toBe("Web search");
    expect(toolMeta("constructor").icon).toBe("generic"); // not inherited from Object.prototype
    expect(statusPhrase("zzz_tool", "running")).toBe("Running zzz tool");
  });

  it("quotes the exact memory text and leaves other labels alone", () => {
    expect(describeTool("save_memory", "I prefer metric units")).toBe('"I prefer metric units"');
    expect(describeTool("save_memory", '"already quoted"')).toBe('"already quoted"');
    expect(describeTool("calculate", " 12 *  (3+4) ")).toBe("12 * (3+4)");
  });

  it("phrases statuses, including stopped, declined and duplicate", () => {
    expect(statusPhrase("fetch_url", "running")).toBe("Fetching");
    expect(statusPhrase("fetch_url", "stopped")).toBe("Stopped");
    expect(statusPhrase("calculate", "error")).toBe("Calculation failed");
    expect(statusNote("save_memory", "declined")).toMatch(/nothing was saved/);
    expect(statusNote("fetch_url", "done", undefined, true)).toMatch(/Reused an earlier result/);
    expect(statusNote("fetch_url", "done")).toBe("");
    expect(statusNote("fetch_url", "stopped")).toMatch(/ended before/);
  });

  it("makes errors readable", () => {
    expect(readableError("")).toBe("The tool returned an error.");
    expect(readableError("  HTTP 404   not found ")).toBe("HTTP 404 not found.");
    expect(readableError("x".repeat(500)).length).toBeLessThanOrEqual(402);
  });

  it("derives the running status line", () => {
    expect(runningStatus([{ status: "done" }])).toBeNull();
    expect(runningStatus([{ tool: "web_search", status: "running" }])).toBe("Searching the web…");
    expect(runningStatus([{ tool: "fetch_url", status: "running" }])).toBe("Fetching…");
    expect(runningStatus([{ tool: "calculate", status: "running" }, { tool: "fetch_url", status: "running" }])).toBe("Calculating and more…");
  });
});

describe("approval lines", () => {
  it("uses the server verb and exact label", () => {
    const l = approvalLines(["x"], [{ tool: "fetch_url", label: "https://example.com/a", verb: "Fetch page" }]);
    expect(approvalLineText(l[0]!)).toBe("Fetch page: https://example.com/a");
  });
  it("marks save_memory as persistent and quotes its text", () => {
    const l = approvalLines([], [{ tool: "save_memory", label: "I prefer metric units", verb: "Save to memory" }]);
    expect(l[0]!.persistent).toBe(true);
    expect(approvalLineText(l[0]!)).toBe('Save to memory: "I prefer metric units"');
  });
  it("falls back to the TOOL_META verb, then the raw tool name, then plain queries", () => {
    expect(approvalLines([], [{ tool: "fetch_url", label: "u" }])[0]!.verb).toBe("Fetch page");
    expect(approvalLines([], [{ tool: "brand_new", label: "u" }])[0]!.verb).toBe("brand_new");
    const q = approvalLines(["weather in Oslo"], undefined);
    expect(q).toHaveLength(1);
    expect(approvalLineText(q[0]!)).toBe("weather in Oslo");
  });
  it("lists several actions one per line", () => {
    const l = approvalLines([], [
      { tool: "web_search", label: "a" },
      { tool: "fetch_url", label: "b" },
    ]);
    expect(l.map(approvalLineText)).toEqual(["Web search: a", "Fetch page: b"]);
  });
});

describe("attachments", () => {
  it("classifies files", () => {
    expect(classifyFile("a.PDF")).toBe("pdf");
    expect(classifyFile("a.xlsx")).toBe("xlsx");
    expect(classifyFile("a.csv")).toBe("text");
    expect(classifyFile("noext", "text/plain")).toBe("text");
    expect(classifyFile("a.exe", "application/octet-stream")).toBeNull();
  });
  it("enforces size limits per class", () => {
    expect(validateFile({ name: "a.csv", size: MAX_TEXT_BYTES })).toBeNull();
    expect(validateFile({ name: "a.csv", size: MAX_TEXT_BYTES + 1 })).toMatch(/500 KB/);
    expect(validateFile({ name: "a.pdf", size: MAX_BINARY_BYTES })).toBeNull();
    expect(validateFile({ name: "a.xlsx", size: MAX_BINARY_BYTES + 1 })).toMatch(/10 MB/);
    expect(validateFile({ name: "a.zip", size: 10 })).toMatch(/unsupported/);
    expect(validateFile({ name: "a.pdf", size: 0 })).toMatch(/empty/);
  });
  it("labels kinds", () => {
    expect(fileKindLabel("x.pdf")).toBe("PDF");
    expect(fileKindLabel("x.xlsx")).toBe("XLSX");
    expect(fileKindLabel("x.csv")).toBe("CSV");
    expect(fileKindLabel("x.py")).toBe("CODE");
    expect(isExtractedBinary("x.pdf")).toBe(true);
    expect(isExtractedBinary("x.csv")).toBe(false);
  });
  it("encodes base64 identically to Buffer, including large and odd-length inputs", () => {
    for (const n of [0, 1, 2, 3, 29_999, 30_000, 30_001, 250_007]) {
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = (i * 31 + 7) & 255;
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    }
  });
});
