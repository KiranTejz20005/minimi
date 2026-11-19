/** Typed client for the Minimi backend. Single source of truth for the web UI's data contract. */

export type Conversation = {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
  pinned: boolean;
  project_id: string | null;
};
export type Project = { id: string; name: string; created_at: string; chat_count: number; file_count: number };

export type SourceRef = { n: number; url: string; title: string; published_at: string | null };
export type SearchRef = { query: string; ms: number };
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
  turn_id: string | null;
  /** Older answers of this message (oldest first). `content` is the newest. */
  versions: string[];
  feedback: { kind: "up" | "down"; reason: string | null } | null;
  sources: SourceRef[];
  searches: SearchRef[];
};
export type FileKind = "MD" | "CSV" | "JSON" | "CODE" | "TXT";
export type AttachmentRef = { id: string; name: string; size: number; kind: FileKind; created_at?: string; mime?: string | null };
export type FileRow = AttachmentRef & {
  conversation_id: string | null;
  conversation_title: string | null;
  project_id: string | null;
  project_name: string | null;
  created_at: string;
};
export type ConversationDetail = { conversation: Conversation; messages: ChatMessage[]; attachments: AttachmentRef[] };

export type Integrations = {
  llm: { provider: string; connected: boolean; mainModel: string; fastModel: string; smartModel?: string };
  search: { provider: string; hasTavilyKey: boolean; connected: boolean };
  timezone: string;
};

export type RunSummary = {
  id: string;
  conversation_id: string;
  conversation_title: string;
  question: string;
  answer_preview: string;
  status: "ok" | "error" | "aborted";
  created_at: string;
  steps: number;
  tool_calls: number;
  duration_ms: number;
  sources: number;
};
export type RunStep = { stage: string; started_ms: number; duration_ms: number; detail: unknown };
export type RunDetail = {
  id: string;
  conversation_id: string;
  conversation_title: string;
  question: string;
  answer: string;
  status: "ok" | "error" | "aborted";
  created_at: string;
  duration_ms: number;
  steps: RunStep[];
  tool_calls: number;
  sources: { n: number; url: string; title: string; host: string }[];
};
export type Stats = {
  totals: { conversations: number; turns: number; sources: number; files: number; thumbsUp: number; thumbsDown: number; searches: number; avgMs: number };
  perDay: { date: string; turns: number }[];
  topDomains: { domain: string; count: number }[];
};

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/** Backend origin, baked in at build time. Empty = same origin (the server serves this UI). */
const API_BASE = __API_URL__;

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(API_BASE + url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? res.statusText ?? "Request failed", res.status);
  return data as T;
}

export const api = {
  health: () => req<{ ok: boolean; hasLlm: boolean; hasSearch: boolean; devRoutes: boolean; now: string }>("GET", "/health"),

  listConversations: () => req<{ conversations: Conversation[]; projects: Project[] }>("GET", "/api/conversations"),
  getConversation: (id: string) => req<ConversationDetail>("GET", `/api/conversations/${id}`),
  patchConversation: (id: string, patch: { title?: string; pinned?: boolean; projectId?: string | null }) =>
    req<{ ok: true }>("PATCH", `/api/conversations/${id}`, patch),
  deleteConversation: (id: string) => req<{ ok: true }>("DELETE", `/api/conversations/${id}`),

  createProject: (name: string) => req<{ id: string; name: string }>("POST", "/api/projects", { name }),
  renameProject: (id: string, name: string) => req<{ ok: true }>("PATCH", `/api/projects/${id}`, { name }),
  deleteProject: (id: string) => req<{ ok: true }>("DELETE", `/api/projects/${id}`),

  searchChats: (q: string) =>
    req<{ results: { id: string; title: string; updated_at: string; snippet: string }[] }>("GET", `/api/search?q=${encodeURIComponent(q)}`),

  uploadFile: (f: { name: string; mime?: string; content: string; conversationId?: string }) =>
    req<AttachmentRef>("POST", "/api/attachments", f),
  listFiles: () => req<{ files: FileRow[] }>("GET", "/api/attachments"),
  getFile: (id: string) => req<AttachmentRef & { content: string }>("GET", `/api/attachments/${id}`),
  deleteFile: (id: string) => req<{ ok: true }>("DELETE", `/api/attachments/${id}`),

  integrations: () => req<Integrations>("GET", "/api/integrations"),
  setTavilyKey: (key: string) => req<Integrations>("PUT", "/api/integrations/tavily", { key }),
  testIntegration: (target: "llm" | "search") =>
    req<{ ok: boolean; ms: number; detail?: string; error?: string }>("POST", "/api/integrations/test", { target }),

  suggest: (turnId: string) => req<{ items: string[] }>("POST", "/api/suggest", { turnId }),
  approve: (id: string, approved: boolean) => req<{ ok: true }>("POST", "/api/approve", { id, approved }),
  feedback: (turnId: string, kind: "up" | "down" | null, reason?: string) =>
    req<{ ok: true }>("POST", "/api/feedback", { turnId, kind, reason }),

  runs: () => req<{ runs: RunSummary[] }>("GET", "/api/runs"),
  run: (id: string) => req<RunDetail>("GET", `/api/runs/${id}`),
  stats: () => req<Stats>("GET", "/api/stats"),

  getClock: () => req<{ now: string }>("GET", "/api/dev/clock"),
  setClock: (iso: string) => req<{ now: string }>("POST", "/api/dev/clock", { iso }),
  resetClock: () => req<{ now: string }>("POST", "/api/dev/clock", { clear: true }),
};

