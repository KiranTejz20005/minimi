import { getConfig } from '../config.js';
import { createAnthropicLlm, createLlm } from '../llm/anthropic.js';
import type { LLM } from '../llm/types.js';
import { z } from 'zod';
import type { MemoryStore } from './store.js';

const schema = z.object({
  topic: z.string(),
  entities: z.array(z.string()),
  claims: z.array(
    z.object({
      subject: z.string(),
      attribute: z.string(),
      value: z.string(),
      source_url: z.string().optional(),
      volatility: z.enum(['high', 'medium', 'low']).default('high'),
    }),
  ),
});

type DigestJob = {
  turnId: string;
  asOf: string;
  enqueuedAt: number;
};

export type DigestSnapshot = {
  concurrency: number;
  model: string;
  waiting: { id: string }[];
  running: { id: string; startedAt: number }[];
  /** Completions in the last 60s. */
  throughputPerMin: number;
  /** 95th percentile of enqueue-to-start wait over recent jobs, ms. */
  waitP95Ms: number;
  /** Queue depth over the last `windowMs`, bucketed oldest to newest. */
  history: number[];
  windowMs: number;
};

const WINDOW_MS = 10 * 60_000;
const BUCKETS = 48;

export class DigestQueue {
  private readonly queue: DigestJob[] = [];
  private active = 0;
  private readonly concurrency = 2;
  private readonly running = new Map<string, number>();
  private readonly finished: { at: number; waitMs: number }[] = [];
  private readonly depthLog: { t: number; depth: number }[] = [];
  private client: LLM | null;
  private ready: Promise<void> = Promise.resolve();
  private readonly model: string;

  constructor(
    private readonly store: MemoryStore,
    options?: { apiKey?: string; model?: string },
  ) {
    const cfg = getConfig();
    this.client = null;
    if (options?.apiKey || cfg.hasLlm) {
      const llmPromise = options?.apiKey
        ? Promise.resolve(createAnthropicLlm(options.apiKey))
        : createLlm();
      this.ready = llmPromise.then((l) => {
        this.client = l;
      });
    }
    this.model = options?.model ?? cfg.MODEL_FAST;
  }

  enqueue(turnId: string, asOf: string): void {
    this.queue.push({ turnId, asOf, enqueuedAt: Date.now() });
    this.logDepth();
    void this.pump();
  }

  private logDepth(): void {
    const now = Date.now();
    this.depthLog.push({ t: now, depth: this.queue.length });
    while (this.depthLog.length > 2 && this.depthLog[1]!.t < now - WINDOW_MS) this.depthLog.shift();
  }

  /** Live state for the Analytics queue monitor. */
  snapshot(): DigestSnapshot {
    const now = Date.now();
    const waits = this.finished.filter((f) => f.at > now - WINDOW_MS).map((f) => f.waitMs).sort((a, b) => a - b);
    const p95 = waits.length ? waits[Math.min(waits.length - 1, Math.ceil(waits.length * 0.95) - 1)]! : 0;
    const bucketMs = WINDOW_MS / BUCKETS;
    const start = now - WINDOW_MS;
    const history: number[] = [];
    let carried = this.depthLog.length ? this.depthLog[0]!.depth : 0;
    let i = 0;
    for (let b = 0; b < BUCKETS; b++) {
      const end = start + (b + 1) * bucketMs;
      let peak = carried;
      while (i < this.depthLog.length && this.depthLog[i]!.t <= end) {
        carried = this.depthLog[i]!.depth;
        peak = Math.max(peak, carried);
        i++;
      }
      history.push(peak);
    }
    history[BUCKETS - 1] = this.queue.length;
    return {
      concurrency: this.concurrency,
      model: this.model,
      waiting: this.queue.map((j) => ({ id: j.turnId })),
      running: [...this.running].map(([id, startedAt]) => ({ id, startedAt })),
      throughputPerMin: this.finished.filter((f) => f.at > now - 60_000).length,
      waitP95Ms: p95,
      history,
      windowMs: WINDOW_MS,
    };
  }

  retryPending(): void {
    for (const row of this.store.pendingDigests()) {
      this.enqueue(row.id, row.local_date);
    }
  }

  private async pump(): Promise<void> {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      this.active += 1;
      const startedAt = Date.now();
      this.running.set(job.turnId, startedAt);
      this.logDepth();
      void this.run(job).finally(() => {
        this.finished.push({ at: Date.now(), waitMs: startedAt - job.enqueuedAt });
        if (this.finished.length > 200) this.finished.shift();
        this.running.delete(job.turnId);
        this.active -= 1;
        void this.pump();
      });
    }
  }

  private async run(job: DigestJob): Promise<void> {
    await this.ready;
    if (!this.client) {
      this.store.setDigestMeta(job.turnId, '', [], 'skipped');
      return;
    }

    const answer = this.store.turnAnswer(job.turnId);
    if (!answer) {
      this.store.setDigestMeta(job.turnId, '', [], 'failed');
      return;
    }

    const sources = this.store.sourcesForTurn(job.turnId);
    const sourceBlock = sources.map((s) => `- ${s.title ?? s.url}: ${s.url}`).join('\n');

    try {
      const json = await this.client.json<unknown>({
        model: this.model,
        system: 'You extract structured data. Reply with JSON only, no prose.',
        user: `Extract a short topic, entity names, and time-sensitive checkable claims from this assistant answer.
Return JSON only: { "topic", "entities": string[], "claims": [{ "subject", "attribute", "value", "source_url?", "volatility"? }] }
Claims must be facts that could change (prices, versions, leadership). Use source URLs when provided.

Sources cited:
${sourceBlock || '(none)'}

Answer:
${answer.slice(0, 8000)}`,
      });
      const parsed = schema.parse(json);
      this.store.replaceClaims(
        job.turnId,
        parsed.claims.map((c) => ({
          subject: c.subject,
          attribute: c.attribute,
          value: c.value,
          as_of: job.asOf,
          source_url: c.source_url ?? null,
          volatility: c.volatility,
        })),
      );
      this.store.setDigestMeta(job.turnId, parsed.topic, parsed.entities, 'done');
    } catch {
      this.store.setDigestMeta(job.turnId, '', [], 'failed');
    }
  }
}
