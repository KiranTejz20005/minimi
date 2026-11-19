import { describe, it, expect } from "vitest";
import {
  BM25_MATCH_THRESHOLD,
  bm25Score,
  rankBm25,
  tokenize,
} from "../src/memory/bm25.js";

describe("bm25", () => {
  it("tokenize drops stop words", () => {
    expect(tokenize("The CRM tools for sales")).toContain("crm");
    expect(tokenize("The CRM tools for sales")).not.toContain("the");
  });

  it("ranks postgres doc above laptop for postgres query", () => {
    const docs = [
      "Compare Postgres hosting prices Neon Supabase",
      "Best laptop for video editing under budget",
    ];
    const { scores } = rankBm25("postgres hosting prices", docs);
    expect(scores[0]!).toBeGreaterThan(scores[1]!);
    expect(scores[0]!).toBeGreaterThanOrEqual(BM25_MATCH_THRESHOLD);
  });

  it("unrelated query scores near zero", () => {
    const doc = "carry-on baggage rules 7kg";
    expect(bm25Score("vector database RAG", doc, [doc])).toBeLessThan(
      BM25_MATCH_THRESHOLD,
    );
  });
});
