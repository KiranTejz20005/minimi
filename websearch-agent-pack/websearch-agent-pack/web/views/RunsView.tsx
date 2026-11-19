import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type RunDetail, type RunStep, type RunSummary } from "../api";
import { approvals, usePendingApprovals } from "../chat/approvals";
import { IconAlert, IconBell, IconCheck, IconChat, IconExternal, IconGlobe, IconRuns, IconX } from "../shell/icons";
import { useToast } from "../shell/toast";
import { Empty, Spinner } from "../shell/ui";
import { errMsg, fmtMs, relTime, renderMd } from "../shell/util";

type Detail = { stage: string; label: string; sub: string; ms: number; tag?: string; queries?: { query: string; durationMs: number }[] };

function describeStep(s: RunStep): Detail {
  const d = (s.detail ?? {}) as Record<string, any>;
  switch (s.stage) {
    case "temporal":
      return { stage: s.stage, label: "Resolve time references", sub: d.refs ? `${d.refs} date reference${d.refs === 1 ? "" : "s"} found` : "No date references in the question", ms: s.duration_ms, tag: "temporal" };
    case "retrieve":
      return {
        stage: s.stage,
        label: "Recall from memory",
        sub: d.kind === "hit" ? `Found ${(d.ids ?? []).length} earlier answer${(d.ids ?? []).length === 1 ? "" : "s"}` : d.kind === "miss" ? "Nothing saved for that date" : "Not needed for this question",
        ms: s.duration_ms,
        tag: "memory",
      };
    case "search": {
      const queries = (d.queries ?? []) as { query: string; durationMs: number }[];
      return {
        stage: s.stage,
        label: d.parallel ? `Search the web (${queries.length} in parallel)` : "Search the web",
        sub: `Step ${d.step ?? d.batch ?? 1} · ${d.count ?? queries.length} ${(d.count ?? queries.length) === 1 ? "query" : "queries"}`,
        ms: s.duration_ms,
        tag: "web_search",
        queries,
      };
    }
    case "llm_step":
      return { stage: s.stage, label: "Reason and draft the answer", sub: `${d.steps ?? 1} model step${d.steps === 1 ? "" : "s"} · ${d.searches ?? 0} search${d.searches === 1 ? "" : "es"}`, ms: s.duration_ms, tag: "model" };
    case "citations":
      return { stage: s.stage, label: "Verify citations", sub: `${d.cited ?? 0} source${d.cited === 1 ? "" : "s"} cited`, ms: s.duration_ms, tag: "citations" };
    default:
      return { stage: s.stage, label: s.stage.replace(/_/g, " "), sub: "", ms: s.duration_ms };
  }
}

/** The backend records a turn as "ok" the moment it starts; no answer + no trace yet means it is still running. */
const isRunning = (r: { status: string; answer?: string; answer_preview?: string; steps?: number; duration_ms: number }) =>
  r.status === "ok" && !(r.answer ?? r.answer_preview) && !r.steps && r.duration_ms === 0;

const STATUS: Record<string, { label: string; tone: string }> = {
  running: { label: "Running", tone: "blue" },
  ok: { label: "Completed", tone: "green" },
  error: { label: "Failed", tone: "red" },
  aborted: { label: "Stopped", tone: "amber" },
};

