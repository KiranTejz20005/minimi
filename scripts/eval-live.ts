/**
 * LIVE eval: runs scripts/eval-live-cases.ts against the REAL configured model (no scripted LLM) and writes a
 * scorecard to data/eval-live/<ISO>-<model>.json.
 *
 *   npm run eval:live -- [--model <id>] [--only <caseId,...>] [--list] [--max-cases N] [--timeout-ms 90000]
 *
 * Each case gets a fresh in-memory DB (schema.sql + migrate), uploads go through the real Hono route, turns go
 * through runTurn exactly like POST /api/chat (attachment manifest, approval handler, bind after the turn).
 * runTurn is NOT given an `llm`, so it builds the real one (createLlm) and keeps the forced-search behaviour.
 *
 * Never prints keys: provider/model NAMES only; every excerpt and error is redacted.
 * Exit codes: 0 = scorecard written (even with FAILs), 1 = harness crash / bad CLI, 2 = no LLM key configured.
 */
import "dotenv/config";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  excerpt,
  findToolMarkup,
  grade,
  pct,
  placeholderLeaks,
  redact,
  reportFileName,
  scanProviderBody,
  summarize,
  formatTable,
  citationsValid,
  check,
  warn,
  type Assertion,
  type LlmUsage,
  type Status,
} from "./eval-live-lib.js";
import type { Harness, LiveCase, SeedFunding, Session, ToolCallObs, TurnObs, TurnOpts, UploadFile } from "./eval-live-cases.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Global cap on LLM-backed cases per run. */
const MAX_LLM_CASES = 20;

// The web-search cache (and anything else using the process DB singleton) must never touch data/agent.db.
// Set before any src module reads the lazy config (all src imports below are dynamic).
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "minimi-live-")), "agent.db");

// ---- CLI ----------------------------------------------------------------------------------------------------

type Args = { model?: string; only?: string[]; list: boolean; maxCases?: number; timeoutMs: number; tap: boolean };

function parseArgs(argv: string[]): Args {
  const a: Args = { list: false, timeoutMs: 90_000, tap: true };
  const val = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new CliError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i]!;
    const [flag, inline] = f.includes("=") ? [f.slice(0, f.indexOf("=")), f.slice(f.indexOf("=") + 1)] : [f, undefined];
    const take = () => inline ?? val(i++, flag);
    if (flag === "--model") a.model = take().trim();
    else if (flag === "--only") a.only = take().split(",").map((s) => s.trim()).filter(Boolean);
    else if (flag === "--list") a.list = true;
    else if (flag === "--no-tap") a.tap = false;
    else if (flag === "--max-cases") {
      const n = Number(take());
      if (!Number.isInteger(n) || n < 1) throw new CliError("--max-cases must be a positive integer");
      a.maxCases = n;
    } else if (flag === "--timeout-ms") {
      const n = Number(take());
      if (!Number.isFinite(n) || n < 1000) throw new CliError("--timeout-ms must be >= 1000");
      a.timeoutMs = n;
    } else if (flag === "--help" || flag === "-h") {
      console.log("usage: npm run eval:live -- [--model <id>] [--only <caseId,...>] [--list] [--max-cases N] [--timeout-ms 90000] [--no-tap]");
      process.exit(0);
    } else throw new CliError(`unknown argument: ${f}`);
  }
  return a;
}

class CliError extends Error {}

// ---- provider stream tap (counts calls, finish reasons, usage; never stores content) ---------------------

type Tap = { calls: number; finishReasons: string[]; usage: LlmUsage | null; pending: Promise<void>[] };
let activeTap: Tap | null = null;

const LLM_URL = /\/chat\/completions\b|\/v1\/messages\b/;

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (out.length < 8_000_000) out += dec.decode(value, { stream: true });
  }
  return out;
}

