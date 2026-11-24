import { memo, useEffect, useMemo, useState } from "react";
import type { UiMessage, Toast } from "./types";
import { MessageActions, MessageText, type MessageActionKey } from "./MessageActions";
import { ApprovalCard, MemoryCard, SearchCard } from "./ToolCards";
import { runningStatus } from "./tools";
import { FileIcon, LinkOut } from "./icons";
import { hostOf, plainText, renderMarkdown } from "./markdown";

export function UserMessage({ m }: { m: UiMessage }) {
  return (
    <div className="um" data-ui-message>
      <div className="um__bubble" dir="auto">{m.content}</div>
      {m.attachments && m.attachments.length > 0 && (
        <ul className="um__atts" aria-label="Attached files">
          {m.attachments.map((a, i) => (
            <li key={`${a.name}-${i}`}><FileIcon />{a.name}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface AProps {
  m: UiMessage;
  isLatest: boolean;
  busy: boolean;
  speaking: boolean;
  canSpeak: boolean;
  toast: Toast;
  onRegenerate: () => void;
  onFeedback: (turnId: string, kind: "up" | "down" | null, reason?: string) => void;
  onSpeak: (key: string, text: string, playing: boolean) => void;
  onOpenRun: (turnId: string) => void;
}

function AssistantMessageImpl({ m, isLatest, busy, speaking, canSpeak, toast, onRegenerate, onFeedback, onSpeak, onOpenRun }: AProps) {
  const all = useMemo(() => [...m.versions, m.content], [m.versions, m.content]);
  const [sel, setSel] = useState<number | null>(null);
  // A new version arrived (regenerate finished): jump to the newest.
  useEffect(() => setSel(null), [all.length]);
  const idx = Math.min(sel ?? all.length - 1, all.length - 1);
  const onLatest = idx === all.length - 1;
  const text = all[idx] ?? "";

  const html = useMemo(() => renderMarkdown(text, onLatest ? m.sources : []), [text, onLatest, m.sources]);

  const streaming = !!m.streaming;
  const empty = !streaming && !text.trim();
  const cards = m.cards ?? [];

  const actions: MessageActionKey[] = [
    "copy",
    ...(isLatest ? (["regenerate"] as MessageActionKey[]) : []),
    ...(m.turnId ? (["feedback"] as MessageActionKey[]) : []),
    ...(canSpeak && text.trim() ? (["speak"] as MessageActionKey[]) : []),
  ];

  const body = <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;

  return (
    <div className="am" data-ui-message data-streaming={streaming ? "" : undefined}>
      {m.memory && m.memory.status !== "none" && <MemoryCard memory={m.memory} />}
      {cards.length > 0 && (
        <div className="am__cards">
          {cards.map((c) => (
            <SearchCard key={c.id} card={c} />
          ))}
        </div>
      )}
      {m.approval && <ApprovalCard approval={m.approval} toast={toast} />}

      {streaming && !text && !m.approval && (
        <div className="am__thinking" role="status">
          <span className="dots" aria-hidden="true"><i /><i /><i /></span>
          <span className="am__status">{m.status || runningStatus(cards) || "Thinking…"}</span>
        </div>
      )}

      {empty ? (
        <p className="am__empty">No answer came back. Try regenerating.</p>
      ) : text ? (
        all.length > 1 && !streaming ? <MessageText version={idx}>{body}</MessageText> : body
      ) : null}

      {!streaming && onLatest && m.sources.length > 0 && (
        <div className="am__from">
          <span>From</span>
          {m.sources.slice(0, 4).map((s) => (
            <a key={s.n} className="chip" href={s.url} target="_blank" rel="noopener noreferrer" title={s.title}>
              <sup>{s.n}</sup>
              {hostOf(s.url)}
            </a>
          ))}
          {m.sources.length > 4 && <span className="chip chip--more">+{m.sources.length - 4}</span>}
        </div>
      )}

      {!streaming && (m.id || text) && (
        <div className="am__foot">
          <MessageActions
            text={text}
            actions={actions}
            versions={all}
            version={idx}
            onVersionChange={(i) => setSel(i === all.length - 1 ? null : i)}
            onRegenerate={onRegenerate}
            onFeedback={(kind, reason) => m.turnId && onFeedback(m.turnId, kind, reason)}
            speaking={speaking}
            onSpeak={(p) => onSpeak(m.key, plainText(text), p)}
            defaultFeedback={m.feedback?.kind ?? null}
            onCopy={() => {}}
          />
          {m.turnId && (
            <button type="button" className="am__run" onClick={() => onOpenRun(m.turnId!)} title="Open this run">
              View run <LinkOut />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export const AssistantMessage = memo(AssistantMessageImpl);
