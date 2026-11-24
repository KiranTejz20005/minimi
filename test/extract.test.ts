import { describe, expect, it } from "vitest";
import { extractUpload } from "../src/files/extract.js";
import { FileRejected } from "../src/files/errors.js";
import { buildPdf, buildXlsx, buildZip } from "./helpers/files.js";

const rejects = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(
    () => null,
    (x) => x,
  );
  expect(e).toBeInstanceOf(FileRejected);
  expect((e as FileRejected).code).toBe(code);
  return e as FileRejected;
};

describe("PDF extraction", () => {
  it("extracts text with recoverable page markers", async () => {
    const r = await extractUpload({ name: "doc.pdf", mime: "application/pdf", bytes: buildPdf(["Hello first page", "Second page revenue 42"]) });
    expect(r.kind).toBe("pdf");
    expect(r.meta.pages).toBe(2);
    expect(r.text).toContain("=== page 1 ===");
    expect(r.text).toContain("=== page 2 ===");
    expect(r.text.indexOf("Hello first page")).toBeLessThan(r.text.indexOf("=== page 2 ==="));
    expect(r.text.split("=== page 2 ===")[1]).toContain("Second page revenue 42");
    expect(r.meta.originalSize).toBeGreaterThan(100);
  });
  it("rejects a .pdf without the %PDF- signature", async () => {
    await rejects(extractUpload({ name: "a.pdf", bytes: Buffer.from("MZ\x90\x00 not a pdf") }), "signature_mismatch");
    await rejects(extractUpload({ name: "a.pdf", bytes: Buffer.from("plain text pretending") }), "signature_mismatch");
  });
  it("rejects a corrupt PDF with 422", async () => {
    const e = await rejects(extractUpload({ name: "a.pdf", bytes: Buffer.from("%PDF-1.4\ngarbage garbage garbage") }), "corrupt");
    expect(e.status).toBe(422);
  });
  it("defuses forged page markers inside page text", async () => {
    const r = await extractUpload({ name: "x.pdf", bytes: buildPdf(["=== page 9 ===", "b"]) });
    expect(r.text.match(/^=== page \d+ ===$/gm)).toHaveLength(2);
  });
});

describe("XLSX extraction", () => {
  const wb = () =>
    buildXlsx([
      { name: "Sales", rows: [["Region", "Revenue"], ["North", 100], ["South", 250.5]] },
      { name: "Notes", rows: [["Note"], ["hello"]] },
    ]);
  it("renders sheets with header rows and meta", async () => {
    const r = await extractUpload({ name: "book.xlsx", bytes: wb() });
    expect(r.kind).toBe("xlsx");
    expect(r.text).toContain("=== sheet: Sales ===\nRegion\tRevenue\nNorth\t100\nSouth\t250.5");
    expect(r.text).toContain("=== sheet: Notes ===");
    expect(r.meta.sheets).toEqual([
      { name: "Sales", rows: 2, cols: 2, header: ["Region", "Revenue"] },
      { name: "Notes", rows: 1, cols: 1, header: ["Note"] },
    ]);
  });
  it("rejects .xlsx that is not a ZIP", async () => {
    await rejects(extractUpload({ name: "a.xlsx", bytes: Buffer.from("MZ\x90\x00\x03\x00 exe") }), "signature_mismatch");
  });
  it("rejects a ZIP without xl/workbook.xml (renamed zip)", async () => {
    await rejects(extractUpload({ name: "a.xlsx", bytes: buildZip([{ name: "payload.exe", data: "MZ" }]) }), "signature_mismatch");
  });
  it("rejects a zip bomb (declared ratio) and an entry that lies about its size", async () => {
    const big = Buffer.alloc(30 * 1024 * 1024, 0);
    await rejects(extractUpload({ name: "a.xlsx", bytes: buildXlsx([{ name: "S", rows: [["a"]] }], [{ name: "xl/bomb.bin", data: big }]) }), "zip_limits");
    const lying = buildXlsx([{ name: "S", rows: [["a"]] }], [{ name: "xl/lie.bin", data: Buffer.alloc(5_000_000, 1), fakeSize: 1000 }]);
    await rejects(extractUpload({ name: "a.xlsx", bytes: lying }), "zip_limits");
  });
  it("rejects a corrupt zip tail", async () => {
    const good = wb();
    await rejects(extractUpload({ name: "a.xlsx", bytes: good.subarray(0, good.length - 40) }), "corrupt");
  });
  it("rejects legacy .xls", async () => {
    await rejects(extractUpload({ name: "a.xls", bytes: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]) }), "unsupported_type");
  });
});

describe("text / csv and common rejections", () => {
  it("accepts csv text and records header meta + delimiter", async () => {
    const r = await extractUpload({ name: "d.csv", text: "a;b;c\n1;2;3\n4;5;6\n" });
    expect(r.kind).toBe("csv");
    expect(r.meta.delimiter).toBe(";");
    expect(r.meta.sheets).toEqual([{ name: "data", rows: 2, cols: 3, header: ["a", "b", "c"] }]);
  });
  it("accepts base64-style bytes for text and strips BOM", async () => {
    const r = await extractUpload({ name: "n.txt", bytes: Buffer.from("﻿hello world", "utf8") });
    expect(r.kind).toBe("text");
    expect(r.text).toBe("hello world");
  });
  it("rejects NUL bytes in text and binary", async () => {
    await rejects(extractUpload({ name: "a.txt", text: "ab\u0000cd" }), "not_text");
    await rejects(extractUpload({ name: "a.csv", bytes: Buffer.from("a,b\n1,\u0000") }), "not_text");
  });
  it("rejects invalid UTF-8 and executables renamed to .txt", async () => {
    await rejects(extractUpload({ name: "a.txt", bytes: Buffer.from([0x68, 0xff, 0xfe, 0x69]) }), "not_text");
    await rejects(extractUpload({ name: "a.txt", bytes: Buffer.from([0x4d, 0x5a, 0x90, 0x41, 0x41]) }), "signature_mismatch");
  });
  it("rejects a PDF renamed .txt and a zip renamed .csv", async () => {
    await rejects(extractUpload({ name: "a.txt", bytes: buildPdf(["x"]) }), "signature_mismatch");
    await rejects(extractUpload({ name: "a.csv", bytes: buildZip([{ name: "a", data: "b" }]) }), "signature_mismatch");
  });
  it("rejects oversize", async () => {
    await rejects(extractUpload({ name: "a.txt", text: "x".repeat(500_001) }), "too_large");
    await rejects(extractUpload({ name: "a.pdf", bytes: Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(11 * 1024 * 1024, 32)]) }), "too_large");
  });
  it("rejects empty and binary-as-text-field", async () => {
    await rejects(extractUpload({ name: "a.txt", text: "   \n" }), "empty");
    await rejects(extractUpload({ name: "a.pdf", text: "%PDF-1.4" }), "signature_mismatch");
  });
});
