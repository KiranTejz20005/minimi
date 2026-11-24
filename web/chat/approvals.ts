import { useSyncExternalStore } from "react";
import type { PendingApproval as BaseApproval } from "./contract";
import type { ApprovalAction } from "./tools";

/** contract.ts is lead-owned; `actions` (verb + exact label) is an optional extension carried through the store. */
export type PendingApproval = BaseApproval & { actions?: ApprovalAction[] };

/** Tiny shared store of approvals. Chat writes; Runs reads pending + recent resolved. */
export type ResolvedApproval = PendingApproval & {
  status: "approved" | "declined" | "expired";
  resolvedAt: number;
};

let items: PendingApproval[] = [];
let recent: ResolvedApproval[] = [];
const MAX_RECENT = 12;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/* Callers: useChat.ts, RunsView.tsx, ToolCards via api.approve. User: approved items not visible in Needs your input. */
export const approvals = {
  add(a: PendingApproval) {
    items = [...items.filter((x) => x.id !== a.id), a];
    emit();
  },
  /** Archive so Runs still shows what you decided after Approve/Decline */
  resolve(id: string, status: ResolvedApproval["status"]) {
    const hit = items.find((x) => x.id === id);
    items = items.filter((x) => x.id !== id);
    if (hit) {
      recent = [{ ...hit, status, resolvedAt: Date.now() }, ...recent.filter((x) => x.id !== id)].slice(0, MAX_RECENT);
    }
    emit();
  },
  remove(id: string) {
    items = items.filter((x) => x.id !== id);
    emit();
  },
  list: () => items,
  recent: () => recent,
  subscribe(fn: () => void) {
    subs.add(fn);
    return () => subs.delete(fn);
  },
};

export function usePendingApprovals(): PendingApproval[] {
  return useSyncExternalStore(approvals.subscribe, approvals.list, approvals.list);
}

export function useRecentApprovals(): ResolvedApproval[] {
  return useSyncExternalStore(approvals.subscribe, approvals.recent, approvals.recent);
}
