import { useId, useMemo, useState, type ReactNode } from "react";
import type { AttachmentRef, Integrations, SourceRef } from "../api";
import { ProgressTracker, QueueMonitor } from "../ui";
import type { ApprovalData, SearchCardData, Toast } from "./types";
import { approvalLines, approvalLineText, toolMeta } from "./tools";
import { Check, Chevron, Close, Copy, Download, FileIcon, Spinner } from "./icons";
import { copyText, hostOf, plainText, slug } from "./markdown";
import { DocViewer, type DocTab } from "./DocViewer";

export interface Step {
  id: string;
  label: string;
  sub?: string;
  tag?: string;
  time?: string;
  state: "done" | "running" | "pending" | "error";
}

interface Props {
  open: boolean;
  onClose: () => void;
  steps: Step[];
  title: string;
  answer: string;
  sources: SourceRef[];
  uploads: AttachmentRef[];
  integrations: Integrations | null;
  webPages: number;
  skills: string[];
  /** Tool calls of the latest answer; drives the Tool queue section. */
  toolCards?: SearchCardData[];
  /** An approval the agent is waiting on; its queries show as waiting jobs. */
  pendingApproval?: ApprovalData | null;
  onOpenIntegrations: () => void;
  toast: Toast;
}

function Section({ title, count, defaultOpen = true, children }: { title: string; count?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section className="rp__sec" data-open={open ? "" : undefined}>
      <button type="button" className="rp__sechead" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <span>{title}</span>
        {count !== undefined && <span className="rp__count">{count}</span>}
        <span className="rp__chev"><Chevron /></span>
      </button>
      <div id={id} className="rp__fold" inert={!open}>
        <div className="rp__clip">{children}</div>
      </div>
    </section>
  );
}

function StepDot({ state }: { state: Step["state"] }) {
  if (state === "running") return <span className="st__dot st__dot--run"><Spinner size={13} /></span>;
  if (state === "done") return <span className="st__dot st__dot--done"><Check size={10} /></span>;
  if (state === "error") return <span className="st__dot st__dot--err"><Close size={10} /></span>;
  return <span className="st__dot st__dot--pending" />;
}