/* ── Streaming chat ──────────────────────────────────────────────────────── */

export type ChatRequest = {
  message: string;
  conversationId?: string;
  tz?: string;
  model?: "auto" | "main" | "fast" | "smart";
  /** Ask the user before every web search. */
  approval?: boolean;
  attachmentIds?: string[];
  /** Re-run this (latest) turn; the old answer becomes an earlier version of the new one. */
  regenerateTurnId?: string;
};

export type MemoryEvent = {
  status: "hit" | "miss" | "none";
  text?: string;
  turns?: { id: string; localDate: string; question: string }[];
  miss?: { dates: string[] };
};

export type StreamHandlers = {
  /** The conversation exists (sent first, before any model work). Lock onto this id for follow-up messages. */
  onConversation?: (id: string) => void;
  onStatus?: (text: string) => void;
  onMemory?: (m: MemoryEvent) => void;
  /** `ids` are the model's tool-call ids, aligned with `queries`; match them to onSearchDone.callId. */
  onSearchStart?: (p: { queries: string[]; ids?: string[] }) => void;
  onSearchDone?: (p: {
    query: string;
    count: number;
    ms: number;
    cached: boolean;
    callId?: string;
    results?: { title: string; url: string }[];
    error?: string;
  }) => void;
  onApprovalRequest?: (p: { id: string; queries: string[] }) => void;
  onApprovalResult?: (p: { id: string; approved: boolean }) => void;
  onToken?: (text: string) => void;
  /** Keys are citation numbers. */
  onSources?: (s: Record<string, { url: string; title: string; publishedAt?: string | null }>) => void;
  onDone?: (p: { turnId: string; conversationId: string; trace?: { searchCount: number } }) => void;
  onError?: (message: string) => void;
};

/** Resolves when the stream ends. Aborting `signal` ends it quietly (no onError). */
export async function streamChat(body: ChatRequest, h: StreamHandlers, signal?: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(API_BASE + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone, ...body }),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) return;
    h.onError?.(e instanceof Error ? e.message : "Network error");
    return;
  }
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    h.onError?.(err.error ?? res.statusText ?? "Request failed");
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const chunks = buf.split("\n\n");
      buf = chunks.pop() ?? "";
      for (const chunk of chunks) {
        let ev = "message";
        const dataLines: string[] = [];
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) ev = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue;
        let p: any;
        try {
          p = JSON.parse(dataLines.join("\n"));
        } catch {
          continue;
        }
        switch (ev) {
          case "conversation": h.onConversation?.(String(p.id ?? "")); break;
          case "status": h.onStatus?.(String(p.text ?? "")); break;
          case "memory": h.onMemory?.(p); break;
          case "search_start": h.onSearchStart?.(p); break;
          case "search_done": h.onSearchDone?.(p); break;
          case "approval_request": h.onApprovalRequest?.(p); break;
          case "approval_result": h.onApprovalResult?.(p); break;
          case "token": h.onToken?.(String(p.text ?? "")); break;
          case "sources": h.onSources?.(p); break;
          case "done": h.onDone?.(p); break;
          case "error": h.onError?.(String(p.message ?? "Error")); break;
        }
      }
    }
  } catch (e) {
    if (signal?.aborted) return;
    h.onError?.(e instanceof Error ? e.message : "Stream interrupted");
  }
}
