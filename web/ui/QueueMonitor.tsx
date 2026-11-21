import { useId, type ReactNode } from "react";

/*
 * Queue Monitor – a live panel for anything that runs jobs through a pool of workers:
 * what is waiting, what each worker is doing, how much finished or failed, plus a
 * queue-depth sparkline. Self-contained (styles injected below), themed with --aui-* tokens.
 * Used by: AnalyticsView (background memory-digest queue), RightPanel (parallel tool calls).
 * Every stat is optional: pass `null`/omit it and its cell disappears.
 */

export type QueueJob = { id: string; label: string; meta?: string };

export type QueueWorker = {
  id: string;
  name: string;
  /** Small mark shown before the name (a 16px svg or img) */
  icon?: ReactNode;
  /** What the worker is on right now; null/undefined = idle */
  job?: { label: string; state?: "running" | "paused" } | null;
};

export type QueueMonitorProps = {
  title?: string;
  /** Queue name, shown quietly next to the title */
  name?: string;
  status?: { label: string; tone?: "amber" | "green" | "red" | "blue" } | null;
  waiting: QueueJob[];
  workers: QueueWorker[];
  /** Worker slots; defaults to workers.length */
  capacity?: number;
  done: number;
  failed: number;
  throughputPerMin?: number | null;
  /** 95th percentile wait, ms */
  waitP95Ms?: number | null;
  /** Queue depth samples, oldest first. Omit to hide the chart. */
  history?: number[];
  historyStart?: string;
  historyEnd?: string;
  /** Shows a Pause/Resume button when provided */
  onTogglePause?: () => void;
  paused?: boolean;
  /** Stacks everything in one column and drops the chart (side panels) */
  compact?: boolean;
  /** Text for an empty queue */
  emptyQueue?: string;
  className?: string;
};

const num = new Intl.NumberFormat("en");

function fmtWait(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 90) return `${Math.round(s)}s`;
  return `${Math.round(s / 60)}m`;
}

