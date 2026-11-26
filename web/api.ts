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
/** Folder colors; keep in sync with src/projects.ts. */
export type ProjectColor = "blue" | "sky" | "green" | "amber" | "orange" | "red" | "pink" | "purple" | "gray";
export type Project = { id: string; name: string; created_at: string; chat_count: number; file_count: number; color: ProjectColor };

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
export type FileKind = "MD" | "CSV" | "JSON" | "CODE" | "TXT" | "PDF" | "XLSX";
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
  search: { provider: string; hasTavilyKey: boolean; keyHint?: string | null; connected: boolean };
  timezone: string;
  security?: { accessProtected: boolean };
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
  /** Questions per local day for roughly the last 250 days (home heatmap). */
  activity?: { date: string; turns: number }[];
  topDomains: { domain: string; count: number }[];
};

/** GET /api/queue: live state of the background memory-digest worker pool. */
export type QueueStats =
  | { available: false }
  | {
      available: true;
      name: string;
      model: string;
      capacity: number;
      waiting: { id: string; label: string }[];
      running: { id: string; label: string; startedAt: number }[];
      throughputPerMin: number;
      waitP95Ms: number;
      history: number[];
      windowMs: number;
      done: number;
      failed: number;
    };

/** GET/PUT /api/preferences */
export type Delivery = "browser" | "off";
export type Preferences = {
  displayName: string;
  firstName: string;
  lastName: string;
  role: string;
  timezone: string;
  email: string;
  personalContext: string;
  workspaceName: string;
  companyContext: string;
  customInstructions: string;
  useInstructions: boolean;
  webSearch: boolean;
  memoryRecall: boolean;
  notifyApprovals: Delivery;
  notifyFinished: Delivery;
  notifyFailed: Delivery;
  notifySound: boolean;
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

/* ── Discover: news across domains + recently funded startups (/api/discover/*) ── */

export type DiscoverFacet = { id: string; label: string; count: number };
export type NewsItem = {
  id: string;
  title: string;
  url: string;
  source: string;
  domain: string;
  summary: string;
  /** Not rendered: the CSP (img-src 'self' data:) blocks remote images, so the UI shows a source monogram instead. */
  imageUrl: string | null;
  publishedAt: string;
  fetchedAt: string;
};
export type NewsPage = { items: NewsItem[]; total: number; updatedAt: string | null; domains: DiscoverFacet[] };
export type StartupContext = {
  whatTheyDo: string;
  funding: string;
  investors: string;
  whyItMatters: string;
  market: string;
  caveats: string;
  generatedAt: string;
  model: string | null;
};
export type Startup = {
  id: string;
  company: string;
  amountUsd: number | null;
  amountText: string | null;
  currency: string | null;
  round: string | null;
  sector: string;
  summary: string;
  investors: string[];
  location: string | null;
  publishedAt: string;
  source: string;
  url: string;
  context: StartupContext | null;
};
export type StartupStats = { count: number; totalUsd: number | null; last7d: number };
export type StartupsPage = { items: Startup[]; total: number; updatedAt: string | null; sectors: DiscoverFacet[]; stats: StartupStats };
export type DiscoverSource = { name: string; kind: string; ok: boolean; items: number; ms: number; error?: string };
export type DiscoverStatus = {
  lastRefreshAt: string | null;
  nextRefreshAt: string | null;
  refreshing: boolean;
  newsCount: number;
  startupCount: number;
  sources: DiscoverSource[];
};
export type DiscoverRefresh = { started: boolean; reason?: "already_running" | "too_soon" };
export type NewsQuery = { domain?: string; q?: string; limit?: number; offset?: number };
export type StartupsQuery = { sector?: string; q?: string; sort?: "recent" | "amount"; limit?: number; offset?: number };

/** ApiError plus the server's Retry-After in seconds (set on 429), so the UI can say when to try again. */
export class DiscoverError extends ApiError {
  constructor(message: string, status: number, public retryAfterSec: number | null = null) {
    super(message, status);
  }
}

function discoverQs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    const s = String(v).trim();
    if (s) sp.set(k, s);
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** Like req(), plus an AbortSignal (stale filter requests are cancelled) and Retry-After on errors. Status 0 = network failure. */
async function discoverReq<T>(method: "GET" | "POST", url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + url, method === "POST" ? { method, signal, headers: { "Content-Type": "application/json" }, body: "{}" } : { method, signal });
  } catch (e) {
    if (signal?.aborted) throw e; // AbortError: callers ignore it
    throw new DiscoverError(e instanceof Error ? e.message : "Network error", 0);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    const ra = res.headers.get("Retry-After");
    const sec = ra && /^\d+$/.test(ra.trim()) ? Number(ra.trim()) : ra ? Math.max(0, Math.ceil((Date.parse(ra) - Date.now()) / 1000)) : NaN;
    throw new DiscoverError(data.error ?? res.statusText ?? "Request failed", res.status, Number.isFinite(sec) ? sec : null);
  }
  return data as T;
}

