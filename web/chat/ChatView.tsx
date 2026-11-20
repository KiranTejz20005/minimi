import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./chat.css";
import type { ChatViewProps } from "./contract";
import type { ChatSettings, RunInfo, Toast, ToastKind, UiMessage } from "./types";
import { useChat } from "./useChat";
import { Composer } from "./Composer";
import { AssistantMessage, UserMessage } from "./Message";
import { RightPanel, type Step } from "./RightPanel";
import { ArrowDown, Close, PanelRight, Spinner } from "./icons";
import { fmtMs } from "./markdown";

const LS = {
  model: "minimi.model",
  approval: "minimi.approval",
  panel: "minimi.rightPanel",
};

function readLS(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLS(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

const SUGGESTIONS = [
  { label: "Yesterday's questions", prompt: "What did I ask you yesterday?" },
  { label: "Verify past pricing", prompt: "Last Tuesday I asked about Postgres hosting. Has any pricing changed?" },
  { label: "Answer without searching", prompt: "Explain connection pooling in two sentences." },
];

function buildSteps(run: RunInfo | null, last: UiMessage | undefined): Step[] {
  const steps: Step[] = [];
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (run) {
    if (run.memory) steps.push({ id: "mem", label: run.memory.text || "Checked memory", tag: "memory.recall", state: "done" });
    for (const b of run.batches) {
      const finished = b.done >= b.queries.length;
      steps.push({
        id: `b${b.id}`,
        label: `Searched ${plural(b.queries.length, "source")}`,
        sub: b.queries.slice(0, 2).join(" · "),
        tag: "web_search",
        time: finished ? fmtMs(b.ms) : undefined,
        state: finished ? "done" : "running",
      });
    }
    steps.push({
      id: "draft",
      label: run.status === "running" ? "Drafting answer" : run.status === "done" ? "Answer drafted" : run.status === "stopped" ? "Stopped" : "Stopped with an error",
      state: run.status === "running" ? "running" : run.status === "done" ? "done" : "error",
    });
    if (run.cited > 0) steps.push({ id: "cite", label: `Cited ${plural(run.cited, "source")}`, state: "done" });
    return steps;
  }
  if (last && last.role === "assistant") {
    const searches = last.cards?.length ?? last.searches.length;
    if (last.memory && last.memory.status !== "none") steps.push({ id: "mem", label: last.memory.text || "Checked memory", tag: "memory.recall", state: "done" });
    if (searches > 0) {
      const ms = Math.max(0, ...(last.cards ?? []).map((c) => c.ms ?? 0));
      steps.push({ id: "s", label: `Ran ${plural(searches, "search")}`, tag: "web_search", time: ms ? fmtMs(ms) : undefined, state: "done" });
    }
    if (last.content.trim()) steps.push({ id: "draft", label: "Answer drafted", state: "done" });
    if (last.sources.length > 0) steps.push({ id: "cite", label: `Cited ${plural(last.sources.length, "source")}`, state: "done" });
  }
  return steps;
}

export function ChatView(props: ChatViewProps) {
  const { conversationId, integrations, onConversationCreated, onChanged, onOpenRun, focusToken, onOpenIntegrations } = props;

  /* ── Settings (persisted) ── */
  // Composer no longer exposes approval; read-only tools never prompt (user: only important things).
  const [settings, setSettingsState] = useState<ChatSettings>(() => {
    const m = readLS(LS.model);
    return { model: m === "main" || m === "fast" || m === "smart" ? m : "auto", approval: false };
  });
  const setSettings = useCallback((s: ChatSettings) => {
    setSettingsState({ ...s, approval: false });
    writeLS(LS.model, s.model);
  }, []);
  const [panelOpen, setPanelOpen] = useState(() => readLS(LS.panel) !== "0");
  const togglePanel = (v: boolean) => {
    setPanelOpen(v);
    writeLS(LS.panel, v ? "1" : "0");
  };

  /* ── Toasts ── */
  const [toasts, setToasts] = useState<{ id: number; message: string; kind: ToastKind }[]>([]);
  const toastId = useRef(0);
  const toast: Toast = useCallback((message, kind = "info") => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, message, kind }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 2600);
  }, []);

  /* ── Chat state ── */
  const chat = useChat({ conversationId, settings, onConversationCreated, onChanged, toast });
  const { messages, streaming, loading, run, error } = chat;
  const lastIdx = messages.map((m) => m.role).lastIndexOf("assistant");
  const last = lastIdx >= 0 ? messages[lastIdx] : undefined;
  const hasMessages = messages.length > 0;

  /* ── Scrolling: stick to the bottom unless the user scrolled up ── */
  const scroller = useRef<HTMLDivElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = near;
    setAtBottom(near);
  };
  const toBottom = (smooth = false) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };
  useEffect(() => {
    const el = thread.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stick.current) toBottom();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (stick.current) toBottom();
  }, [messages, error]);
  useEffect(() => {
    stick.current = true;
  }, [chat.epoch]);

  const send = useCallback(
    (text: string, atts: Parameters<typeof chat.send>[1]) => {
      stick.current = true;
      return chat.send(text, atts);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chat.send],
  );
  const regenerate = useCallback(() => {
    stick.current = true;
    chat.regenerate();
  }, [chat.regenerate]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Read aloud (one message at a time) ── */
  const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  const [speakingKey, setSpeakingKey] = useState<string | null>(null);
  const onSpeak = useCallback(
    (key: string, text: string, playing: boolean) => {
      if (!canSpeak) return;
      window.speechSynthesis.cancel();
      if (!playing || !text) {
        setSpeakingKey(null);
        return;
      }
      const u = new SpeechSynthesisUtterance(text);
      u.onend = u.onerror = () => setSpeakingKey((k) => (k === key ? null : k));
      setSpeakingKey(key);
      window.speechSynthesis.speak(u);
    },
    [canSpeak],
  );
  useEffect(() => {
    setSpeakingKey(null);
    if (canSpeak) window.speechSynthesis.cancel();
  }, [chat.epoch, canSpeak]);
  useEffect(() => () => {
    if (canSpeak) window.speechSynthesis.cancel();
  }, [canSpeak]);

  /* ── Panel data ── */
  const steps = useMemo(() => buildSteps(run, last), [run, last]);
  const cards = last?.cards ?? [];
  const webPages = cards.reduce((n, c) => n + (c.count ?? 0), 0) || (last?.sources.length ?? 0);
  const skills = useMemo(() => {
    const s: string[] = [];
    if (cards.length > 0 || (run?.batches.length ?? 0) > 0) s.push("web_search");
    if ((run?.memory ?? last?.memory)?.status && (run?.memory ?? last?.memory)?.status !== "none") s.push("memory_recall");
    return s;
  }, [cards.length, run, last]);
  const title = chat.title || (hasMessages ? "Chat" : "New chat");

  const pill = streaming
    ? { kind: "run", text: "Running" }
    : run?.status === "error" || error
      ? { kind: "err", text: "Failed" }
      : run?.status === "stopped"
        ? { kind: "idle", text: "Stopped" }
        : last && !loading
          ? { kind: "done", text: "Done" }
          : null;

  const landing = !hasMessages && !loading && !conversationId;

  return (
    <div className="cv" data-panel={panelOpen ? "open" : "closed"}>
      <section className="cv__main" aria-label="Conversation">
        <header className="cv__head">
          <h1 className="cv__title" title={title}>{title}</h1>
          {pill && (
            <span className="cv__pill" data-kind={pill.kind} role="status">
              <i />
              {pill.text}
            </span>
          )}
          <div className="cv__headright">
            {streaming && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={chat.stop}>
                Stop run
              </button>
            )}
            <button
              type="button"
              className="icon-btn cv__ptoggle"
              aria-label={panelOpen ? "Hide run details" : "Show run details"}
              aria-pressed={panelOpen}
              onClick={() => togglePanel(!panelOpen)}
            >
              <PanelRight />
            </button>
          </div>
        </header>

        <div className="cv__scroll" ref={scroller} onScroll={onScroll}>
          <div className="cv__thread" ref={thread}>
            {loading && (
              <div className="cv__skeleton" aria-busy="true" aria-label="Loading conversation">
                <i /><i /><i />
              </div>
            )}

            {landing && (
              <div className="cv__landing">
                <h2>What can I look up for you?</h2>
                <p>Ask anything. I search the live web, remember when you asked, and re-check it later.</p>
                <div className="cv__chips">
                  {SUGGESTIONS.map((s) => (
                    <button key={s.label} type="button" className="chip chip--btn" onClick={() => send(s.prompt, [])}>
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <Fragment key={chat.epoch}>
              {messages.map((m, i) =>
                m.role === "user" ? (
                  <UserMessage key={m.key} m={m} />
                ) : (
                  <AssistantMessage
                    key={m.key}
                    m={m}
                    isLatest={i === lastIdx && !streaming}
                    busy={streaming}
                    speaking={speakingKey === m.key}
                    canSpeak={canSpeak}
                    toast={toast}
                    onRegenerate={regenerate}
                    onFeedback={chat.setFeedback}
                    onSpeak={onSpeak}
                    onOpenRun={onOpenRun}
                  />
                ),
              )}
            </Fragment>

            {!streaming && !error && hasMessages && chat.suggestions.length > 0 && (
              <div className="cv__followups" role="group" aria-label="Suggested follow-up questions">
                {chat.suggestions.map((s, i) => (
                  <button
                    key={s}
                    type="button"
                    className="followup"
                    style={{ animationDelay: `${i * 60}ms` }}
                    onClick={() => send(s, [])}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}

            {error && (
              <div className="cv__error" role="alert">
                <span>{error.message}</span>
                <button type="button" className="btn btn--ghost btn--sm" onClick={error.retry}>
                  Retry
                </button>
                <button type="button" className="icon-btn" aria-label="Dismiss" onClick={chat.clearError}>
                  <Close />
                </button>
              </div>
            )}
          </div>
        </div>

        {!atBottom && hasMessages && (
          <button type="button" className="cv__jump" aria-label="Jump to latest" onClick={() => { stick.current = true; toBottom(true); }}>
            {streaming ? <Spinner size={12} /> : <ArrowDown />}
            {streaming ? "Writing…" : "Latest"}
          </button>
        )}

        <div className="cv__compose">
          <Composer
            streaming={streaming}
            hasMessages={hasMessages}
            conversationId={conversationId}
            integrations={integrations}
            settings={settings}
            setSettings={setSettings}
            focusToken={focusToken}
            onSend={send}
            onStop={chat.stop}
            toast={toast}
          />
        </div>

        <div className="cv__toasts" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className="cv__toast" data-kind={t.kind} role="status">
              {t.message}
            </div>
          ))}
        </div>
      </section>

      <RightPanel
        open={panelOpen}
        onClose={() => togglePanel(false)}
        steps={steps}
        title={chat.title}
        answer={last?.content ?? ""}
        sources={last?.sources ?? []}
        uploads={chat.uploads}
        integrations={integrations}
        webPages={webPages}
        skills={skills}
        onOpenIntegrations={onOpenIntegrations}
        toast={toast}
      />
    </div>
  );
}
