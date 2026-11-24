import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  streamChat,
  type AttachmentRef,
  type ChatRequest,
  type ConversationDetail,
  type MemoryEvent,
  type SourceRef,
} from "../api";
import { approvals } from "./approvals";
import { approvalLines, approvalLineText, describeTool } from "./tools";
import { notify } from "../shell/notify";
import type { ChatSettings, RunInfo, SearchCardData, Toast, UiMessage } from "./types";

interface Params {
  conversationId: string | undefined;
  settings: ChatSettings;
  onConversationCreated: (id: string) => void;
  onChanged: () => void;
  toast: Toast;
}

export interface ChatError {
  message: string;
  retry: () => void;
}

const placeholder = (key: string): UiMessage => ({
  key,
  role: "assistant",
  content: "",
  turnId: null,
  versions: [],
  feedback: null,
  sources: [],
  searches: [],
  streaming: true,
  cards: [],
  memory: null,
  approval: null,
});

export function useChat(p: Params) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [title, setTitle] = useState("");
  const [uploads, setUploads] = useState<AttachmentRef[]>([]);
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<ChatError | null>(null);
  const [run, setRun] = useState<RunInfo | null>(null);
  /** Follow-up questions for the latest finished answer (fetched after the stream closes). */
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const sugToken = useRef(0);
  /** Bumps whenever the user switches conversation, so per-message UI state never leaks across chats. */
  const [epoch, setEpoch] = useState(0);

  const latest = useRef(p);
  latest.current = p;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const convRef = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);
  const busyRef = useRef(false);
  const approvalIds = useRef(new Set<string>());
  const cardsByTurn = useRef(new Map<string, { cards: SearchCardData[]; memory: MemoryEvent | null }>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abortRef.current?.abort();
      runIdRef.current++;
      approvalIds.current.forEach((id) => approvals.remove(id));
    };
  }, []);

  const clearApprovals = () => {
    approvalIds.current.forEach((id) => approvals.remove(id));
    approvalIds.current.clear();
  };

  const mapDetail = (detail: ConversationDetail, prev: UiMessage[]): UiMessage[] => {
    let u = 0;
    let a = 0;
    return detail.messages.map((m) => {
      const key = m.role === "user" ? `u${u++}` : `a${a++}`;
      const live = m.turn_id ? cardsByTurn.current.get(m.turn_id) : undefined;
      return {
        key,
        id: m.id,
        role: m.role,
        content: m.content,
        turnId: m.turn_id,
        versions: m.versions,
        feedback: m.feedback,
        sources: m.sources,
        searches: m.searches,
        cards:
          m.role === "assistant"
            ? (live?.cards ??
              m.searches.map((s, i) => ({ id: `${m.id}-${i}`, query: s.query, status: "done" as const, ms: s.ms, batch: 0 })))
            : undefined,
        memory: live?.memory ?? null,
        attachments: prev.find((x) => x.key === key && x.role === m.role)?.attachments,
      };
    });
  };

  const load = useCallback(async (id: string): Promise<boolean> => {
    try {
      const detail = await api.getConversation(id);
      if (!mounted.current || convRef.current !== id) return false;
      setMessages((prev) => mapDetail(detail, prev));
      setTitle(detail.conversation.title ?? "Chat");
      setUploads(detail.attachments);
      return true;
    } catch (e) {
      if (mounted.current && convRef.current === id) {
        latest.current.toast(e instanceof Error ? e.message : "Couldn't load the conversation", "error");
      }
      return false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Switching conversations: abort whatever is streaming and load the new one. */
  useEffect(() => {
    const id = p.conversationId;
    if (id === convRef.current) return; // our own newly created conversation, or no change
    abortRef.current?.abort();
    runIdRef.current++;
    busyRef.current = false;
    clearApprovals();
    setStreaming(false);
    setError(null);
    setRun(null);
    sugToken.current++;
    setSuggestions([]);
    convRef.current = id;
    setEpoch((e) => e + 1);
    setMessages([]);
    setUploads([]);
    setTitle("");
    if (!id) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void load(id).finally(() => {
      if (mounted.current && convRef.current === id) setLoading(false);
    });
  }, [p.conversationId, load]);

  /* ── Streaming ─────────────────────────────────────────────────────────── */

  const startRun = useCallback(
    async (req: ChatRequest, kind: "send" | "regen") => {
      busyRef.current = true;
      setStreaming(true);
      setError(null);
      sugToken.current++;
      setSuggestions([]);
      const myRun = ++runIdRef.current;
      const ac = new AbortController();
      abortRef.current = ac;
      const alive = () => runIdRef.current === myRun && mounted.current;

      const snapshot = messagesRef.current;
      setMessages((prev) => {
        if (kind === "send") {
          const nA = prev.filter((m) => m.role === "assistant").length;
          return [...prev, placeholder(`a${nA}`)];
        }
        const i = prev.map((m) => m.role).lastIndexOf("assistant");
        if (i < 0) return prev;
        const next = prev.slice();
        next[i] = placeholder(prev[i].key);
        return next;
      });

      let answer = "";
      let raf = 0;
      let turnId: string | undefined;
      let convId = req.conversationId;
      let batch = 0;
      let gotEvent = false;
      let failure: string | null = null;
      let memory: MemoryEvent | null = null;
      let cards: SearchCardData[] = [];

      const patch = (fn: (m: UiMessage) => UiMessage) => {
        if (!alive()) return;
        setMessages((prev) => {
          const i = prev.length - 1;
          if (i < 0 || prev[i].role !== "assistant") return prev;
          const next = prev.slice();
          next[i] = fn(prev[i]);
          return next;
        });
      };
      const syncCards = () => patch((m) => ({ ...m, cards: [...cards] }));
      const flush = () => {
        raf = 0;
        const t = answer;
        patch((m) => ({ ...m, content: t }));
      };
      const updateCard = (idx: number, part: Partial<SearchCardData>) => {
        cards = cards.map((c, i) => (i === idx ? { ...c, ...part } : c));
      };
      /** The run stopped / failed / ended: nothing may keep spinning or waiting for an answer. */
      const endOpenWork = () => {
        if (cards.some((c) => c.status === "running")) {
          cards = cards.map((c) => (c.status === "running" ? { ...c, status: "stopped" as const } : c));
          syncCards();
        }
        patch((m) => (m.approval?.status === "pending" ? { ...m, approval: { ...m.approval, status: "expired" } } : m));
      };

      setRun({ status: "running", memory: null, batches: [], drafting: "pending", cited: 0 });

      await streamChat(
        req,
        {
          onStatus: (t) => {
            gotEvent = true;
            patch((m) => ({ ...m, status: t.slice(0, 200) }));
          },
          onMemory: (e) => {
            gotEvent = true;
            if (e.status === "none") return;
            memory = e;
            patch((m) => ({ ...m, memory: e }));
            if (alive()) setRun((r) => (r ? { ...r, memory: e } : r));
          },
          onSearchStart: ({ queries, ids }) => {
            gotEvent = true;
            batch += 1;
            const b = batch;
            queries.forEach((q, i) =>
              cards.push({ id: ids?.[i] ?? `b${b}-${i}`, tool: "web_search", query: q, status: "running", batch: b }),
            );
            syncCards();
            if (alive()) setRun((r) => (r ? { ...r, batches: [...r.batches, { id: b, queries, done: 0, ms: 0 }] } : r));
          },
          onSearchDone: (d) => {
            let idx = d.callId ? cards.findIndex((c) => c.id === d.callId) : -1;
            if (idx < 0) idx = cards.findIndex((c) => c.query === d.query && c.status === "running");
            if (idx < 0) return;
            const declined = d.error === "declined by user";
            updateCard(idx, {
              status: d.error ? (declined ? "declined" : "error") : "done",
              ms: d.ms,
              count: d.count,
              cached: d.cached,
              results: d.results,
              error: d.error,
            });
            const b = cards[idx].batch;
            syncCards();
            if (alive())
              setRun((r) =>
                r
                  ? {
                      ...r,
                      batches: r.batches.map((x) => (x.id === b ? { ...x, done: x.done + 1, ms: Math.max(x.ms, d.ms) } : x)),
                    }
                  : r,
              );
          },
          onToolStart: ({ tools }) => {
            gotEvent = true;
            batch += 1;
            const b = batch;
            for (const t of tools ?? []) {
              if (!t || cards.some((c) => c.id === t.id)) continue;
              cards.push({ id: t.id, tool: t.tool, query: describeTool(t.tool, t.label), status: "running", batch: b });
            }
            syncCards();
          },
          onToolDone: (d) => {
            const idx = cards.findIndex((c) => c.id === d.id);
            if (idx < 0) return;
            const declined = d.error === "declined by user";
            updateCard(idx, {
              status: d.error ? (declined ? "declined" : "error") : "done",
              ms: d.ms,
              error: d.error,
              duplicate: d.duplicate === true || undefined,
              query: d.label ? describeTool(d.tool || cards[idx].tool, d.label) : cards[idx].query,
            });
            syncCards();
          },
          onApprovalRequest: ({ id, queries, actions }) => {
            approvalIds.current.add(id);
            const lines = approvalLines(queries ?? [], actions);
            void notify("approval", "Approval needed", lines[0] ? approvalLineText(lines[0]) : queries?.[0]);
            approvals.add({ id, conversationId: convRef.current ?? convId, queries: queries ?? [], actions, createdAt: Date.now() });
            patch((m) => ({ ...m, approval: { id, queries: queries ?? [], actions, status: "pending", expiresAt: Date.now() + 120_000 } }));
          },
          onApprovalResult: ({ id, approved }) => {
            approvalIds.current.delete(id);
            const nextStatus: "approved" | "declined" | "expired" = approved ? "approved" : "declined";
            approvals.resolve(id, nextStatus);
            patch((m) =>
              m.approval?.id === id
                ? {
                    ...m,
                    approval: {
                      ...m.approval,
                      status: approved ? "approved" : Date.now() >= m.approval.expiresAt - 3000 ? "expired" : "declined",
                    },
                  }
                : m,
            );
          },
          onToken: (t) => {
            gotEvent = true;
            if (!answer && alive()) setRun((r) => (r ? { ...r, drafting: "running" } : r));
            answer += t;
            if (!raf) raf = requestAnimationFrame(flush);
          },
          onSources: (s) => {
            const list: SourceRef[] = Object.entries(s)
              .map(([n, v]) => ({ n: Number(n), url: v.url, title: v.title || v.url, published_at: v.publishedAt ?? null }))
              .sort((a, b) => a.n - b.n);
            patch((m) => ({ ...m, sources: list }));
            if (alive()) setRun((r) => (r ? { ...r, cited: list.length } : r));
          },
          onConversation: (id) => {
            gotEvent = true;
            if (!id) return;
            convId = id;
            // Lock onto the conversation immediately so the next message joins it even if this stream dies early.
            if (alive() && !convRef.current) {
              convRef.current = id;
              latest.current.onConversationCreated(id);
            }
          },
          onDone: (d) => {
            gotEvent = true;
            turnId = d.turnId;
            convId = d.conversationId;
            if (raf) cancelAnimationFrame(raf);
            flush();
            endOpenWork();
            cardsByTurn.current.set(d.turnId, { cards: [...cards], memory });
            void notify("finished", "Answer ready", "Minimi finished your question.");
            if (alive() && !convRef.current) {
              convRef.current = d.conversationId;
              latest.current.onConversationCreated(d.conversationId);
            }
          },
          onError: (m) => {
            failure = m;
            endOpenWork();
            void notify("failed", "Run failed", m);
          },
        },
        ac.signal,
      );

      if (raf) cancelAnimationFrame(raf);
      if (alive()) {
        flush();
        endOpenWork();
      }
      clearApprovals();
      if (!alive()) return; // the user moved to another conversation; it owns the state now

      busyRef.current = false;
      abortRef.current = null;
      setStreaming(false);
      const aborted = ac.signal.aborted;
      // The stream closed without a `done` or `error` event (server restarted / connection dropped).
      if (!failure && !turnId && !aborted) failure = "The connection closed before the answer finished.";
      setRun((r) => (r ? { ...r, status: failure ? "error" : aborted ? "stopped" : "done", drafting: "done" } : r));

      const id = convRef.current ?? convId;
      if (failure) {
        const message = failure;
        if (!gotEvent) {
          // Nothing reached the server's database: roll the placeholder back and offer a plain retry.
          if (kind === "regen") setMessages(snapshot);
          else setMessages((prev) => (prev.length && prev[prev.length - 1].role === "assistant" && prev[prev.length - 1].streaming ? prev.slice(0, -1) : prev));
          setError({ message, retry: () => void startRun(req, kind) });
          latest.current.onChanged();
          return;
        }
        if (id) await load(id);
        else setMessages((prev) => (prev.length && prev[prev.length - 1].streaming ? prev.slice(0, -1) : prev));
        setError({ message, retry: () => (id ? regenerateRef.current() : void startRun(req, kind)) });
        latest.current.onChanged();
        return;
      }
      if (id && (turnId || aborted)) {
        if (aborted) await new Promise((r) => setTimeout(r, 600));
        if (alive() || (mounted.current && convRef.current === id)) await load(id);
      }
      latest.current.onChanged();
      if (turnId && !aborted && !failure) {
        const tok = sugToken.current;
        void api
          .suggest(turnId)
          .then((r) => {
            if (mounted.current && sugToken.current === tok && convRef.current === id) setSuggestions(r.items);
          })
          .catch(() => {});
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [load],
  );

  const regenerateRef = useRef<() => void>(() => {});

  const send = useCallback(
    (text: string, atts: AttachmentRef[] = []): boolean => {
      const msg = text.trim();
      if (!msg || busyRef.current) return false;
      const { settings } = latest.current;
      const req: ChatRequest = {
        message: msg,
        conversationId: convRef.current,
        model: settings.model,
        approvalMode: settings.approvalMode,
        attachmentIds: atts.map((a) => a.id),
      };
      setMessages((prev) => {
        const nU = prev.filter((m) => m.role === "user").length;
        return [
          ...prev,
          {
            key: `u${nU}`,
            role: "user",
            content: msg,
            turnId: null,
            versions: [],
            feedback: null,
            sources: [],
            searches: [],
            attachments: atts.map((a) => ({ name: a.name })),
          },
        ];
      });
      void startRun(req, "send");
      return true;
    },
    [startRun],
  );

  const regenerate = useCallback(() => {
    if (busyRef.current) return;
    const list = messagesRef.current;
    const li = list.map((m) => m.role).lastIndexOf("assistant");
    const last = list[li];
    const userMsg = li > 0 ? list[li - 1] : undefined;
    if (!last?.turnId || !userMsg || userMsg.role !== "user") {
      latest.current.toast("Nothing to regenerate yet", "info");
      return;
    }
    const { settings } = latest.current;
    void startRun(
      {
        message: userMsg.content,
        conversationId: convRef.current,
        regenerateTurnId: last.turnId,
        model: settings.model,
        approvalMode: settings.approvalMode,
      },
      "regen",
    );
  }, [startRun]);
  regenerateRef.current = regenerate;

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const setFeedback = useCallback((turnId: string, kind: "up" | "down" | null, reason?: string) => {
    api.feedback(turnId, kind, reason).catch((e) => latest.current.toast(e instanceof Error ? e.message : "Couldn't save feedback", "error"));
  }, []);

  return { epoch, messages, title, uploads, loading, streaming, error, run, suggestions, send, regenerate, stop, setFeedback, clearError: () => setError(null) };
}