export function RunsView({ selectedId, onSelect, onOpenChat }: { selectedId?: string; onSelect: (id: string | undefined) => void; onOpenChat: (conversationId: string) => void }) {
  const toast = useToast();
  const pending = usePendingApprovals();
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"input" | "sources">("input");

  const loadRuns = useCallback(async () => {
    try {
      setRuns((await api.runs()).runs);
    } catch (e) {
      toast(`Couldn't load runs: ${errMsg(e)}`, "error");
      setRuns((r) => r ?? []);
    }
  }, [toast]);

  useEffect(() => void loadRuns(), [loadRuns]);
  const anyRunning = !!runs?.some((r) => isRunning(r));
  const detailRunning = !!detail && isRunning({ ...detail, steps: detail.steps.length });
  // Keep things fresh while the agent is working or waiting on the user.
  useEffect(() => {
    if (!pending.length && !anyRunning && !detailRunning) return;
    const t = window.setInterval(() => {
      void loadRuns();
      if (selectedId) api.run(selectedId).then(setDetail).catch(() => {});
    }, 2500);
    return () => window.clearInterval(t);
  }, [pending.length, anyRunning, detailRunning, loadRuns, selectedId]);

  // Default to the newest run when nothing is selected.
  useEffect(() => {
    if (!selectedId && runs && runs.length) onSelect(runs[0]!.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs, selectedId]);

  useEffect(() => {
    setDetail(null);
    setDetailErr(null);
    if (!selectedId) return;
    let live = true;
    api
      .run(selectedId)
      .then((d) => live && setDetail(d))
      .catch((e) => live && setDetailErr(errMsg(e)));
    return () => {
      live = false;
    };
  }, [selectedId]);

  const decide = async (id: string, ok: boolean) => {
    try {
      await api.approve(id, ok);
    } catch (e) {
      toast(errMsg(e), "error"); // typically: already timed out
    } finally {
      approvals.remove(id);
    }
  };

  const steps = useMemo(() => (detail ? detail.steps.map(describeStep) : []), [detail]);
  const toolRows = useMemo(() => steps.filter((s) => s.stage === "search").flatMap((s) => s.queries ?? []), [steps]);

  return (
    <div className="view runs-view">
      <aside className="runs-list" aria-label="Runs">
        <div className="runs-list-head">
          <h1>Runs</h1>
          <span className="count">{runs?.length ?? 0}</span>
        </div>
        {runs === null ? (
          <div className="loading-row"><Spinner /></div>
        ) : runs.length === 0 ? (
          <Empty icon={<IconRuns size={22} />} title="No runs yet">Every question you ask becomes a run you can inspect here.</Empty>
        ) : (
          <ul>
            {runs.map((r) => (
              <li key={r.id}>
                <button type="button" className="run-row" data-active={r.id === selectedId || undefined} aria-current={r.id === selectedId ? "true" : undefined} onClick={() => onSelect(r.id)}>
                  <span className="dot" data-tone={STATUS[isRunning(r) ? "running" : r.status]?.tone ?? "green"} aria-label={STATUS[isRunning(r) ? "running" : r.status]?.label} />
                  <span className="run-main">
                    <strong>{r.question}</strong>
                    <small>
                      {r.tool_calls} tool call{r.tool_calls === 1 ? "" : "s"} · {fmtMs(r.duration_ms)} · {relTime(r.created_at)}
                    </small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="run-detail" aria-label="Run detail" aria-busy={!detail && !detailErr && !!selectedId}>
        {!selectedId ? (
          <Empty icon={<IconRuns size={22} />} title="Select a run">Pick a run on the left to see how it was answered.</Empty>
        ) : detailErr ? (
          <Empty icon={<IconAlert size={22} />} title="Couldn't load this run">{detailErr}</Empty>
        ) : !detail ? (
          <div className="loading-row"><Spinner /></div>
        ) : (
          <div className="run-inner">
            <div className="crumbs">
              <span>Runs</span>
              <span>/</span>
              <strong>{detail.question.length > 60 ? detail.question.slice(0, 60) + "…" : detail.question}</strong>
              <span className="pill" data-tone={STATUS[detailRunning ? "running" : detail.status]?.tone}>{STATUS[detailRunning ? "running" : detail.status]?.label}</span>
              <span className="grow" />
              <button type="button" className="btn" onClick={() => onOpenChat(detail.conversation_id)}>
                <IconChat size={14} /> Open chat
              </button>
            </div>
            <h2 className="run-title">{detail.question}</h2>
            <p className="small muted">
              {detail.conversation_title} · started {relTime(detail.created_at)}
            </p>

            <dl className="stats">
              <Stat label="Steps" value={String(steps.length)} />
              <Stat label="Tool calls" value={String(detail.tool_calls)} />
              <Stat label="Time" value={fmtMs(detail.duration_ms)} />
              <Stat label="Sources" value={String(detail.sources.length)} />
            </dl>

            <Card title="Plan" meta={`${steps.length} steps`}>
              {steps.length ? (
                <ol className="plan">
                  {steps.map((s, i) => (
                    <li key={i}>
                      <span className="step-check" data-tone={detail.status === "ok" ? "green" : "amber"}>
                        <IconCheck size={11} />
                      </span>
                      <div className="step-body">
                        <strong>{s.label}</strong>
                        <small>{s.sub}</small>
                        {s.queries && s.queries.length > 0 && (
                          <ul className="step-queries">
                            {s.queries.map((q, j) => (
                              <li key={j}>
                                <IconGlobe size={12} /> <span>{q.query}</span> <em>{fmtMs(q.durationMs)}</em>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <span className="step-time">{fmtMs(s.ms)}</span>
                      {s.tag && <code className="step-tag">{s.tag}</code>}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="muted small">No trace was recorded for this run.</p>
              )}
            </Card>

            <Card title="Activity" meta={`${toolRows.length} of ${detail.tool_calls}`}>
              {toolRows.length ? (
                <ul className="activity">
                  {toolRows.map((q, i) => (
                    <li key={i}>
                      <span className="step-check" data-tone="green"><IconCheck size={11} /></span>
                      <span className="act-text">web_search · {q.query}</span>
                      <span className="step-time">{fmtMs(q.durationMs)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">This answer didn't need any tools.</p>
              )}
            </Card>

            <Card title="Answer">
              {detail.answer ? (
                <div className="md" dangerouslySetInnerHTML={{ __html: renderMd(detail.answer) }} />
              ) : (
                <p className="muted small">{detailRunning ? "Still working on it…" : "No answer was saved."}</p>
              )}
            </Card>
          </div>
        )}
      </section>

      <aside className="runs-side" aria-label="Side panel">
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "input"} onClick={() => setTab("input")}>
            <IconBell size={13} /> Needs your input {pending.length > 0 && <span className="badge">{pending.length}</span>}
          </button>
          <button type="button" role="tab" aria-selected={tab === "sources"} onClick={() => setTab("sources")}>
            Sources {detail ? <span className="count">{detail.sources.length}</span> : null}
          </button>
        </div>
        <div className="side-body" role="tabpanel">
          {tab === "input" ? (
            pending.length === 0 ? (
              <Empty icon={<IconBell size={20} />} title="Nothing needs you yet">
                With “Request approval” on in the chat composer, the agent asks here before it searches the web.
              </Empty>
            ) : (
              <ul className="approvals">
                {pending.map((a) => (
                  <li key={a.id} className="approval">
                    <p className="eyebrow">Web search · waiting for you</p>
                    <ul>
                      {a.queries.map((q, i) => (
                        <li key={i}>
                          <IconGlobe size={12} /> {q}
                        </li>
                      ))}
                    </ul>
                    <div className="approval-actions">
                      <button type="button" className="btn" onClick={() => void decide(a.id, false)}>
                        <IconX size={13} /> Decline
                      </button>
                      <button type="button" className="btn btn-primary" onClick={() => void decide(a.id, true)}>
                        <IconCheck size={13} /> Approve
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )
          ) : !detail ? (
            <Empty title="No run selected" />
          ) : detail.sources.length === 0 ? (
            <Empty title="No sources">This run didn't cite any web pages.</Empty>
          ) : (
            <ul className="sources-list">
              {detail.sources.map((s) => (
                <li key={s.n}>
                  <a href={s.url} target="_blank" rel="noopener noreferrer">
                    <span className="src-n">{s.n}</span>
                    <span className="src-text">
                      <strong>{s.title}</strong>
                      <small>{s.host}</small>
                    </span>
                    <IconExternal size={13} />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Card({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <section className="card">
      <header>
        <h3>{title}</h3>
        {meta && <span className="muted small">{meta}</span>}
      </header>
      {children}
    </section>
  );
}