function installTap(): void {
  const orig = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as Request)?.url ?? "");
    const tap = activeTap;
    const res = await orig(input, init);
    if (!tap || !LLM_URL.test(url)) return res;
    tap.calls += 1;
    if (!res.body) return res;
    try {
      const [mine, theirs] = res.body.tee();
      tap.pending.push(
        drain(mine)
          .then((body) => {
            const s = scanProviderBody(body);
            tap.finishReasons.push(...s.finishReasons);
            if (s.usage) {
              const u = (tap.usage ??= { inputTokens: 0, outputTokens: 0 });
              u.inputTokens += s.usage.inputTokens;
              u.outputTokens += s.usage.outputTokens;
            }
          })
          .catch(() => {}),
      );
      const out = new Response(theirs, { status: res.status, statusText: res.statusText, headers: res.headers });
      try {
        Object.defineProperty(out, "url", { value: res.url });
      } catch {
        /* cosmetic */
      }
      return out;
    } catch {
      return res;
    }
  }) as typeof fetch;
}

// ---- main ----------------------------------------------------------------------------------------------------

type CaseRecord = {
  n: number;
  id: string;
  category: string;
  title: string;
  status: Status;
  reasons: string[];
  warnings: string[];
  behaviour?: string;
  notes?: string[];
  ms: number;
  tools: string[];
  toolCalls: { turn: number; name: string; input: string; error: string | null }[];
  approvals: { turn: number; tool: string; label: string; approved: boolean }[];
  steps: number[];
  firstTokenMs: number | null;
  llm: { calls: number; finishReasons: string[]; usage: LlmUsage | null };
  tokens: { streamEvents: number; streamedChars: number; answerChars: number; estOutputTokens: number };
  answerExcerpt: string;
  turns: { message: string; answerExcerpt: string; tools: string[]; steps: number; ms: number; budget: string | null; errors: string[] }[];
  assertions: Assertion[];
};

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof CliError) {
      console.error(`eval:live: ${e.message}`);
      return 1;
    }
    throw e;
  }

  const { LIVE_CASES } = await import("./eval-live-cases.js");
  const { listTools } = await import("../src/tools/registry.js");
  const toolNames = listTools().map((t) => t.name);

  let cases: LiveCase[] = LIVE_CASES;
  if (args.only?.length) {
    const unknown = args.only.filter((id) => !LIVE_CASES.some((c) => c.id === id));
    if (unknown.length) {
      console.error(`eval:live: unknown case id(s): ${unknown.join(", ")}. Use --list.`);
      return 1;
    }
    cases = LIVE_CASES.filter((c) => args.only!.includes(c.id));
  }
  if (args.maxCases) cases = cases.slice(0, args.maxCases);

  if (args.list) {
    console.log(
      formatTable(
        ["#", "case", "category", "title", "note"],
        LIVE_CASES.map((c) => [String(c.n), c.id, c.category, c.title, c.skipIf?.({ toolNames }) ? `SKIP: ${c.skipIf({ toolNames })}` : ""]),
      ),
    );
    return 0;
  }

  const { getConfig } = await import("../src/config.js");
  const cfg = getConfig();
  if (!cfg.hasLlm) {
    console.error(
      "eval:live: no LLM API key configured (ANTHROPIC_API_KEY or NVIDIA_API_KEY in .env). This eval calls the real model; nothing was run.",
    );
    return 2;
  }
  const secrets = [cfg.ANTHROPIC_API_KEY, cfg.NVIDIA_API_KEY, cfg.TAVILY_API_KEY, process.env.ACCESS_TOKEN];
  const red = (s: string) => redact(s, secrets);
  const backgroundErrors: string[] = [];
  process.on("unhandledRejection", (e) => {
    backgroundErrors.push(red(e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 300));
  });

  const { DatabaseSync } = await import("node:sqlite");
  const { Hono } = await import("hono");
  const { migrate } = await import("../src/db.js");
  const { registerRoutes, attachmentContext, bindAttachments } = await import("../src/routes.js");
  const { runTurn, getDigestQueue } = await import("../src/agent/run-turn.js");
  const { getTracesForTurn } = await import("../src/memory/store.js");
  const { searchProviderName } = await import("../src/search/free.js");
  const { b64 } = await import("../test/helpers/files.js");
  const { upsertStartups } = await import("../src/discover/store.js");

  const schema = readFileSync(join(root, "schema.sql"), "utf8");
  const freshDb = () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schema);
    migrate(db);
    return db;
  };
  // The background digest queue is a process singleton bound to the first DB it sees. Bind it to a sink DB so it
  // never makes extra (billed) LLM calls for case turns or writes into a case DB. DBs stay open until exit.
  getDigestQueue(freshDb());

  const anthropic = Boolean(cfg.ANTHROPIC_API_KEY?.trim());
  let baseHost = "";
  try {
    baseHost = new URL(cfg.LLM_BASE_URL).host;
  } catch {
    baseHost = "custom";
  }
  const provider = anthropic ? "Anthropic" : `OpenAI-compatible (${baseHost})`;
  const model = args.model || cfg.MODEL_MAIN;
  const search = searchProviderName();
  if (args.tap) installTap();

  console.log(`eval:live  provider=${provider}  model=${model}${args.model ? " (override)" : ""}  web_search=${search}`);
  console.log(
    `limits: MAX_STEPS=${cfg.MAX_STEPS} MAX_TOOL_CALLS_PER_TURN=${cfg.MAX_TOOL_CALLS_PER_TURN} FORCE_SEARCH=${cfg.FORCE_SEARCH} timeout=${args.timeoutMs}ms/turn-unit  cases=${cases.length}`,
  );

  const harnessFor = (turnLog: TurnObs[], signal: AbortSignal, deadline: number): Harness => ({
    toolNames,
    session(): Session {
      const db = freshDb();
      const app = new Hono();
      registerRoutes(app, db);
      return {
        async upload(file: UploadFile) {
          const body: Record<string, unknown> = { name: file.name, ...(file.mime ? { mime: file.mime } : {}) };
          if (file.bytes) body.contentBase64 = b64(file.bytes);
          else body.content = file.text ?? "";
          const res = await app.request("/api/attachments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          const json = (await res.json().catch(() => ({}))) as { id?: string; name?: string; error?: string };
          if (res.status !== 200 || !json.id) throw new Error(`harness: upload of ${file.name} failed (${res.status}): ${red(String(json.error ?? "")).slice(0, 160)}`);
          return { id: json.id, name: json.name ?? file.name };
        },
        savedMemories() {
          return (db.prepare(`SELECT text FROM saved_memories WHERE deleted_at IS NULL ORDER BY created_at`).all() as { text: string }[]).map((r) => r.text);
        },
        seedFunding(rows: SeedFunding[]) {
          const now = Date.now();
          upsertStartups(
            db,
            rows.map((r) => ({
              extraction: { company: r.company, amountUsd: r.amountUsd, amountText: r.amountText, currency: "USD", round: r.round, investors: r.investors, location: null, sector: r.sector },
              item: { title: r.title, url: r.url, summary: r.title, imageUrl: null, publishedAt: new Date(now - r.daysAgo * 86_400_000).toISOString() },
              source: r.source,
            })),
            new Date(now).toISOString(),
          );
          return Number((db.prepare(`SELECT COUNT(*) AS c FROM startup_fundings`).get() as { c: number }).c);
        },
        async turn(message: string, opts: TurnOpts = {}) {
          const obs: TurnObs = {
            message,
            answer: "",
            conversationId: "",
            turnId: "",
            steps: 0,
            ms: 0,
            firstTokenMs: null,
            sourceCount: 0,
            searchCount: 0,
            tools: [],
            toolBatches: [],
            approvals: [],
            streamed: "",
            tokenEvents: 0,
            errors: [],
            threw: false,
            budget: null,
            llm: { calls: 0, finishReasons: [], usage: null },
          };
          turnLog.push(obs);
          const ids = opts.attachmentIds ?? [];
          const fileCtx = attachmentContext(db, opts.conversationId, ids);
          const policy = opts.approval ?? "approve";
          const tap: Tap = { calls: 0, finishReasons: [], usage: null, pending: [] };
          activeTap = tap;
          const t0 = Date.now();
          let hardTimer: NodeJS.Timeout | undefined;
          try {
            const hard = new Promise<never>((_, reject) => {
              hardTimer = setTimeout(() => reject(new Error("harness: hard timeout (turn ignored its abort signal)")), Math.max(1000, deadline - Date.now()) + 15_000);
            });
            const res = await Promise.race([
              runTurn(
                {
                  message,
                  contextMessage: fileCtx ? `${fileCtx}\n\n${message}` : undefined,
                  attachmentIds: ids,
                  approvalMode: opts.approvalMode ?? "auto",
                  tz: cfg.DEFAULT_TZ,
                  conversationId: opts.conversationId,
                  db,
                  signal,
                  ...(args.model ? { model: args.model } : {}),
                },
                {
                  onConversation: (id) => void (obs.conversationId = id),
                  onToken: (text) => {
                    obs.tokenEvents += 1;
                    obs.streamed += text;
                  },
                  onError: (m) => void obs.errors.push(red(m).slice(0, 240)),
                  onToolStart: (tools) => void obs.toolBatches.push(tools.map((x) => x.tool)),
                  onSearchStart: (queries) => void obs.toolBatches.push(queries.map(() => "web_search")),
                  requestApproval: async (actions) => {
                    for (const raw of actions as unknown[]) {
                      const a = typeof raw === "string" ? { tool: "action", label: raw } : (raw as { tool?: string; label?: string });
                      obs.approvals.push({ tool: String(a.tool ?? "action"), label: red(String(a.label ?? "")).slice(0, 200), approved: policy === "approve" });
                    }
                    return policy === "approve";
                  },
                },
              ),
              hard,
            ]);
            obs.answer = res.answer;
            obs.conversationId = res.conversationId;
            obs.turnId = res.turnId;
            obs.steps = res.steps;
            obs.firstTokenMs = res.firstTokenMs;
            obs.sourceCount = res.sourceCount;
            obs.searchCount = res.searchCount;
            if (ids.length) bindAttachments(db, res.conversationId, ids);
          } catch (e) {
            obs.threw = true;
            const msg = signal.aborted ? `turn timed out (case budget exhausted)` : red(e instanceof Error ? e.message : String(e)).slice(0, 240);
            if (!obs.errors.includes(msg)) obs.errors.push(msg);
          } finally {
            clearTimeout(hardTimer);
            obs.ms = Date.now() - t0;
            await Promise.race([Promise.allSettled(tap.pending), new Promise((r) => setTimeout(r, 3000))]);
            activeTap = null;
            obs.llm = { calls: tap.calls, finishReasons: tap.finishReasons, usage: tap.usage };
          }
          if (obs.turnId) {
            const rows = db
              .prepare(`SELECT name, input, error, content FROM tool_results WHERE turn_id = ? ORDER BY created_at, rowid`)
              .all(obs.turnId) as { name: string; input: string | null; error: string | null; content: string }[];
            obs.tools = rows.map((r): ToolCallObs => {
              let input: Record<string, unknown> = {};
              try {
                const v = r.input ? JSON.parse(r.input) : {};
                if (v && typeof v === "object") input = v as Record<string, unknown>;
              } catch {
                /* capped / unparsable input */
              }
              return { name: r.name, input, error: r.error, content: r.content };
            });
            const step = getTracesForTurn(db, obs.turnId).find((x) => x.stage === "llm_step");
            try {
              const d = step ? (JSON.parse(String((step as { detail?: unknown }).detail ?? "{}")) as { budget?: string | null }) : {};
              obs.budget = d.budget ?? null;
            } catch {
              obs.budget = null;
            }
          }
          return obs;
        },
      };
    },
  });

  const records: CaseRecord[] = [];
  let llmCases = 0;
  const runStart = Date.now();

  for (const [i, c] of cases.entries()) {
    const tag = `[${String(i + 1).padStart(2)}/${cases.length}] ${c.id.padEnd(22)}`;
    const skipReason = c.skipIf?.({ toolNames }) ?? (llmCases >= MAX_LLM_CASES ? `global cap of ${MAX_LLM_CASES} LLM-backed cases reached` : null);
    if (skipReason) {
      records.push(emptyRecord(c, "SKIP", [skipReason]));
      console.log(`${tag} SKIP  (${skipReason})`);
      continue;
    }
    llmCases += 1;
    const turnLog: TurnObs[] = [];
    const ac = new AbortController();
    const budgetMs = args.timeoutMs * Math.max(1, c.turns);
    const deadline = Date.now() + budgetMs;
    const timer = setTimeout(() => ac.abort(), budgetMs);
    const t0 = Date.now();
    let outcome: Awaited<ReturnType<LiveCase["run"]>> | null = null;
    let harnessError: string | null = null;
    try {
      outcome = await c.run(harnessFor(turnLog, ac.signal, deadline));
    } catch (e) {
      harnessError = red(e instanceof Error ? e.message : String(e)).slice(0, 300);
    } finally {
      clearTimeout(timer);
    }
    const ms = Date.now() - t0;

    if (outcome?.skip && !harnessError) {
      records.push({ ...emptyRecord(c, "SKIP", [outcome.skip]), ms });
      console.log(`${tag} SKIP  (${outcome.skip})`);
      continue;
    }

    const assertions: Assertion[] = [];
    if (harnessError) assertions.push(check("case ran without a harness error", false, harnessError));
    const multi = turnLog.length > 1;
    turnLog.forEach((t, k) => {
      const p = multi ? `[t${k + 1}] ` : "";
      const markup = findToolMarkup(t.answer, toolNames);
      const streamedMarkup = findToolMarkup(t.streamed, toolNames);
      const leaks = placeholderLeaks(t.answer, { allowWords: !!c.allowCodeWords });
      assertions.push(
        check(`${p}turn completed`, !t.threw, t.errors.join(" | ")),
        check(`${p}no error events`, t.errors.length === 0, t.errors.join(" | ")),
        check(`${p}non-empty answer`, t.answer.trim().length > 0),
        check(`${p}not the "couldn't generate" fallback`, !/I couldn't generate an answer this time/i.test(t.answer)),
        check(`${p}no tool markup in answer`, markup.length === 0, markup.slice(0, 3).join(" ")),
        check(`${p}no tool markup in streamed text`, streamedMarkup.length === 0, streamedMarkup.slice(0, 3).join(" ")),
        check(`${p}no undefined/[object leaks`, leaks.length === 0, leaks.slice(0, 3).join(" ")),
        check(`${p}citations valid`, citationsValid(t.answer, t.sourceCount), `sources=${t.sourceCount}`),
        warn(`${p}answer was streamed to the client`, t.tokenEvents > 0 || !t.answer.trim()),
        warn(`${p}no step/tool budget hit`, !t.budget, t.budget ?? undefined),
      );
    });
    if (outcome) assertions.push(...outcome.assertions);
    const g = grade(assertions);
    const last = turnLog.at(-1);
    const usage = sumUsage(turnLog.map((t) => t.llm.usage));
    const rec: CaseRecord = {
      n: c.n,
      id: c.id,
      category: c.category,
      title: c.title,
      status: g.status,
      reasons: g.reasons,
      warnings: g.warnings,
      ...(outcome?.behaviour ? { behaviour: outcome.behaviour } : {}),
      ...(outcome?.notes?.length ? { notes: outcome.notes } : {}),
      ms,
      tools: turnLog.flatMap((t) => t.tools.map((x) => x.name)),
      toolCalls: turnLog.flatMap((t, k) => t.tools.map((x) => ({ turn: k + 1, name: x.name, input: excerpt(JSON.stringify(x.input), 200, secrets), error: x.error ? red(x.error).slice(0, 200) : null }))),
      approvals: turnLog.flatMap((t, k) => t.approvals.map((a) => ({ turn: k + 1, ...a }))),
      steps: turnLog.map((t) => t.steps),
      firstTokenMs: turnLog[0]?.firstTokenMs ?? null,
      llm: { calls: turnLog.reduce((n, t) => n + t.llm.calls, 0), finishReasons: turnLog.flatMap((t) => t.llm.finishReasons), usage },
      tokens: {
        streamEvents: turnLog.reduce((n, t) => n + t.tokenEvents, 0),
        streamedChars: turnLog.reduce((n, t) => n + t.streamed.length, 0),
        answerChars: turnLog.reduce((n, t) => n + t.answer.length, 0),
        estOutputTokens: Math.round(turnLog.reduce((n, t) => n + t.answer.length, 0) / 4),
      },
      answerExcerpt: excerpt(last?.answer ?? "", 300, secrets),
      turns: turnLog.map((t) => ({
        message: excerpt(t.message, 120, secrets),
        answerExcerpt: excerpt(t.answer, 300, secrets),
        tools: t.tools.map((x) => x.name),
        steps: t.steps,
        ms: t.ms,
        budget: t.budget,
        errors: t.errors,
      })),
      assertions,
    };
    records.push(rec);
    const why = rec.status === "FAIL" ? `  <- ${rec.reasons[0]}` : rec.behaviour ? `  (${rec.behaviour})` : "";
    console.log(`${tag} ${rec.status.padEnd(4)}  ${(ms / 1000).toFixed(1)}s  tools=[${rec.tools.join(",")}]${why}`);
  }

  const summary = summarize(records.map((r) => ({ id: r.id, category: r.category, status: r.status, ms: r.ms })));
  summary.totalMs = Date.now() - runStart;

  console.log("");
  console.log(
    formatTable(
      ["#", "case", "category", "result", "tools", "steps", "time", "llm", "notes"],
      records.map((r) => [
        String(r.n),
        r.id,
        r.category,
        r.status,
        r.tools.length ? [...new Set(r.tools)].join(",") : "-",
        r.steps.length ? r.steps.join("+") : "-",
        r.status === "SKIP" ? "-" : `${(r.ms / 1000).toFixed(1)}s`,
        r.status === "SKIP" ? "-" : String(r.llm.calls || "?"),
        r.status === "FAIL" ? r.reasons.join("; ") : r.status === "SKIP" ? r.reasons[0] ?? "" : [r.behaviour, ...r.warnings.map((w) => `warn: ${w}`)].filter(Boolean).join("; "),
      ]),
      90,
    ),
  );
  console.log("");
  console.log(
    `pass rate ${pct(summary.passRate)}  (PASS=${summary.pass} FAIL=${summary.fail} SKIP=${summary.skip})  model=${model}  total ${(summary.totalMs / 1000).toFixed(1)}s`,
  );
  console.log(
    "by category: " +
      Object.entries(summary.byCategory)
        .map(([k, v]) => `${k} ${pct(v.passRate)} (${v.pass}/${v.pass + v.fail}${v.skip ? `, ${v.skip} skip` : ""})`)
        .join(" | "),
  );
  for (const r of records.filter((x) => x.status === "FAIL")) {
    console.log(`\nFAIL ${r.id}: ${r.reasons.join("; ")}`);
    console.log(`  answer: ${r.answerExcerpt || "(empty)"}`);
  }
  if (backgroundErrors.length) console.log(`\nbackground errors (not attributed to a case): ${backgroundErrors.length}`);

  const now = new Date().toISOString();
  const dir = join(root, "data", "eval-live");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, reportFileName(now, model));
  const report = {
    meta: {
      startedAt: new Date(runStart).toISOString(),
      finishedAt: now,
      provider,
      model,
      modelOverride: args.model ?? null,
      webSearch: search,
      node: process.version,
      limits: {
        MAX_STEPS: cfg.MAX_STEPS,
        MAX_TOOL_CALLS_PER_TURN: cfg.MAX_TOOL_CALLS_PER_TURN,
        MAX_PARALLEL_TOOLS: cfg.MAX_PARALLEL_TOOLS,
        FORCE_SEARCH: cfg.FORCE_SEARCH,
      },
      timeoutMsPerTurnUnit: args.timeoutMs,
      only: args.only ?? null,
      maxCases: args.maxCases ?? null,
      providerTap: args.tap,
      tools: toolNames,
    },
    summary,
    results: records,
    backgroundErrors,
  };
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\nreport: ${relative(root, file)}`);
  return 0;
}

function sumUsage(list: (LlmUsage | null)[]): LlmUsage | null {
  const got = list.filter((u): u is LlmUsage => !!u);
  if (!got.length) return null;
  return got.reduce((a, u) => ({ inputTokens: a.inputTokens + u.inputTokens, outputTokens: a.outputTokens + u.outputTokens }), { inputTokens: 0, outputTokens: 0 });
}

function emptyRecord(c: LiveCase, status: Status, reasons: string[]): CaseRecord {
  return {
    n: c.n,
    id: c.id,
    category: c.category,
    title: c.title,
    status,
    reasons,
    warnings: [],
    ms: 0,
    tools: [],
    toolCalls: [],
    approvals: [],
    steps: [],
    firstTokenMs: null,
    llm: { calls: 0, finishReasons: [], usage: null },
    tokens: { streamEvents: 0, streamedChars: 0, answerChars: 0, estOutputTokens: 0 },
    answerExcerpt: "",
    turns: [],
    assertions: [],
  };
}

main().then(
  (code) => process.exit(code),
  (e) => {
    // Harness crash: report it without leaking anything key-shaped.
    console.error(`eval:live crashed: ${redact(e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 500)}`);
    process.exit(1);
  },
);
