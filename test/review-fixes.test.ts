import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { PermissionGate } from "../src/agent/permissions.js";
import { migrate } from "../src/db.js";
import { saveMemory } from "../src/memory/saved.js";
import { attachmentContext } from "../src/routes.js";
import { TurnCitationRegistry } from "../src/search/tool.js";
import {
  ToolInputError,
  executeToolCall,
  registerTool,
  unregisterTool,
  type ToolContext,
  type ToolDefinition,
} from "../src/tools/registry.js";

/** Regression tests for problems found in the independent review of the tool-ecosystem upgrade. */

function memDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  migrate(db);
  return db;
}

function ctxOf(db: DatabaseSync): ToolContext {
  return { db, registry: new TurnCitationRegistry(), counts: {} };
}

describe("approval gate: save_memory", () => {
  it("asks for writes but not for the read-only list/search actions", () => {
    const db = memDb();
    const gate = new PermissionGate(true, "auto", ctxOf(db));
    const ask = (input: unknown) => gate.callsNeedingPrompt([{ id: "x", name: "save_memory", input }]).length;
    expect(ask({ action: "save", text: "I prefer metric units" })).toBe(1);
    expect(ask({ action: "forget", id: "mem_1" })).toBe(1);
    expect(ask({ action: "update", id: "mem_1", text: "new text" })).toBe(1);
    expect(ask({ action: "list" })).toBe(0);
    expect(ask({ action: "search", query: "units" })).toBe(0);
    // a read-only call is allowed without any recorded decision, a write is not
    expect(gate.allows("save_memory", { action: "list" }, "a")).toBe(true);
    expect(gate.allows("save_memory", { action: "save", text: "I prefer metric units" }, "b")).toBe(false);
  });

  it("the approval prompt for forget/update shows the memory text, not just an opaque id", () => {
    const db = memDb();
    const { memory } = saveMemory(db, { text: "My dentist is Dr Rao" });
    const gate = new PermissionGate(true, "auto", ctxOf(db));
    const forget = gate.actionFor({ id: "c", name: "save_memory", input: { action: "forget", id: memory.id } });
    expect(forget.verb).toBeTruthy();
    expect(forget.label).toContain("My dentist is Dr Rao");
    const update = gate.actionFor({ id: "d", name: "save_memory", input: { action: "update", id: memory.id, text: "My dentist is Dr Iyer" } });
    expect(update.label).toContain("Dr Rao");
    expect(update.label).toContain("Dr Iyer");
  });

  it("an unknown memory id still produces a safe prompt (no throw)", () => {
    const gate = new PermissionGate(true, "auto", ctxOf(memDb()));
    expect(() => gate.actionFor({ id: "c", name: "save_memory", input: { action: "forget", id: "nope" } })).not.toThrow();
  });
});

describe("registry: per-turn limit under parallel calls", () => {
  const names: string[] = [];
  afterEach(() => {
    while (names.length) unregisterTool(names.pop()!);
  });

  it("never runs more than maxPerTurn even when all calls start together", async () => {
    let ran = 0;
    const def: ToolDefinition<{ q: string }> = {
      name: "zz_par",
      schema: { name: "zz_par", description: "x", input_schema: { type: "object", properties: { q: { type: "string" } } } },
      validate: (raw) => {
        const p = z.object({ q: z.string() }).safeParse(raw);
        if (!p.success) throw new ToolInputError("bad");
        return p.data;
      },
      maxPerTurn: 2,
      run: async () => {
        ran += 1;
        await new Promise((r) => setTimeout(r, 20));
        return { content: "<ok/>" };
      },
    };
    registerTool(def as ToolDefinition);
    names.push("zz_par");
    const ctx = ctxOf(memDb());
    const results = await Promise.all(
      ["a", "b", "c", "d", "e", "f"].map((q, i) => executeToolCall({ id: String(i), name: "zz_par", input: { q } }, ctx, true)),
    );
    expect(ran).toBe(2);
    expect(results.filter((r) => r.error && /limit reached/.test(r.error))).toHaveLength(4);
  });
});

describe("attachments: stale conversation id", () => {
  it("attachmentContext does not throw (FK violation) for a conversation that no longer exists", () => {
    const db = memDb();
    db.prepare(`INSERT INTO attachments (id, conversation_id, name, mime, size, content, created_at) VALUES ('fil_1', NULL, 'a.txt', 'text/plain', 5, 'hello', '2026-11-24T00:00:00Z')`).run();
    expect(() => attachmentContext(db, "conv_deleted", ["fil_1"])).not.toThrow();
    expect(attachmentContext(db, "conv_deleted", ["fil_1"])).toContain("a.txt");
  });
});