export function QueueMonitor({
  title = "Queue",
  name,
  status,
  waiting,
  workers,
  capacity,
  done,
  failed,
  throughputPerMin,
  waitP95Ms,
  history,
  historyStart = "",
  historyEnd = "now",
  onTogglePause,
  paused = false,
  compact = false,
  emptyQueue = "Nothing waiting",
  className,
}: QueueMonitorProps) {
  const slots = Math.max(capacity ?? workers.length, workers.length);
  const running = workers.filter((w) => w.job).length;
  const idle = slots - workers.length;
  const shown = compact ? 4 : 6;

  return (
    <section className={["ui-qm", className].filter(Boolean).join(" ")} data-compact={compact || undefined} aria-label={`${title} monitor`}>
      <style href="ui-queue-monitor" precedence="default">
        {css}
      </style>

      <header className="ui-qm__head">
        <svg className="ui-qm__mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M2 4h12M2 8h12M2 12h8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <h3 className="ui-qm__title">{title}</h3>
        {name && <span className="ui-qm__name">{name}</span>}
        {status && (
          <span className="ui-qm__pill" data-tone={status.tone ?? "blue"}>
            <i />
            {status.label}
          </span>
        )}
        <span className="ui-qm__grow" />
        {onTogglePause && (
          <button type="button" className="ui-qm__btn" onClick={onTogglePause} aria-pressed={paused}>
            {paused ? "Resume" : "Pause"}
          </button>
        )}
      </header>

      <dl className="ui-qm__stats">
        <Stat label="Waiting" value={num.format(waiting.length)} />
        <Stat label="Running" value={num.format(running)} unit={`/${num.format(slots)}`} />
        {throughputPerMin != null && <Stat label="Throughput" value={num.format(throughputPerMin)} unit="/min" />}
        {waitP95Ms != null && <Stat label="Wait p95" value={fmtWait(waitP95Ms)} />}
      </dl>

      <div className="ui-qm__body">
        <div className="ui-qm__col">
          <h4 className="ui-qm__label">
            Queue <b>{num.format(waiting.length)}</b>
          </h4>
          {waiting.length === 0 ? (
            <p className="ui-qm__empty">{emptyQueue}</p>
          ) : (
            <ul className="ui-qm__list">
              {waiting.slice(0, shown).map((j) => (
                <li key={j.id} className="ui-qm__job" title={j.label}>
                  <span className="ui-qm__jobicon" aria-hidden="true" />
                  <span className="ui-qm__jobtext">{j.label}</span>
                  {j.meta && <span className="ui-qm__meta">{j.meta}</span>}
                </li>
              ))}
              {waiting.length > shown && <li className="ui-qm__more">+{waiting.length - shown} more</li>}
            </ul>
          )}
        </div>

        <div className="ui-qm__col">
          <h4 className="ui-qm__label">
            Workers{" "}
            <b>
              {running}/{slots}
            </b>
          </h4>
          <ul className="ui-qm__list">
            {workers.map((w) => (
              <li key={w.id} className="ui-qm__worker" data-busy={w.job ? w.job.state ?? "running" : undefined}>
                <span className="ui-qm__wname">
                  {w.icon && <span className="ui-qm__wicon">{w.icon}</span>}
                  <span>{w.name}</span>
                </span>
                {w.job ? (
                  <span className="ui-qm__task" title={w.job.label}>
                    <i className="ui-qm__spin" aria-hidden="true" />
                    <span className="ui-qm__tasktext">{w.job.label}</span>
                    {w.job.state === "paused" && <em>Paused</em>}
                  </span>
                ) : (
                  <span className="ui-qm__idle">Idle</span>
                )}
              </li>
            ))}
            {Array.from({ length: idle }).map((_, i) => (
              <li key={`idle-${i}`} className="ui-qm__worker">
                <span className="ui-qm__wname">
                  <span>Worker {workers.length + i + 1}</span>
                </span>
                <span className="ui-qm__idle">Idle</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="ui-qm__totals">
          <div className="ui-qm__total" data-tone="green">
            <span className="ui-qm__tlabel">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
              Done
            </span>
            <strong>{num.format(done)}</strong>
          </div>
          <div className="ui-qm__total" data-tone="red">
            <span className="ui-qm__tlabel">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              Failed
            </span>
            <strong>{num.format(failed)}</strong>
          </div>
        </div>
      </div>

      {history && history.length > 1 && !compact && <DepthChart values={history} start={historyStart} end={historyEnd} />}
    </section>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="ui-qm__stat">
      <dt>{label}</dt>
      <dd>
        {value}
        {unit && <small>{unit}</small>}
      </dd>
    </div>
  );
}

const W = 600;
const H = 80;

function DepthChart({ values, start, end }: { values: number[]; start: string; end: string }) {
  const gid = useId();
  const peak = Math.max(...values, 0);
  const top = Math.max(2, peak % 2 ? peak + 1 : peak);
  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) => H - (v / top) * H;
  const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${W} ${H} L0 ${H} Z`;
  const last = values[values.length - 1]!;
  return (
    <div className="ui-qm__chart">
      <h4 className="ui-qm__label">Queue depth</h4>
      <div className="ui-qm__plot">
        <span className="ui-qm__y ui-qm__y--top">{top}</span>
        <span className="ui-qm__y ui-qm__y--mid">{top / 2}</span>
        <span className="ui-qm__y ui-qm__y--bot">0</span>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Queue depth over time, now ${last}, peak ${peak}`}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--ui-qm-line)" stopOpacity="0.32" />
              <stop offset="100%" stopColor="var(--ui-qm-line)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="ui-qm__grid" vectorEffect="non-scaling-stroke" />
          <path d={area} fill={`url(#${gid})`} />
          <path d={line} className="ui-qm__line" vectorEffect="non-scaling-stroke" />
        </svg>
        <i className="ui-qm__now" style={{ top: `${(y(last) / H) * 100}%` }} />
      </div>
      <div className="ui-qm__axis">
        <span>{start}</span>
        <span>{end}</span>
      </div>
    </div>
  );
}

/* ---------- Styles ---------- */