export const api = {
  health: () => req<{ ok: boolean; hasLlm: boolean; hasSearch: boolean; devRoutes: boolean; now: string }>("GET", "/health"),

  listConversations: () => req<{ conversations: Conversation[]; projects: Project[] }>("GET", "/api/conversations"),
  getConversation: (id: string) => req<ConversationDetail>("GET", `/api/conversations/${id}`),
  patchConversation: (id: string, patch: { title?: string; pinned?: boolean; projectId?: string | null }) =>
    req<{ ok: true }>("PATCH", `/api/conversations/${id}`, patch),
  deleteConversation: (id: string) => req<{ ok: true }>("DELETE", `/api/conversations/${id}`),

  createProject: (name: string, color?: ProjectColor) => req<{ id: string; name: string; color: ProjectColor }>("POST", "/api/projects", { name, color }),
  renameProject: (id: string, name: string) => req<{ ok: true }>("PATCH", `/api/projects/${id}`, { name }),
  setProjectColor: (id: string, color: ProjectColor) => req<{ ok: true }>("PATCH", `/api/projects/${id}`, { color }),
  deleteProject: (id: string) => req<{ ok: true }>("DELETE", `/api/projects/${id}`),

  searchChats: (q: string) =>
    req<{ results: { id: string; title: string; updated_at: string; snippet: string }[] }>("GET", `/api/search?q=${encodeURIComponent(q)}`),

  moveFile: (id: string, projectId: string | null) => req<{ ok: true }>("PATCH", `/api/attachments/${id}`, { projectId }),
  uploadFile: (f: { name: string; mime?: string; content: string; conversationId?: string; projectId?: string }) =>
    req<AttachmentRef>("POST", "/api/attachments", f),
  /** PDF / XLSX: bytes as base64. The server extracts text (pages / sheets). Errors arrive as ApiError with the server message. */
  uploadBinary: (f: { name: string; mime?: string; contentBase64: string; conversationId?: string; projectId?: string }) =>
    req<AttachmentRef>("POST", "/api/attachments", f),
  listFiles: () => req<{ files: FileRow[] }>("GET", "/api/attachments"),
  getFile: (id: string) => req<AttachmentRef & { content: string }>("GET", `/api/attachments/${id}`),
  deleteFile: (id: string) => req<{ ok: true }>("DELETE", `/api/attachments/${id}`),

  integrations: () => req<Integrations>("GET", "/api/integrations"),
  setTavilyKey: (key: string) => req<Integrations>("PUT", "/api/integrations/tavily", { key }),

  preferences: () => req<Preferences>("GET", "/api/preferences"),
  setPreferences: (patch: Partial<Preferences>) => req<Preferences>("PUT", "/api/preferences", patch),
  /** Downloads every chat and saved claim as one JSON file. */
  exportData: async () => {
    const res = await fetch(API_BASE + "/api/export");
    if (!res.ok) throw new ApiError("Export failed.", res.status);
    return res.blob();
  },
  deleteAllData: () => req<{ ok: true }>("DELETE", "/api/data", { confirm: "DELETE" }),
  testIntegration: (target: "llm" | "search") =>
    req<{ ok: boolean; ms: number; detail?: string; error?: string }>("POST", "/api/integrations/test", { target }),

  suggest: (turnId: string) => req<{ items: string[] }>("POST", "/api/suggest", { turnId }),
  approve: (id: string, approved: boolean) => req<{ ok: true }>("POST", "/api/approve", { id, approved }),
  feedback: (turnId: string, kind: "up" | "down" | null, reason?: string) =>
    req<{ ok: true }>("POST", "/api/feedback", { turnId, kind, reason }),

  runs: () => req<{ runs: RunSummary[] }>("GET", "/api/runs"),
  run: (id: string) => req<RunDetail>("GET", `/api/runs/${id}`),
  stats: () => req<Stats>("GET", "/api/stats"),
  queue: () => req<QueueStats>("GET", "/api/queue"),

  getClock: () => req<{ now: string }>("GET", "/api/dev/clock"),
  setClock: (iso: string) => req<{ now: string }>("POST", "/api/dev/clock", { iso }),
  resetClock: () => req<{ now: string }>("POST", "/api/dev/clock", { clear: true }),

  /* Discover */
  discoverNews: (q: NewsQuery, signal?: AbortSignal) =>
    discoverReq<NewsPage>("GET", `/api/discover/news${discoverQs({ domain: q.domain, q: q.q, limit: q.limit, offset: q.offset })}`, signal),
  discoverStartups: (q: StartupsQuery, signal?: AbortSignal) =>
    discoverReq<StartupsPage>(
      "GET",
      `/api/discover/startups${discoverQs({ sector: q.sector, q: q.q, sort: q.sort, limit: q.limit, offset: q.offset })}`,
      signal,
    ),
  discoverStatus: (signal?: AbortSignal) => discoverReq<DiscoverStatus>("GET", "/api/discover/status", signal),
  discoverRefresh: () => discoverReq<DiscoverRefresh>("POST", "/api/discover/refresh"),
  /** Slow (5–20 s): the server reads the article and asks the model. Cached results come back at once with cached: true. */
  discoverContext: (id: string, signal?: AbortSignal) =>
    discoverReq<{ context: StartupContext; cached: boolean }>("POST", `/api/discover/startups/${encodeURIComponent(id)}/context`, signal),
};

