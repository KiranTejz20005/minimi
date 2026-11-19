import { useSyncExternalStore } from "react";
import type { PendingApproval } from "./contract";

/** Tiny shared store of approvals the agent is waiting on. Chat view writes; shell reads (Runs badge / panel). */
let items: PendingApproval[] = [];
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export const approvals = {
  add(a: PendingApproval) {
    items = [...items.filter((x) => x.id !== a.id), a];
    emit();
  },
  remove(id: string) {
    items = items.filter((x) => x.id !== id);
    emit();
  },
  list: () => items,
  subscribe(fn: () => void) {
    subs.add(fn);
    return () => subs.delete(fn);
  },
};

export function usePendingApprovals(): PendingApproval[] {
  return useSyncExternalStore(approvals.subscribe, approvals.list, approvals.list);
}
