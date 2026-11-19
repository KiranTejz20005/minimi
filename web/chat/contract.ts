import type { Integrations } from "../api";

/** Props the shell passes to the chat view. OWNED BY THE LEAD — do not edit. */
export interface ChatViewProps {
  /** undefined = a brand-new chat (landing state with suggestion chips). */
  conversationId: string | undefined;
  integrations: Integrations | null;
  /** First turn of a new chat finished and the conversation now exists. */
  onConversationCreated: (id: string) => void;
  /** Titles / ordering / counts changed — the sidebar should refetch. */
  onChanged: () => void;
  /** User clicked "view run" on a message — open it in the Runs view. */
  onOpenRun: (turnId: string) => void;
  /** Bump to focus the composer (e.g. after "New chat" or Ctrl+K → Enter). */
  focusToken: number;
  /** Open the Integrations modal (e.g. from the empty "Connectors" row). */
  onOpenIntegrations: () => void;
}

/** A search/approval the agent is waiting on. Shared between chat (producer) and Runs view (consumer). */
export interface PendingApproval {
  id: string;
  conversationId: string | undefined;
  queries: string[];
  createdAt: number;
}