/* ── Streaming chat ──────────────────────────────────────────────────────── */

export type ChatRequest = {
  message: string;
  conversationId?: string;
  tz?: string;
  model?: "auto" | "main" | "fast" | "smart";
  /** How the agent asks before acting: request (every network action), auto (unsafe only, default), full (never). */
  approvalMode?: "request" | "auto" | "full";
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
  onApprovalRequest?: (p: {
    id: string;
    queries: string[];
    actions?: { tool: string; label: string; verb?: string }[];
  }) => void;
  onApprovalResult?: (p: { id: string; approved: boolean }) => void;
  onToolStart?: (p: { tools: { id: string; tool: string; label: string }[] }) => void;
  onToolDone?: (p: { id: string; tool: string; label: string; ms: number; error?: string; duplicate?: boolean }) => void;
  onToken?: (text: string) => void;
  /** Keys are citation numbers. */
  onSources?: (s: Record<string, { url: string; title: string; publishedAt?: string | null }>) => void;
  onDone?: (p: { turnId: string; conversationId: string; trace?: { searchCount: number } }) => void;
  onError?: (message: string) => void;
};

/** Time zone chosen in Settings > Profile (mirrored to localStorage so chat doesn't need a round trip). */
function storedTz(): string {
  try {
    return localStorage.getItem("minimi.tz") || "";
  } catch {
    return "";
  }
}

/** Resolves when the stream ends. Aborting `signal` ends it quietly (no onError). */
export async function streamChat(body: ChatRequest, h: StreamHandlers, signal?: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(API_BASE + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tz: storedTz() || Intl.DateTimeFormat().resolvedOptions().timeZone, ...body }),
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
          case "tool_start": h.onToolStart?.(p); break;
          case "tool_done": h.onToolDone?.(p); break;
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
