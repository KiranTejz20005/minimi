export type TraceRow = { stage: string; detail?: string | null };

export type SearchBatchDetail = {
  batch?: number;
  parallel?: boolean;
  count?: number;
  queries?: { query: string; durationMs: number }[];
};

export function parseSearchBatchDetail(detail: string | null | undefined): SearchBatchDetail | null {
  if (!detail?.trim()) return null;
  try {
    return JSON.parse(detail) as SearchBatchDetail;
  } catch {
    return null;
  }
}

/** First search trace batch must include at least `minQueries` queries launched in parallel. */
export function parallelOkFromTraces(
  traces: TraceRow[],
  minQueries: number,
): boolean {
  if (minQueries <= 1) return true;
  const searchRows = traces.filter((t) => t.stage === "search");
  const first = searchRows[0];
  const detail = parseSearchBatchDetail(first?.detail);
  if (!detail) return false;
  const count = detail.count ?? detail.queries?.length ?? 0;
  if (count < minQueries) return false;
  return detail.parallel === true;
}