function Row({ icon, label, right, children, defaultOpen = false }: { icon: ReactNode; label: string; right?: ReactNode; children?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const expandable = !!children;
  return (
    <div className="ur" data-open={open ? "" : undefined}>
      <button type="button" className="ur__head" disabled={!expandable} aria-expanded={expandable ? open : undefined} aria-controls={expandable ? id : undefined} onClick={() => setOpen((o) => !o)}>
        <span className="ur__icon">{icon}</span>
        <span className="ur__label">{label}</span>
        <span className="ur__right">{right}</span>
        {expandable && <span className="rp__chev"><Chevron size={12} /></span>}
      </button>
      {expandable && (
        <div id={id} className="rp__fold" inert={!open}>
          <div className="rp__clip"><div className="ur__body">{children}</div></div>
        </div>
      )}
    </div>
  );
}

/** Latest turn's tool calls as a worker pool: slots = widest parallel batch, running calls fill them. */
function ToolQueue({ cards, approval }: { cards: SearchCardData[]; approval?: ApprovalData | null }) {
  const running = cards.filter((c) => c.status === "running");
  const widest = cards.reduce<Record<number, number>>((m, c) => ((m[c.batch] = (m[c.batch] ?? 0) + 1), m), {});
  const capacity = Math.max(1, running.length, ...Object.values(widest));
  const waiting = approval?.status === "pending" ? approvalLines(approval.queries, approval.actions).map((l, i) => ({ id: `ap${i}`, label: approvalLineText(l), meta: "needs approval" })) : [];
  const done = cards.filter((c) => c.status === "done").length;
  const failed = cards.filter((c) => c.status === "error" || c.status === "stopped").length;
  const busy = running.length > 0 || waiting.length > 0;
  return (
    <QueueMonitor
      compact
      title="Tools"
      name="this answer"
      status={waiting.length ? { label: "Waiting on you", tone: "amber" } : running.length ? { label: "Running", tone: "blue" } : { label: "Finished", tone: "green" }}
      waiting={waiting}
      workers={Array.from({ length: capacity }, (_, i) => {
        const c = running[i];
        return { id: `t${i}`, name: c ? toolMeta(c.tool).title : `Slot ${i + 1}`, job: c ? { label: c.query } : null };
      })}
      capacity={capacity}
      done={done}
      failed={failed}
      emptyQueue={busy ? "Nothing else waiting" : "Nothing waiting"}
    />
  );
}

export function RightPanel({ open, onClose, steps, title, answer, sources, uploads, integrations, webPages, skills, toolCards = [], pendingApproval, onOpenIntegrations, toast }: Props) {
  const [showEarlier, setShowEarlier] = useState(false);
  // Documents opened beside the chat (answer as .md, uploads, outputs). "details" = the run overview.
  const [docs, setDocs] = useState<DocTab[]>([]);
  const [view, setView] = useState<string>("details");
  const openDoc = (d: DocTab) => {
    setDocs((cur) => (cur.some((x) => x.id === d.id) ? cur.map((x) => (x.id === d.id && d.content !== undefined ? d : x)) : [...cur, d]));
    setView(d.id);
  };
  const closeDoc = (id: string) => {
    setDocs((cur) => cur.filter((x) => x.id !== id));
    setView((v) => (v === id ? "details" : v));
  };
  const showDoc = docs.find((d) => d.id === view);
  const answerDoc = (): DocTab => ({ id: "answer", name: `${slug(title)}.md`, content: `# ${title || "Answer"}\n\n${answer}\n` });
  const earlier = steps.length > 4 ? steps.slice(0, steps.length - 3) : [];
  const visible = steps.length > 4 ? steps.slice(steps.length - 3) : steps;
  const trackerSteps = useMemo(
    () => steps.map((s) => ({ id: s.id, label: s.label, done: s.state === "done" })),
    [steps],
  );

  const copy = async () => {
    const ok = await copyText(answer);
    toast(ok ? "Answer copied" : "Couldn't copy", ok ? "success" : "error");
  };
  const download = () => {
    const blob = new Blob([`# ${title || "Answer"}\n\n${answer}\n`], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug(title)}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const connectors = integrations
    ? [
        { name: integrations.llm.provider, sub: integrations.llm.mainModel.split("/").pop() ?? "", ok: integrations.llm.connected },
        { name: integrations.search.provider, sub: integrations.search.hasTavilyKey ? "API key" : "no key needed", ok: integrations.search.connected },
      ]
    : [];

  const stepEl = (s: Step) => (
    <li key={s.id} className="st" data-state={s.state}>
      <StepDot state={s.state} />
      <div className="st__main">
        <div className="st__row">
          <span className="st__label">{s.label}</span>
          {s.time && <span className="st__time">{s.time}</span>}
        </div>
        {(s.sub || s.tag) && (
          <div className="st__sub">
            {s.sub && <span>{s.sub}</span>}
            {s.tag && <code>{s.tag}</code>}
          </div>
        )}
      </div>
    </li>
  );

  return (
    <aside className="rp" aria-label="Run details" data-open={open ? "" : undefined} data-doc={showDoc ? "" : undefined} inert={!open}>
      <div className="rp__inner">
        <div className="rp__top">
          {docs.length > 0 ? (
            <div className="seg" role="tablist" aria-label="Panel view">
              <button type="button" role="tab" aria-selected={!showDoc} aria-pressed={!showDoc} onClick={() => setView("details")}>Details</button>
              <button type="button" role="tab" aria-selected={!!showDoc} aria-pressed={!!showDoc} onClick={() => setView(docs[docs.length - 1]!.id)}>Documents {docs.length}</button>
            </div>
          ) : (
            <h2>Run details</h2>
          )}
          <button type="button" className="icon-btn" aria-label="Close panel" onClick={onClose}><Close /></button>
        </div>

        {showDoc && (
          <DocViewer tabs={docs} activeId={showDoc.id} onSelect={setView} onClose={closeDoc} sources={sources} toast={toast} />
        )}
        <div hidden={!!showDoc}>

        <Section title="Progress">
          {steps.length === 0 ? (
            <p className="rp__empty">Steps appear here as the agent works.</p>
          ) : (
            <>
              <ProgressTracker title="" steps={trackerSteps} readOnly showList={false} className="rp__tracker" />
              <ol className="st__list">
                {earlier.length > 0 && (
                  <li className="st st--earlier">
                    <button type="button" className="st__earlier" aria-expanded={showEarlier} onClick={() => setShowEarlier((v) => !v)}>
                      {earlier.length} earlier step{earlier.length === 1 ? "" : "s"}
                      <Chevron size={12} />
                    </button>
                  </li>
                )}
                {showEarlier && earlier.map(stepEl)}
                {visible.map(stepEl)}
              </ol>
            </>
          )}
        </Section>

        {(toolCards.length > 1 || (toolCards.length > 0 && toolCards.some((c) => c.status === "running")) || pendingApproval?.status === "pending") && (
          <Section title="Tool queue" count={toolCards.filter((c) => c.status === "running").length || undefined}>
            <ToolQueue cards={toolCards} approval={pendingApproval} />
          </Section>
        )}

        <Section title="Outputs">
          {answer.trim() ? (
            <>
              <div className="out">
                <div className="out__title">{title || "Answer"}</div>
                <p className="out__prev">{plainText(answer).slice(0, 150)}{plainText(answer).length > 150 ? "…" : ""}</p>
                <div className="out__actions">
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => void copy()}><Copy /> Copy</button>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={download}><Download /> Download .md</button>
                </div>
              </div>
              <ul className="ol">
                <li>
                  <button type="button" className="ol__row" onClick={() => openDoc(answerDoc())} title="Open in viewer">
                    <span className="ol__icon"><FileIcon /></span>
                    <span className="ol__name">{slug(title)}.md</span>
                    <span className="ol__type">Open</span>
                  </button>
                </li>
                {sources.map((s) => (
                  <li key={s.n}>
                    <a className="ol__row" href={s.url} target="_blank" rel="noopener noreferrer" title={s.title}>
                      <span className="ol__fav" aria-hidden="true">{hostOf(s.url).charAt(0).toUpperCase()}</span>
                      <span className="ol__name">{s.title}</span>
                      <span className="ol__type">{hostOf(s.url)}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="rp__empty">The answer and its sources show up here.</p>
          )}
        </Section>

        <Section title="Used in this session">
          <div className="used">
            <Row
              icon={<FileIcon />}
              label="Uploads"
              right={uploads.length ? <span className="ur__txt">{uploads[0].name}{uploads.length > 1 ? ` +${uploads.length - 1}` : ""}</span> : <span className="ur__txt ur__txt--dim">None</span>}
            >
              {uploads.length > 0 && (
                <ul className="ur__list">
                  {uploads.map((u) => (
                    <li key={u.id}>
                      <button type="button" className="ur__link" onClick={() => openDoc({ id: `f-${u.id}`, name: u.name, fileId: u.id, kind: u.kind })} title="Open in viewer">
                        <span className="ur__kind">{u.kind}</span>{u.name}
                      </button>
                      <small>{u.size < 1024 ? `${u.size} B` : `${(u.size / 1024).toFixed(1)} KB`}</small>
                    </li>
                  ))}
                </ul>
              )}
            </Row>
            <Row
              icon={<span className="ur__plug" />}
              label="Connectors"
              right={<span className="ur__dots">{connectors.map((c) => <i key={c.name} className="tc__dot" data-ok={c.ok ? "" : undefined} title={c.name} />)}</span>}
              defaultOpen
            >
              <ul className="ur__list">
                {connectors.map((c) => (
                  <li key={c.name}><i className="tc__dot" data-ok={c.ok ? "" : undefined} />{c.name}<small>{c.sub}</small></li>
                ))}
                <li><button type="button" className="ur__link" onClick={onOpenIntegrations}>Manage connectors</button></li>
              </ul>
            </Row>
            <Row icon={<span className="ur__globe" />} label="Web search" right={<span className="ur__txt">{webPages} page{webPages === 1 ? "" : "s"}</span>} />
            <Row
              icon={<span className="ur__spark" />}
              label="Skills"
              right={skills.length ? <span className="ur__txt">{skills.length}</span> : <span className="ur__txt ur__txt--dim">None</span>}
            >
              {skills.length > 0 && (
                <div className="ur__chips">{skills.map((s) => <code key={s}>{s}</code>)}</div>
              )}
            </Row>
          </div>
        </Section>
        </div>
      </div>
    </aside>
  );
}
