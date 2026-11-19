export type SearchTopic = "general" | "news";

/** Arguments the model passes to `web_search`. */
export interface SearchInput {
  query: string;
  start_date?: string;
  domains?: string[];
  topic?: SearchTopic;
}

/** One result from the search provider before trimming. */
export interface RawResult {
  url: string;
  title: string;
  content: string;
  publishedAt?: string | null;
}

/** Result after BM25 trim, ready for the model and cache. */
export interface TrimmedResult {
  url: string;
  title: string;
  content: string;
  publishedAt?: string | null;
}

export interface CitationSource {
  n: number;
  url: string;
  title: string;
  publishedAt: string | null;
  retrievedAt: string;
}

export interface CitationRegistry {
  readonly sources: Map<number, CitationSource>;
  assign(results: TrimmedResult[], retrievedAt: string): number[];
}

export interface SearchProvider {
  search(input: SearchInput, signal: AbortSignal): Promise<RawResult[]>;
}

export interface SearchRunResult {
  query: string;
  xml: string;
  count: number;
  ms: number;
  cached: boolean;
  error?: string;
  sources?: CitationSource[];
}

export const MAX_SEARCH_RESULTS = 5;
export const MAX_CHARS_PER_RESULT = 1200;
