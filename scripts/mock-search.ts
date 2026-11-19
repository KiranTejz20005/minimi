import type { RawResult, SearchInput, SearchProvider } from "../src/search/types.js";

function cannedResult(query: string, extra?: string): RawResult[] {
  const body =
    extra ??
    `${query}: official pricing page shows current plans unchanged. Reference value for eval.`;
  return [
    {
      url: `https://example.com/${encodeURIComponent(query.slice(0, 24))}`,
      title: `Results for ${query}`,
      content: body,
      publishedAt: "2026-11-10",
    },
  ];
}

export function createMockSearchProvider(
  opts?: { fail?: boolean; poison?: string },
): SearchProvider {
  return {
    async search(input: SearchInput, _signal: AbortSignal): Promise<RawResult[]> {
      if (opts?.fail) throw new Error("mock search provider forced failure");
      const poison = opts?.poison ? ` ${opts.poison}` : "";
      return cannedResult(input.query, poison || undefined);
    },
  };
}

export function createMultiHitProvider(minHits: number): SearchProvider {
  return {
    async search(input: SearchInput): Promise<RawResult[]> {
      const out: RawResult[] = [];
      for (let i = 0; i < minHits; i++) {
        out.push({
          url: `https://vendor-${i}.example/pricing`,
          title: `${input.query} vendor ${i}`,
          content: `Vendor ${i} price $${40 + i * 10}/mo unchanged [1]`,
          publishedAt: "2026-11-10",
        });
      }
      return out.slice(0, Math.max(1, minHits));
    },
  };
}
