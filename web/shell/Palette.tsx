import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api, type Conversation } from "../api";
import { IconChart, IconChat, IconFolder, IconMonitor, IconNewChat, IconPlug, IconRuns, IconSearch, IconSidebar } from "./icons";
import { relTime } from "./util";

type Cmd = { id: string; label: string; icon: ReactNode; hint?: string; run: () => void };
type Hit = { id: string; title: string; snippet: string; updated_at: string };
type Entry = { kind: "cmd"; cmd: Cmd } | { kind: "chat"; hit: Hit };

/**
 * ⌘K palette. Opens instantly (no animation): it is keyboard-initiated and used constantly.
 * Focus trap + restore, combobox/listbox semantics.
 */
export function Palette({
  open,
  onClose,
  conversations,
  onOpenChat,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  conversations: Conversation[];
  onOpenChat: (id: string) => void;
  commands: { newChat: () => void; runs: () => void; files: () => void; analytics: () => void; integrations: () => void; toggleSidebar: () => void; toggleTheme: () => void };
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const seq = useRef(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    setQ("");
    setHits(null);
    setActive(0);
    const opener = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open]);

  // Debounced server-side search across titles and message text.
  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (!term) {
      setHits(null);
      return;
    }
    const my = ++seq.current;
    const t = window.setTimeout(async () => {
      try {
        const r = await api.searchChats(term);
        if (my === seq.current) setHits(r.results);
      } catch {
        if (my === seq.current) setHits([]);
      }
    }, 140);
    return () => window.clearTimeout(t);
  }, [q, open]);

  const cmds: Cmd[] = useMemo(
    () => [
      { id: "new", label: "New chat", icon: <IconNewChat />, hint: "Ctrl+Shift+O", run: commands.newChat },
      { id: "runs", label: "Go to Runs", icon: <IconRuns />, run: commands.runs },
      { id: "files", label: "Go to Folders & files", icon: <IconFolder />, run: commands.files },
      { id: "analytics", label: "Go to Analytics", icon: <IconChart />, run: commands.analytics },
      { id: "int", label: "Open Integrations", icon: <IconPlug />, run: commands.integrations },
      { id: "side", label: "Toggle sidebar", icon: <IconSidebar />, hint: "Ctrl+B", run: commands.toggleSidebar },
      { id: "theme", label: "Toggle light / dark theme", icon: <IconMonitor />, run: commands.toggleTheme },
    ],
    [commands],
  );

  const entries: Entry[] = useMemo(() => {
    const term = q.trim().toLowerCase();
    const matchCmds = cmds.filter((c) => !term || c.label.toLowerCase().includes(term));
    const chatHits: Hit[] = term
      ? (hits ?? conversations.filter((c) => (c.title ?? "").toLowerCase().includes(term)).map((c) => ({ id: c.id, title: c.title ?? "New chat", snippet: "", updated_at: c.updated_at })))
      : conversations.slice(0, 6).map((c) => ({ id: c.id, title: c.title ?? "New chat", snippet: "", updated_at: c.updated_at }));
    return [...chatHits.map((hit): Entry => ({ kind: "chat", hit })), ...matchCmds.map((cmd): Entry => ({ kind: "cmd", cmd }))];
  }, [q, hits, conversations, cmds]);

  useEffect(() => setActive(0), [q, hits]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const run = (e: Entry) => {
    onClose();
    if (e.kind === "chat") onOpenChat(e.hit.id);
    else e.cmd.run();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (entries.length ? (i + 1) % entries.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (entries.length ? (i - 1 + entries.length) % entries.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const en = entries[active];
      if (en) run(en);
    } else if (e.key === "Tab") {
      e.preventDefault(); // focus stays in the palette
    }
  };

  const chatCount = entries.filter((e) => e.kind === "chat").length;

  return createPortal(
    <div
      className="backdrop palette-backdrop instant"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKey}>
        <div className="palette-input">
          <IconSearch size={16} />
          <input
            ref={inputRef}
            name="palette-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search chats or type a command…"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={entries.length ? `pal-${active}` : undefined}
            aria-label="Search chats or run a command"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="kbd">Esc</kbd>
        </div>
        <ul id="palette-list" ref={listRef} className="palette-list" role="listbox">
          {entries.map((en, i) => {
            const label = en.kind === "chat" ? en.hit.title : en.cmd.label;
            const heading = i === 0 && chatCount > 0 ? (q.trim() ? "Chats" : "Recent chats") : i === chatCount ? "Commands" : null;
            return (
              <li key={`${en.kind}-${en.kind === "chat" ? en.hit.id : en.cmd.id}`} role="presentation">
                {heading && <div className="palette-heading">{heading}</div>}
                <div
                  id={`pal-${i}`}
                  data-idx={i}
                  role="option"
                  aria-selected={i === active}
                  className="palette-item"
                  data-active={i === active || undefined}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => run(en)}
                >
                  <span className="palette-icon">{en.kind === "chat" ? <IconChat /> : en.cmd.icon}</span>
                  <span className="palette-main">
                    <span className="palette-title">{label}</span>
                    {en.kind === "chat" && en.hit.snippet && <span className="palette-snippet">{en.hit.snippet}</span>}
                  </span>
                  {en.kind === "chat" ? <span className="palette-meta">{relTime(en.hit.updated_at)}</span> : en.cmd.hint ? <kbd className="kbd">{en.cmd.hint}</kbd> : null}
                </div>
              </li>
            );
          })}
          {entries.length === 0 && <li className="palette-empty">No results for “{q}”</li>}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
