import type { AttachmentRef, ChatMessage, MemoryEvent, SearchRef, SourceRef } from "../api";

export type SearchCardData = {
  id: string;
  /** Tool name shown on the card; defaults to web_search. Used by ToolCards + useChat. */
  tool?: string;
  query: string;
  status: "running" | "done" | "error" | "declined";
  ms?: number;
  count?: number;
  cached?: boolean;
  results?: { title: string; url: string }[];
  error?: string;
  batch: number;
};

export type ApprovalData = {
  id: string;
  queries: string[];
  status: "pending" | "approved" | "declined" | "expired";
  expiresAt: number;
};

export type UiMessage = {
  /** Stable slot key (u0,a0,u1,a1…) so a regenerated answer keeps its React identity. */
  key: string;
  id?: string;
  role: "user" | "assistant";
  content: string;
  turnId: string | null;
  versions: string[];
  feedback: ChatMessage["feedback"];
  sources: SourceRef[];
  searches: SearchRef[];
  streaming?: boolean;
  cards?: SearchCardData[];
  memory?: MemoryEvent | null;
  approval?: ApprovalData | null;
  status?: string;
  attachments?: { name: string }[];
};

export interface RunInfo {
  status: "running" | "done" | "error" | "stopped";
  memory: MemoryEvent | null;
  batches: { id: number; queries: string[]; done: number; ms: number }[];
  drafting: "pending" | "running" | "done";
  cited: number;
}

export interface ChatSettings {
  model: "auto" | "main" | "fast" | "smart";
  approval: boolean;
}

export type ToastKind = "info" | "error" | "success";
export type Toast = (message: string, kind?: ToastKind) => void;

export type { AttachmentRef };
