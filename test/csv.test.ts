import { describe, expect, it } from "vitest";
import { parseDelimited, sniffDelimiter, squareRows } from "../src/files/csv.js";

describe("parseDelimited", () => {
  it("parses simple rows", () => {
    expect(parseDelimited("a,b,c\n1,2,3\n").rows).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
  });
  it("handles CRLF, CR and no trailing newline", () => {
    expect(parseDelimited("a,b\r\n1,2\r\n3,4").rows).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
    expect(parseDelimited("a,b\r1,2", { delimiter: "," }).rows).toEqual([["a", "b"], ["1", "2"]]);
  });
  it("handles quoted fields with delimiters, newlines and escaped quotes", () => {
    const r = parseDelimited('name,note\n"Smith, J","said ""hi""\nthere"\n').rows;
    expect(r).toEqual([["name", "note"], ["Smith, J", 'said "hi"\nthere']]);
  });
  it("keeps empty fields and empty quoted fields", () => {
    expect(parseDelimited('a,,"",d').rows).toEqual([["a", "", "", "d"]]);
  });
  it("skips blank lines but not rows of empty fields", () => {
    expect(parseDelimited("a,b\n\n,\n").rows).toEqual([["a", "b"], ["", ""]]);
  });
  it("strips a UTF-8 BOM", () => {
    expect(parseDelimited("\uFEFFid,v\n1,2").rows[0]).toEqual(["id", "v"]);
  });
  it("tolerates an unterminated quote", () => {
    expect(parseDelimited('a,"b\nc').rows).toEqual([["a", "b\nc"]]);
  });
  it("keeps ragged rows ragged and squareRows pads them", () => {
    const r = parseDelimited("a,b,c\n1\n1,2,3,4").rows;
    expect(r.map((x) => x.length)).toEqual([3, 1, 4]);
    expect(squareRows(r, 3).map((x) => x.length)).toEqual([3, 3, 3]);
  });
  it("honours maxRows and maxCols and reports truncation", () => {
    const p = parseDelimited("a,b,c\n1,2,3\n4,5,6", { maxRows: 2, maxCols: 2 });
    expect(p.rows).toEqual([["a", "b"], ["1", "2"]]);
    expect(p.truncated).toBe(true);
  });
  it("a quote in the middle of a field is literal", () => {
    expect(parseDelimited('5" pipe,x', { delimiter: "," }).rows).toEqual([['5" pipe', "x"]]);
  });
});

describe("sniffDelimiter", () => {
  it("detects tab, semicolon, pipe and comma", () => {
    expect(sniffDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
    expect(sniffDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(sniffDelimiter("a|b\n1|2")).toBe("|");
    expect(sniffDelimiter("a,b\n1,2")).toBe(",");
  });
  it("ignores delimiters inside quotes and defaults to comma", () => {
    expect(sniffDelimiter('"a;b;c;d",x\n"1;2;3;4",y')).toBe(",");
    expect(sniffDelimiter("just one column\nanother")).toBe(",");
  });
  it("prefers the consistent delimiter over noisy commas in text", () => {
    expect(sniffDelimiter("name\tnote\nBob\tHello, world, again\nAnn\tfine")).toBe("\t");
  });
});
