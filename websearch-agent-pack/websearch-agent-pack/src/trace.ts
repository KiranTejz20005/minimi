import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "./clock.js";

export type TraceStage =
  | "temporal"
  | "retrieve"
  | "llm_step"
  | "search"
  | "citations"
  | "digest";

export interface TraceWriter {
  start(): number;
  record(
    stage: TraceStage,
    durationMs: number,
    detail?: unknown,
  ): void;
  flush(): void;
}

export function createTraceWriter(
  db: DatabaseSync,
  turnId: string,
  clock?: Clock,
  turnStartMs?: number,
): TraceWriter {
  const clk = clock ?? { now: () => new Date() };
  const started = turnStartMs ?? clk.now().getTime();
  const pending: {
    stage: TraceStage;
    startedMs: number;
    durationMs: number;
    detail?: string;
  }[] = [];

  return {
    start: () => started,
    record(stage, durationMs, detail) {
      const now = clk.now().getTime();
      pending.push({
        stage,
        startedMs: now - started - durationMs,
        durationMs,
        detail: detail ? JSON.stringify(detail) : undefined,
      });
    },
    flush() {
      const insert = db.prepare(
        `INSERT INTO traces (turn_id, stage, started_ms, duration_ms, detail) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const row of pending) {
        insert.run(
          turnId,
          row.stage,
          row.startedMs,
          row.durationMs,
          row.detail ?? null,
        );
      }
    },
  };
}
