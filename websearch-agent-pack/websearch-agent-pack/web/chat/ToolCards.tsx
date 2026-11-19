import { useEffect, useId, useState, type ReactNode } from "react";
import { api, type MemoryEvent } from "../api";
import type { ApprovalData, SearchCardData, Toast } from "./types";
import { Check, Chevron, Close, Globe, Memory, Spinner } from "./icons";
import { fmtMs, hostOf } from "./markdown";

/** Generic expandable tool card (header button + animated body). */
function Card({
  icon,
  tool,
  label,
  right,
  expandable,
  children,
  state,
}: {
  icon: ReactNode;
  tool: string;
  label: ReactNode;
  right?: ReactNode;
  expandable: boolean;
  children?: ReactNode;
  state?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="tc" data-state={state} data-open={open && expandable ? "" : undefined}>
      <button
        type="button"
        className="tc__head"
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? id : undefined}
        disabled={!expandable}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="tc__icon">{icon}</span>
        <code className="tc__tool">{tool}</code>
        <span className="tc__label">{label}</span>
        <span className="tc__right">{right}</span>
        {expandable && (
          <span className="tc__chev">
            <Chevron />
          </span>
        )}
      </button>
      {expandable && (
        <div id={id} className="tc__fold" inert={!open}>
          <div className="tc__clip">
            <div className="tc__body">{children}</div>
          </div>
        </div>
      )}
    </div>
  );
}

export function SearchCard({ card }: { card: SearchCardData }) {
  const { status } = card;
  const label =
    status === "running" ? (
      <>Searching <b>{card.query}</b></>
    ) : status === "declined" ? (
      <>Declined <b>{card.query}</b></>
    ) : status === "error" ? (
      <>Search failed <b>{card.query}</b></>
    ) : (
      <>Searched <b>{card.query}</b></>
    );
  const right =
    status === "running" ? (
      <span className="tc__time"><Spinner size={12} /></span>
    ) : (
      <span className="tc__time" data-status={status}>
        {card.cached && <span className="tc__badge">cached</span>}
        <i className="tc__dot" />
        {status === "declined" ? "skipped" : fmtMs(card.ms)}
      </span>
    );
  const results = card.results ?? [];
  const expandable = status !== "running" && (results.length > 0 || status === "error" || status === "declined");
  return (
    <Card icon={<Globe />} tool="web_search" label={label} right={right} expandable={expandable} state={status}>
      {status === "error" || status === "declined" ? (
        <p className="tc__note">{status === "declined" ? "You declined this search, so the agent answered without it." : card.error || "The search provider returned an error."}</p>
      ) : (
        <ul className="tc__results">
          {results.map((r, i) => (
            <li key={`${r.url}-${i}`}>
              <a href={r.url} target="_blank" rel="noopener noreferrer">
                <span className="tc__fav" aria-hidden="true">{hostOf(r.url).charAt(0).toUpperCase()}</span>
                <span className="tc__rtitle">{r.title || r.url}</span>
                <span className="tc__rhost">{hostOf(r.url)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function MemoryCard({ memory }: { memory: MemoryEvent }) {
  const turns = memory.turns ?? [];
  const dates = memory.miss?.dates ?? [];
  const text = memory.text || (memory.status === "hit" ? "Recalled earlier conversations" : "No saved conversation found");
  return (
    <Card
      icon={<Memory />}
      tool="memory.recall"
      label={text}
      right={
        <span className="tc__time" data-status={memory.status === "hit" ? "done" : "declined"}>
          <i className="tc__dot" />
          {memory.status === "hit" ? `${turns.length} found` : "no match"}
        </span>
      }
      expandable={turns.length > 0 || dates.length > 0}
      state={memory.status}
    >
      <ul className="tc__results">
        {turns.map((t) => (
          <li key={t.id} className="tc__mem">
            <span className="tc__rhost">{t.localDate}</span>
            <span className="tc__rtitle">{t.question}</span>
          </li>
        ))}
        {turns.length === 0 && dates.map((d) => <li key={d} className="tc__mem"><span className="tc__rhost">Checked</span><span className="tc__rtitle">{d}</span></li>)}
      </ul>
    </Card>
  );
}

export function ApprovalCard({ approval, toast }: { approval: ApprovalData; toast: Toast }) {
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil((approval.expiresAt - Date.now()) / 1000)));
  const [busy, setBusy] = useState(false);
  const pending = approval.status === "pending";

  useEffect(() => {
    if (!pending) return;
    const t = window.setInterval(() => setLeft(Math.max(0, Math.ceil((approval.expiresAt - Date.now()) / 1000))), 1000);
    return () => window.clearInterval(t);
  }, [pending, approval.expiresAt]);

  const answer = async (ok: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.approve(approval.id, ok);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't send your answer", "error");
    } finally {
      setBusy(false);
    }
  };

  const expired = approval.status === "expired" || (pending && left === 0);
  const mm = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  return (
    <div className="ap" data-status={expired ? "expired" : approval.status} role="group" aria-label="Approval needed">
      <div className="ap__head">
        <span className="ap__title">{pending && !expired ? "Allow this web search?" : expired ? "Approval expired" : approval.status === "approved" ? "Search approved" : "Search declined"}</span>
        {pending && !expired && <span className="ap__timer" aria-live="off">Auto-declines in {mm}</span>}
        {!pending && !expired && (
          <span className="ap__chip">{approval.status === "approved" ? <Check /> : <Close />}</span>
        )}
      </div>
      <ul className="ap__list">
        {approval.queries.map((q, i) => (
          <li key={`${q}-${i}`}>{q}</li>
        ))}
      </ul>
      {pending && !expired && (
        <div className="ap__actions">
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void answer(false)}>Decline</button>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void answer(true)}>Approve</button>
        </div>
      )}
      {expired && <p className="tc__note">No answer in time, so the agent continued without searching.</p>}
    </div>
  );
}