const css = /* css */ `
.ui-qm {
  --ui-qm-card: var(--aui-surface, #141415);
  --ui-qm-inner: var(--aui-subtle, rgba(255, 255, 255, 0.04));
  --ui-qm-ink: var(--aui-ink, #f6f6f7);
  --ui-qm-muted: var(--aui-muted, #a3a3ac);
  --ui-qm-faint: var(--aui-placeholder, #7a7a83);
  --ui-qm-border: var(--aui-border, #2b2b30);
  --ui-qm-line: var(--aui-blue, #4da3ff);
  --ui-qm-green: var(--aui-green, #4cc38a);
  --ui-qm-red: var(--aui-red, #ef6461);
  --ui-qm-amber: var(--aui-amber, #f5a524);
  --ui-qm-focus: var(--aui-focus, rgba(77, 163, 255, 0.8));
  container-type: inline-size;
  box-sizing: border-box;
  width: 100%;
  background: var(--ui-qm-card);
  border: 1px solid var(--ui-qm-border);
  border-radius: var(--aui-radius, 10px);
  font-family: var(--aui-font, ui-sans-serif, system-ui, sans-serif);
  font-size: 13px;
  line-height: 18px;
  color: var(--ui-qm-ink);
  -webkit-font-smoothing: antialiased;
  overflow: hidden;
}
.ui-qm *, .ui-qm *::before, .ui-qm *::after { box-sizing: border-box; }
.ui-qm h3, .ui-qm h4, .ui-qm p, .ui-qm dl, .ui-qm dd, .ui-qm ul { margin: 0; padding: 0; }
.ui-qm ul { list-style: none; }

.ui-qm__head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; }
.ui-qm__mark { color: var(--ui-qm-line); flex: none; }
.ui-qm__title { font-size: 13px; font-weight: 600; }
.ui-qm__name { color: var(--ui-qm-muted); font-size: 12px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui-qm__grow { flex: 1; }
.ui-qm__pill { display: inline-flex; align-items: center; gap: 6px; height: 20px; padding: 0 8px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap;
  color: var(--ui-qm-line); background: color-mix(in srgb, var(--ui-qm-line) 14%, transparent); }
.ui-qm__pill i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.ui-qm__pill[data-tone="green"] { color: var(--ui-qm-green); background: color-mix(in srgb, var(--ui-qm-green) 14%, transparent); }
.ui-qm__pill[data-tone="red"] { color: var(--ui-qm-red); background: color-mix(in srgb, var(--ui-qm-red) 14%, transparent); }
.ui-qm__pill[data-tone="amber"] { color: var(--ui-qm-amber); background: color-mix(in srgb, var(--ui-qm-amber) 14%, transparent); }
.ui-qm__btn { height: 26px; padding: 0 10px; border-radius: 6px; border: 1px solid var(--ui-qm-border); background: transparent; color: var(--ui-qm-ink); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; transition: background-color 120ms ease-out; }
.ui-qm__btn:focus-visible { outline: 2px solid var(--ui-qm-focus); outline-offset: 1px; }
@media (hover: hover) { .ui-qm__btn:hover { background: var(--ui-qm-inner); } }

.ui-qm__stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); border-top: 1px solid var(--ui-qm-border); }
.ui-qm__stat { padding: 10px 14px; border-left: 1px solid var(--ui-qm-border); min-width: 0; }
.ui-qm__stat:first-child { border-left: 0; }
.ui-qm__stat dt { font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ui-qm-muted); }
.ui-qm__stat dd { margin-top: 2px; font-size: 18px; font-weight: 600; line-height: 24px; font-variant-numeric: tabular-nums; }
.ui-qm__stat small { margin-left: 2px; font-size: 12px; font-weight: 500; color: var(--ui-qm-muted); }

.ui-qm__body { display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.5fr) 128px; gap: 14px; padding: 14px; border-top: 1px solid var(--ui-qm-border); }
.ui-qm__col { min-width: 0; }
.ui-qm__label { margin-bottom: 8px; font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ui-qm-muted); }
.ui-qm__label b { margin-left: 4px; color: var(--ui-qm-ink); font-weight: 600; }
.ui-qm__list { display: flex; flex-direction: column; gap: 6px; }
.ui-qm__empty, .ui-qm__idle, .ui-qm__more { color: var(--ui-qm-faint); font-size: 12px; }

.ui-qm__job, .ui-qm__worker { display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 6px 10px; border-radius: 8px; background: var(--ui-qm-inner); border: 1px solid var(--ui-qm-border); min-width: 0; }
.ui-qm__jobicon { flex: none; width: 14px; height: 14px; border-radius: 4px; background: color-mix(in srgb, var(--ui-qm-line) 22%, transparent); }
.ui-qm__jobtext, .ui-qm__tasktext { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui-qm__meta { margin-left: auto; flex: none; color: var(--ui-qm-muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.ui-qm__worker { justify-content: space-between; }
.ui-qm__wname { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; white-space: nowrap; flex: none; }
.ui-qm__wicon { display: grid; place-items: center; width: 16px; height: 16px; }
.ui-qm__wicon > :is(svg, img) { width: 100%; height: 100%; object-fit: contain; }
.ui-qm__task { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 62%; padding: 2px 8px; border-radius: 6px; font-size: 12px; background: color-mix(in srgb, var(--ui-qm-line) 14%, transparent); }
.ui-qm__task em { margin-left: 4px; font-style: normal; color: var(--ui-qm-muted); flex: none; }
.ui-qm__spin { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--ui-qm-line); animation: ui-qm-pulse 1.4s ease-in-out infinite; }
.ui-qm__worker[data-busy="paused"] .ui-qm__spin { animation: none; background: var(--ui-qm-amber); }

.ui-qm__totals { display: flex; flex-direction: column; gap: 8px; }
.ui-qm__total { flex: 1; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--ui-qm-border); background: var(--ui-qm-inner); }
.ui-qm__tlabel { display: inline-flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ui-qm-muted); }
.ui-qm__tlabel svg { width: 14px; height: 14px; padding: 2px; border-radius: 4px; }
.ui-qm__total[data-tone="green"] .ui-qm__tlabel svg { color: var(--ui-qm-green); background: color-mix(in srgb, var(--ui-qm-green) 16%, transparent); }
.ui-qm__total[data-tone="red"] .ui-qm__tlabel svg { color: var(--ui-qm-red); background: color-mix(in srgb, var(--ui-qm-red) 16%, transparent); }
.ui-qm__total strong { display: block; margin-top: 4px; font-size: 22px; line-height: 28px; font-weight: 600; font-variant-numeric: tabular-nums; }
.ui-qm__total[data-tone="red"] strong { color: var(--ui-qm-red); }

.ui-qm__chart { padding: 12px 14px 12px; border-top: 1px solid var(--ui-qm-border); }
.ui-qm__plot { position: relative; height: 96px; margin-left: 24px; }
.ui-qm__plot svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.ui-qm__line { fill: none; stroke: var(--ui-qm-line); stroke-width: 1.5; stroke-linejoin: round; }
.ui-qm__grid { stroke: var(--ui-qm-border); stroke-width: 1; stroke-dasharray: 2 4; }
.ui-qm__y { position: absolute; left: -24px; width: 18px; text-align: right; font-size: 11px; line-height: 12px; color: var(--ui-qm-muted); font-variant-numeric: tabular-nums; }
.ui-qm__y--top { top: -2px; } .ui-qm__y--mid { top: calc(50% - 6px); } .ui-qm__y--bot { bottom: -2px; }
.ui-qm__now { position: absolute; right: -3px; width: 7px; height: 7px; margin-top: -3px; border-radius: 50%; background: var(--ui-qm-line); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ui-qm-line) 25%, transparent); }
.ui-qm__axis { display: flex; justify-content: space-between; margin: 8px 0 0 24px; font-size: 11px; color: var(--ui-qm-muted); }

/* Narrow containers (side panels): one column, 2-up stats */
.ui-qm[data-compact] .ui-qm__stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.ui-qm[data-compact] .ui-qm__stat:nth-child(odd) { border-left: 0; }
.ui-qm[data-compact] .ui-qm__stat:nth-child(n + 3) { border-top: 1px solid var(--ui-qm-border); }
.ui-qm[data-compact] .ui-qm__body { grid-template-columns: minmax(0, 1fr); }
.ui-qm[data-compact] .ui-qm__totals { flex-direction: row; }
.ui-qm[data-compact] .ui-qm__task { max-width: 70%; }
@container (max-width: 520px) {
  .ui-qm__body { grid-template-columns: minmax(0, 1fr); }
  .ui-qm__totals { flex-direction: row; }
}

@keyframes ui-qm-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.8); } }
@media (prefers-reduced-motion: reduce) { .ui-qm *, .ui-qm *::before { animation: none !important; transition-duration: 1ms !important; } }
`;
