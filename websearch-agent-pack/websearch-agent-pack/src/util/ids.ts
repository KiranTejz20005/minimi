import { randomUUID } from "node:crypto";

export function newId(prefix?: string): string {
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  return prefix ? `${prefix}_${id}` : id;
}
