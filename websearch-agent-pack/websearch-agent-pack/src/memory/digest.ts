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
};

export class DigestQueue {
  private readonly queue: DigestJob[] = [];
  private active = 0;
  private readonly concurrency = 2;
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
    this.queue.push({ turnId, asOf });
    void this.pump();
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
      void this.run(job).finally(() => {
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
