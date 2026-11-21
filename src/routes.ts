import type { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { getConfig } from "./config.js";
import type { DigestQueue } from "./memory/digest.js";
import { readPrefs, sanitizePrefs, writePrefs } from "./preferences.js";
import { friendlyError, maskKey, parseTestTarget, validateTavilyKey } from "./integrations.js";
import { getClock } from "./clock.js";
import { DEFAULT_PROJECT_COLOR, normalizeProjectColor, parseProjectColor } from "./projects.js";
import { newId } from "./util/ids.js";
import { createDefaultSearchProvider, searchProviderName } from "./search/free.js";
import { createLlm } from "./llm/anthropic.js";

/**
 * REST routes for everything around the chat stream: conversation meta, projects, files,
 * integrations, approvals, feedback, runs and stats. The streaming /api/chat lives in server.ts.
 */

type Row = Record<string, any>;
const now = () => getClock().now().toISOString();

// ── Approvals (agent waits for the user before running web searches) ─────────────
const pendingApprovals = new Map<string, (approved: boolean) => void>();

export function waitForApproval(id: string, signal?: AbortSignal, timeoutMs = 120_000): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      clearTimeout(timer);
      pendingApprovals.delete(id);
      resolve(v);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    pendingApprovals.set(id, done);
    signal?.addEventListener("abort", () => done(false), { once: true });
  });
}

// ── Attachments → LLM context ────────────────────────────────────────────────
const MAX_FILE_CHARS = 12_000;
const MAX_TOTAL_CHARS = 24_000;

export function attachmentContext(db: DatabaseSync, conversationId: string | undefined, newIds: string[]): string {
  const rows: Row[] = [];
  if (conversationId) {
    rows.push(
      ...(db
        .prepare(`SELECT id, name, content FROM attachments WHERE conversation_id = ? ORDER BY created_at`)
        .all(conversationId) as Row[]),
    );
  }
  for (const id of newIds) {
    if (rows.some((r) => r.id === id)) continue;
    const r = db.prepare(`SELECT id, name, content FROM attachments WHERE id = ?`).get(id) as Row | undefined;
    if (r) rows.push(r);
  }
  let budget = MAX_TOTAL_CHARS;
  const parts: string[] = [];
  for (const r of rows) {
    if (budget <= 0) break;
    const text = String(r.content).slice(0, Math.min(MAX_FILE_CHARS, budget));
    budget -= text.length;
    parts.push(`[Attached file: ${r.name}]\n${text}`);
  }
  return parts.join("\n\n");
}

export function bindAttachments(db: DatabaseSync, conversationId: string, ids: string[]): void {
  const st = db.prepare(`UPDATE attachments SET conversation_id = ? WHERE id = ? AND conversation_id IS NULL`);
  for (const id of ids) st.run(conversationId, id);
}

// ── Regenerate: keep the old answer as an earlier version of the new one ─────
export function foldRegeneratedTurn(db: DatabaseSync, oldTurnId: string, conversationId: string, newTurnId: string): void {
  const oldTurn = db.prepare(`SELECT * FROM turns WHERE id = ? AND conversation_id = ?`).get(oldTurnId, conversationId) as Row | undefined;
  const newTurn = db.prepare(`SELECT * FROM turns WHERE id = ?`).get(newTurnId) as Row | undefined;
  if (!oldTurn || !newTurn || !oldTurn.assistant_message_id || !newTurn.assistant_message_id) return;

  const oldAsst = db.prepare(`SELECT content FROM messages WHERE id = ?`).get(oldTurn.assistant_message_id) as Row | undefined;
  const oldVersions = db
    .prepare(`SELECT content FROM message_versions WHERE message_id = ? ORDER BY idx`)
    .all(oldTurn.assistant_message_id) as Row[];
  const history = [...oldVersions.map((v) => String(v.content)), ...(oldAsst ? [String(oldAsst.content)] : [])];

  db.exec("BEGIN");
  try {
    history.forEach((content, idx) => {
      db.prepare(`INSERT INTO message_versions (id, message_id, idx, content) VALUES (?,?,?,?)`).run(
        newId("ver"),
        newTurn.assistant_message_id,
        idx,
        content,
      );
    });
    db.prepare(`DELETE FROM traces WHERE turn_id = ?`).run(oldTurnId);
    db.prepare(`DELETE FROM feedback WHERE turn_id = ?`).run(oldTurnId);
    db.prepare(`DELETE FROM turns WHERE id = ?`).run(oldTurnId);
    db.prepare(`DELETE FROM messages WHERE id IN (?, ?)`).run(oldTurn.user_message_id, oldTurn.assistant_message_id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** A regeneration was aborted or failed: drop the half-made turn so the chat has no duplicate question. */
export function discardFailedRegeneration(db: DatabaseSync, conversationId: string, oldTurnId: string): void {
  const old = db.prepare(`SELECT created_at FROM turns WHERE id = ? AND conversation_id = ?`).get(oldTurnId, conversationId) as Row | undefined;
  if (!old) return;
  const extra = db
    .prepare(`SELECT * FROM turns WHERE conversation_id = ? AND id != ? AND created_at >= ? ORDER BY created_at`)
    .all(conversationId, oldTurnId, old.created_at) as Row[];
  db.exec("BEGIN");
  try {
    for (const t of extra) {
      db.prepare(`DELETE FROM traces WHERE turn_id = ?`).run(t.id);
      db.prepare(`DELETE FROM feedback WHERE turn_id = ?`).run(t.id);
      db.prepare(`DELETE FROM turns WHERE id = ?`).run(t.id);
      db.prepare(`DELETE FROM messages WHERE id IN (?, ?)`).run(t.user_message_id, t.assistant_message_id ?? "");
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ── Persisted settings ───────────────────────────────────────────────────────
export function loadSettings(db: DatabaseSync): void {
  const cfg = getConfig();
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'tavily_api_key'`).get() as Row | undefined;
  if (row?.value && !cfg.TAVILY_API_KEY?.trim()) cfg.TAVILY_API_KEY = String(row.value);
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function fileKind(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["md", "markdown"].includes(ext)) return "MD";
  if (["csv", "tsv"].includes(ext)) return "CSV";
  if (ext === "json") return "JSON";
  if (["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "c", "cpp", "html", "css", "sql", "sh", "yml", "yaml", "xml"].includes(ext)) return "CODE";
  return "TXT";
}

export function registerRoutes(app: Hono, db: DatabaseSync, deps: { digest?: DigestQueue } = {}): void {
  loadSettings(db);
  // Files can be filed straight into a folder (project), independent of any chat. Safe to re-run.
  try {
    db.exec(`ALTER TABLE attachments ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL`);
  } catch {
    /* column already exists */
  }
  // Folders carry a color (palette in ./projects.ts). NULL means the default blue. Safe to re-run.
  try {
    db.exec(`ALTER TABLE projects ADD COLUMN color TEXT`);
  } catch {
    /* column already exists */
  }

  // ── Conversations ──────────────────────────────────────────────────────────
  const listConversationsFull = () =>
    (
      db
        .prepare(
          `SELECT c.id, c.title, c.created_at, c.updated_at,
                  (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
                  COALESCE(cm.pinned, 0) AS pinned, cm.project_id AS project_id
           FROM conversations c LEFT JOIN conversation_meta cm ON cm.conversation_id = c.id
           WHERE c.user_id = 'local' ORDER BY c.updated_at DESC`,
        )
        .all() as Row[]
    ).map((r) => ({ ...r, pinned: Boolean(r.pinned) }));

  const listProjects = () =>
    (
      db
      .prepare(
        `SELECT p.id, p.name, p.created_at, p.color,
                (SELECT COUNT(*) FROM conversation_meta cm WHERE cm.project_id = p.id) AS chat_count,
                (SELECT COUNT(*) FROM attachments a LEFT JOIN conversation_meta cm ON cm.conversation_id = a.conversation_id
                   WHERE COALESCE(a.project_id, cm.project_id) = p.id) AS file_count
         FROM projects p ORDER BY p.created_at`,
      )
      .all() as Row[]
    ).map((r) => ({ ...r, color: normalizeProjectColor(r.color) }));

  app.get("/api/conversations", (c) => c.json({ conversations: listConversationsFull(), projects: listProjects() }));

  app.get("/api/conversations/:id", (c) => {
    const id = c.req.param("id");
    const conv = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as Row | undefined;
    if (!conv) return c.json({ error: "not found" }, 404);
    const msgs = db.prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at`).all(id) as Row[];
    const messages = msgs.map((m) => {
      const turn =
        m.role === "assistant"
          ? (db.prepare(`SELECT id FROM turns WHERE assistant_message_id = ?`).get(m.id) as Row | undefined)
          : (db.prepare(`SELECT id FROM turns WHERE user_message_id = ?`).get(m.id) as Row | undefined);
      const turnId: string | null = turn?.id ?? null;
      const versions =
        m.role === "assistant"
          ? (db.prepare(`SELECT content FROM message_versions WHERE message_id = ? ORDER BY idx`).all(m.id) as Row[]).map((v) => String(v.content))
          : [];
      const fb = turnId ? (db.prepare(`SELECT kind, reason FROM feedback WHERE turn_id = ?`).get(turnId) as Row | undefined) : undefined;
      const sources =
        m.role === "assistant" && turnId
          ? (db.prepare(`SELECT n, url, title, published_at FROM sources WHERE turn_id = ? ORDER BY n`).all(turnId) as Row[])
          : [];
      const searches =
        m.role === "assistant" && turnId
          ? (db.prepare(`SELECT detail, duration_ms FROM traces WHERE turn_id = ? AND stage = 'search' ORDER BY id`).all(turnId) as Row[])
          : [];
      return {
        id: m.id,
        role: m.role,
        content: m.content,
        created_at: m.created_at,
        turn_id: turnId,
        versions,
        feedback: fb ? { kind: fb.kind, reason: fb.reason ?? null } : null,
        sources: sources.map((s) => ({ n: s.n, url: s.url, title: s.title ?? s.url, published_at: s.published_at ?? null })),
        searches: searches.flatMap((s) => {
          try {
            const d = JSON.parse(s.detail ?? "{}") as { queries?: { query: string; durationMs: number }[] };
            return (d.queries ?? []).map((q) => ({ query: q.query, ms: q.durationMs }));
          } catch {
            return [];
          }
        }),
      };
    });
    const attachments = db
      .prepare(`SELECT id, name, mime, size, created_at FROM attachments WHERE conversation_id = ? ORDER BY created_at`)
      .all(id) as Row[];
    const meta = db.prepare(`SELECT pinned, project_id FROM conversation_meta WHERE conversation_id = ?`).get(id) as Row | undefined;
    return c.json({
      conversation: { ...conv, pinned: Boolean(meta?.pinned), project_id: meta?.project_id ?? null },
      messages,
      attachments: attachments.map((a) => ({ ...a, kind: fileKind(a.name) })),
    });
  });

  app.patch("/api/conversations/:id", async (c) => {
    const id = c.req.param("id");
    if (!db.prepare(`SELECT 1 FROM conversations WHERE id = ?`).get(id)) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json()) as { title?: string; pinned?: boolean; projectId?: string | null };
    if (typeof body.title === "string") {
      const t = body.title.trim().slice(0, 120);
      if (!t) return c.json({ error: "title required" }, 400);
      db.prepare(`UPDATE conversations SET title = ? WHERE id = ?`).run(t, id);
    }
    if (body.projectId) {
      if (!db.prepare(`SELECT 1 FROM projects WHERE id = ?`).get(body.projectId)) return c.json({ error: "project not found" }, 404);
    }
    if (body.pinned !== undefined || body.projectId !== undefined) {
      db.prepare(`INSERT OR IGNORE INTO conversation_meta (conversation_id) VALUES (?)`).run(id);
      if (body.pinned !== undefined) db.prepare(`UPDATE conversation_meta SET pinned = ? WHERE conversation_id = ?`).run(body.pinned ? 1 : 0, id);
      if (body.projectId !== undefined) db.prepare(`UPDATE conversation_meta SET project_id = ? WHERE conversation_id = ?`).run(body.projectId, id);
    }
    return c.json({ ok: true });
  });

  app.delete("/api/conversations/:id", (c) => {
    const id = c.req.param("id");
    db.exec("BEGIN");
    try {
      const turns = db.prepare(`SELECT id FROM turns WHERE conversation_id = ?`).all(id) as Row[];
      for (const t of turns) {
        db.prepare(`DELETE FROM traces WHERE turn_id = ?`).run(t.id);
        db.prepare(`DELETE FROM feedback WHERE turn_id = ?`).run(t.id);
      }
      db.prepare(`DELETE FROM turns WHERE conversation_id = ?`).run(id);
      db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      return c.json({ error: e instanceof Error ? e.message : "delete failed" }, 500);
    }
    return c.json({ ok: true });
  });

  // ── Projects ───────────────────────────────────────────────────────────────
  app.post("/api/projects", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; color?: unknown };
    const name = body.name?.trim().slice(0, 60);
    if (!name) return c.json({ error: "name required" }, 400);
    let color = DEFAULT_PROJECT_COLOR;
    if (body.color !== undefined && body.color !== null) {
      const parsed = parseProjectColor(body.color);
      if (!parsed) return c.json({ error: "invalid color" }, 400);
      color = parsed;
    }
    const id = newId("prj");
    db.prepare(`INSERT INTO projects (id, name, created_at, color) VALUES (?,?,?,?)`).run(id, name, now(), color);
    return c.json({ id, name, color });
  });
  app.patch("/api/projects/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; color?: unknown };
    const id = c.req.param("id");
    if (!db.prepare(`SELECT 1 FROM projects WHERE id = ?`).get(id)) return c.json({ error: "project not found" }, 404);
    const hasName = body.name !== undefined;
    const hasColor = body.color !== undefined;
    if (!hasName && !hasColor) return c.json({ error: "name or color required" }, 400);
    if (hasName) {
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
      if (!name) return c.json({ error: "name required" }, 400);
      db.prepare(`UPDATE projects SET name = ? WHERE id = ?`).run(name, id);
    }
    if (hasColor) {
      const color = parseProjectColor(body.color);
      if (!color) return c.json({ error: "invalid color" }, 400);
      db.prepare(`UPDATE projects SET color = ? WHERE id = ?`).run(color, id);
    }
    return c.json({ ok: true });
  });
  app.delete("/api/projects/:id", (c) => {
    db.prepare(`DELETE FROM projects WHERE id = ?`).run(c.req.param("id"));
    return c.json({ ok: true });
  });

  // ── Search across chats ────────────────────────────────────────────────────
  app.get("/api/search", (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (!q) return c.json({ results: [] });
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const rows = db
      .prepare(
        `SELECT c.id, c.title, c.updated_at,
                (SELECT m.content FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ? ESCAPE '\\' LIMIT 1) AS hit
         FROM conversations c
         WHERE c.user_id = 'local' AND (c.title LIKE ? ESCAPE '\\' OR EXISTS
           (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ? ESCAPE '\\'))
         ORDER BY c.updated_at DESC LIMIT 30`,
      )
      .all(like, like, like) as Row[];
    const results = rows.map((r) => {
      let snippet = "";
      if (r.hit) {
        const text = String(r.hit).replace(/\s+/g, " ");
        const i = text.toLowerCase().indexOf(q.toLowerCase());
        snippet = text.slice(Math.max(0, i - 40), Math.max(0, i - 40) + 120);
      }
      return { id: r.id, title: r.title ?? "Chat", updated_at: r.updated_at, snippet };
    });
    return c.json({ results });
  });

  // ── Files (attachments) ────────────────────────────────────────────────────
  app.post("/api/attachments", async (c) => {
    const body = (await c.req.json()) as { name?: string; mime?: string; content?: string; conversationId?: string; projectId?: string };
    const name = body.name?.trim().slice(0, 200);
    if (!name || typeof body.content !== "string") return c.json({ error: "name and content required" }, 400);
    if (body.content.includes("\u0000")) return c.json({ error: "Only text files are supported" }, 415);
    if (body.content.length > 500_000) return c.json({ error: "File too large (max 500 KB of text)" }, 413);
    if (!body.content.trim()) return c.json({ error: "File is empty" }, 400);
    let conversationId: string | null = null;
    if (body.conversationId) {
      if (!db.prepare(`SELECT 1 FROM conversations WHERE id = ?`).get(body.conversationId)) return c.json({ error: "conversation not found" }, 404);
      conversationId = body.conversationId;
    }
    let projectId: string | null = null;
    if (body.projectId) {
      if (!db.prepare(`SELECT 1 FROM projects WHERE id = ?`).get(body.projectId)) return c.json({ error: "folder not found" }, 404);
      projectId = body.projectId;
    }
    const id = newId("fil");
    db.prepare(`INSERT INTO attachments (id, conversation_id, name, mime, size, content, created_at, project_id) VALUES (?,?,?,?,?,?,?,?)`).run(
      id,
      conversationId,
      name,
      body.mime ?? null,
      body.content.length,
      body.content,
      now(),
      projectId,
    );
    return c.json({ id, name, size: body.content.length, kind: fileKind(name) });
  });

  app.get("/api/attachments", (c) => {
    const rows = db
      .prepare(
        `SELECT a.id, a.name, a.mime, a.size, a.created_at, a.conversation_id, c.title AS conversation_title,
                COALESCE(a.project_id, cm.project_id) AS project_id, p.name AS project_name
         FROM attachments a
         LEFT JOIN conversations c ON c.id = a.conversation_id
         LEFT JOIN conversation_meta cm ON cm.conversation_id = a.conversation_id
         LEFT JOIN projects p ON p.id = COALESCE(a.project_id, cm.project_id)
         ORDER BY a.created_at DESC`,
      )
      .all() as Row[];
    return c.json({ files: rows.map((r) => ({ ...r, kind: fileKind(r.name) })) });
  });
  app.get("/api/attachments/:id", (c) => {
    const r = db.prepare(`SELECT id, name, mime, size, content FROM attachments WHERE id = ?`).get(c.req.param("id")) as Row | undefined;
    if (!r) return c.json({ error: "not found" }, 404);
    return c.json({ ...r, kind: fileKind(r.name) });
  });
  // Move a file into a folder, or out of one (projectId: null).
  app.patch("/api/attachments/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { projectId?: string | null };
    if (!("projectId" in body)) return c.json({ error: "projectId required" }, 400);
    if (body.projectId && !db.prepare(`SELECT 1 FROM projects WHERE id = ?`).get(body.projectId)) return c.json({ error: "folder not found" }, 404);
    const res = db.prepare(`UPDATE attachments SET project_id = ? WHERE id = ?`).run(body.projectId ?? null, c.req.param("id"));
    if (!res.changes) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });
  app.delete("/api/attachments/:id", (c) => {
    db.prepare(`DELETE FROM attachments WHERE id = ?`).run(c.req.param("id"));
    return c.json({ ok: true });
  });

  // ── Integrations ───────────────────────────────────────────────────────────
  const integrations = () => {
    const cfg = getConfig();
    const usingAnthropic = Boolean(cfg.ANTHROPIC_API_KEY?.trim());
    return {
      llm: {
        provider: usingAnthropic ? "Anthropic" : "NVIDIA NIM",
        connected: cfg.hasLlm,
        mainModel: cfg.MODEL_MAIN,
        fastModel: cfg.MODEL_FAST,
        smartModel: cfg.MODEL_SMART,
      },
      search: {
        provider: searchProviderName(),
        hasTavilyKey: Boolean(cfg.TAVILY_API_KEY?.trim()),
        /** Last 4 chars only; the key itself is never sent to the browser. */
        keyHint: maskKey(cfg.TAVILY_API_KEY),
        connected: true,
      },
      timezone: cfg.DEFAULT_TZ,
      security: { accessProtected: Boolean(cfg.ACCESS_TOKEN?.trim()) },
    };
  };
  app.get("/api/integrations", (c) => c.json(integrations()));

  app.put("/api/integrations/tavily", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { key?: unknown } | null;
    if (!body || typeof body !== "object") return c.json({ error: "Send a JSON body like {\"key\": \"...\"}." }, 400);
    const cfg = getConfig();
    const raw = typeof body.key === "string" ? body.key.trim() : body.key;
    if (raw === "" || raw === undefined || raw === null) {
      db.prepare(`DELETE FROM settings WHERE key = 'tavily_api_key'`).run();
      cfg.TAVILY_API_KEY = "";
      return c.json(integrations());
    }
    const check = validateTavilyKey(raw);
    if (!check.ok) return c.json({ error: check.error }, 400);
    db.prepare(`INSERT INTO settings (key, value) VALUES ('tavily_api_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(check.key);
    cfg.TAVILY_API_KEY = check.key;
    return c.json(integrations());
  });

  app.post("/api/integrations/test", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { target?: unknown } | null;
    const target = parseTestTarget(body?.target);
    if (!target) return c.json({ ok: false, ms: 0, error: "Unknown target." }, 400);
    const t0 = Date.now();
    try {
      if (target === "llm") {
        if (!getConfig().hasLlm) return c.json({ ok: false, ms: 0, error: "No API key is configured. Set it in the server .env." });
        const llm = await createLlm();
        const out = await Promise.race([
          llm.json<{ ok: boolean }>({
            model: getConfig().MODEL_FAST,
            system: "Reply with JSON only.",
            user: 'Return exactly {"ok": true}',
          }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 20_000)),
        ]);
        const ok = Boolean(out?.ok);
        return c.json({ ok, ms: Date.now() - t0, detail: ok ? "Model replied" : undefined, error: ok ? undefined : "The model replied, but not in the expected format." });
      }
      const results = await createDefaultSearchProvider().search({ query: "wikipedia" }, AbortSignal.timeout(12_000));
      const ok = results.length > 0;
      return c.json({ ok, ms: Date.now() - t0, detail: `${results.length} results`, error: ok ? undefined : "The search returned no results." });
    } catch (err) {
      return c.json({ ok: false, ms: Date.now() - t0, error: friendlyError(err) });
    }
  });

  // ── Approvals & feedback ───────────────────────────────────────────────────
  app.post("/api/approve", async (c) => {
    const body = (await c.req.json()) as { id?: string; approved?: boolean };
    const fn = body.id ? pendingApprovals.get(body.id) : undefined;
    if (!fn) return c.json({ error: "no pending approval (it may have timed out)" }, 404);
    fn(Boolean(body.approved));
    return c.json({ ok: true });
  });

  app.post("/api/feedback", async (c) => {
    const body = (await c.req.json()) as { turnId?: string; kind?: "up" | "down" | null; reason?: string };
    if (!body.turnId || !db.prepare(`SELECT 1 FROM turns WHERE id = ?`).get(body.turnId)) return c.json({ error: "turn not found" }, 404);
    if (!body.kind) {
      db.prepare(`DELETE FROM feedback WHERE turn_id = ?`).run(body.turnId);
    } else {
      db.prepare(
        `INSERT INTO feedback (turn_id, kind, reason, created_at) VALUES (?,?,?,?)
         ON CONFLICT(turn_id) DO UPDATE SET kind = excluded.kind, reason = COALESCE(excluded.reason, feedback.reason)`,
      ).run(body.turnId, body.kind, body.reason?.slice(0, 300) ?? null, now());
    }
    return c.json({ ok: true });
  });

  // ── Follow-up suggestions (called by the client after an answer finishes) ─────────
  app.post("/api/suggest", async (c) => {
    const body = (await c.req.json()) as { turnId?: string };
    const t = db
      .prepare(
        `SELECT um.content AS q, am.content AS a FROM turns t
         JOIN messages um ON um.id = t.user_message_id
         LEFT JOIN messages am ON am.id = t.assistant_message_id WHERE t.id = ?`,
      )
      .get(body.turnId ?? "") as Row | undefined;
    if (!t?.a) return c.json({ items: [] });
    try {
      const llm = await createLlm();
      const r = await llm.json<{ questions?: unknown }>({
        model: getConfig().MODEL_MAIN,
        system:
          'You suggest follow-up questions a user might ask next. Reply with JSON only: {"questions": ["...", "...", "..."]}. Exactly 3 questions, each under 9 words, specific to the topic, phrased the way the user would type them. Never repeat the original question.',
        user: `Question: ${String(t.q).slice(0, 400)}

Answer: ${String(t.a).slice(0, 1200)}`,
        signal: AbortSignal.timeout(8000),
      });
      const items = (Array.isArray(r?.questions) ? r.questions : [])
        .filter((x): x is string => typeof x === "string" && x.trim().length > 3)
        .map((x) => x.trim().replace(/^[-*0-9.) ]+/, "").slice(0, 90))
        .slice(0, 3);
      return c.json({ items });
    } catch {
      return c.json({ items: [] }); // suggestions are a nicety; never an error
    }
  });

  // ── Runs (one per turn) ────────────────────────────────────────────────────
  const runSummary = (turnId: string) => {
    const traces = db.prepare(`SELECT stage, started_ms, duration_ms, detail FROM traces WHERE turn_id = ? ORDER BY id`).all(turnId) as Row[];
    const total = traces.reduce((mx, r) => Math.max(mx, r.started_ms + r.duration_ms), 0);
    const llm = traces.find((r) => r.stage === "llm_step");
    let steps = 0;
    let toolCalls = 0;
    try {
      const d = JSON.parse(llm?.detail ?? "{}") as { steps?: number; searches?: number };
      steps = d.steps ?? 0;
      toolCalls = d.searches ?? 0;
    } catch {
      /* ignore */
    }
    return { traces, total, steps, toolCalls };
  };

  app.get("/api/runs", (c) => {
    const turns = db
      .prepare(
        `SELECT t.id, t.conversation_id, t.created_at, t.status, c.title AS conversation_title,
                um.content AS question, am.content AS answer
         FROM turns t
         JOIN conversations c ON c.id = t.conversation_id
         JOIN messages um ON um.id = t.user_message_id
         LEFT JOIN messages am ON am.id = t.assistant_message_id
         ORDER BY t.created_at DESC LIMIT 100`,
      )
      .all() as Row[];
    return c.json({
      runs: turns.map((t) => {
        const s = runSummary(t.id);
        const sources = (db.prepare(`SELECT COUNT(*) AS n FROM sources WHERE turn_id = ?`).get(t.id) as Row).n as number;
        return {
          id: t.id,
          conversation_id: t.conversation_id,
          conversation_title: t.conversation_title ?? "Chat",
          question: String(t.question).slice(0, 200),
          answer_preview: t.answer ? String(t.answer).slice(0, 200) : "",
          status: t.status,
          created_at: t.created_at,
          steps: s.steps,
          tool_calls: s.toolCalls,
          duration_ms: s.total,
          sources,
        };
      }),
    });
  });

  app.get("/api/runs/:id", (c) => {
    const t = db
      .prepare(
        `SELECT t.id, t.conversation_id, t.created_at, t.status, t.tz, c.title AS conversation_title,
                um.content AS question, am.content AS answer
         FROM turns t JOIN conversations c ON c.id = t.conversation_id
         JOIN messages um ON um.id = t.user_message_id
         LEFT JOIN messages am ON am.id = t.assistant_message_id WHERE t.id = ?`,
      )
      .get(c.req.param("id")) as Row | undefined;
    if (!t) return c.json({ error: "not found" }, 404);
    const s = runSummary(t.id);
    const sources = db.prepare(`SELECT n, url, title FROM sources WHERE turn_id = ? ORDER BY n`).all(t.id) as Row[];
    const steps = s.traces.map((r) => {
      let detail: unknown = null;
      try {
        detail = r.detail ? JSON.parse(r.detail) : null;
      } catch {
        detail = r.detail;
      }
      return { stage: r.stage, started_ms: r.started_ms, duration_ms: r.duration_ms, detail };
    });
    return c.json({
      id: t.id,
      conversation_id: t.conversation_id,
      conversation_title: t.conversation_title ?? "Chat",
      question: t.question,
      answer: t.answer ?? "",
      status: t.status,
      created_at: t.created_at,
      duration_ms: s.total,
      steps,
      tool_calls: s.toolCalls,
      sources: sources.map((x) => ({ n: x.n, url: x.url, title: x.title ?? x.url, host: host(x.url) })),
    });
  });

  // ── Preferences, export and data deletion (Settings view) ───────────────────
  app.get("/api/preferences", (c) => c.json(readPrefs(db)));

  app.put("/api/preferences", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON." }, 400);
    }
    const r = sanitizePrefs(body);
    if (!r.ok) return c.json({ error: r.error }, 400);
    return c.json(writePrefs(db, r.patch));
  });

  /** Everything the user created, as one JSON file. */
  app.get("/api/export", (c) => {
    const convs = db.prepare(`SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = 'local' ORDER BY created_at`).all() as Row[];
    const msgs = db.prepare(`SELECT id, conversation_id, role, content, created_at FROM messages ORDER BY created_at`).all() as Row[];
    const byConv = new Map<string, Row[]>();
    for (const m of msgs) {
      const k = String(m.conversation_id);
      byConv.set(k, [...(byConv.get(k) ?? []), { id: m.id, role: m.role, content: m.content, created_at: m.created_at }]);
    }
    const claims = db.prepare(`SELECT turn_id, subject, attribute, value, as_of, source_url FROM claims`).all() as Row[];
    c.header("Content-Disposition", `attachment; filename="minimi-export.json"`);
    return c.json({
      exportedAt: getClock().now().toISOString(),
      preferences: readPrefs(db),
      conversations: convs.map((v) => ({ ...v, messages: byConv.get(String(v.id)) ?? [] })),
      claims,
    });
  });

  /** Deletes all chats and what the agent remembered from them. Keeps folders, preferences and API keys. */
  app.delete("/api/data", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { confirm?: string };
    if (body.confirm !== "DELETE") return c.json({ error: "Confirmation missing." }, 400);
    db.exec("BEGIN");
    try {
      for (const t of ["feedback", "traces", "claims", "sources", "message_versions", "attachments", "turns", "messages", "conversation_meta", "conversations", "search_cache"]) {
        db.exec(`DELETE FROM ${t}`);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      return c.json({ error: e instanceof Error ? e.message : "Delete failed." }, 500);
    }
    return c.json({ ok: true });
  });

  // ── Background queue (Analytics view): the memory-digest worker pool ───────
  app.get("/api/queue", (c) => {
    const digest = deps.digest;
    if (!digest) return c.json({ available: false });
    const snap = digest.snapshot();
    const label = (id: string) => {
      const r = db
        .prepare(`SELECT um.content AS q FROM turns t JOIN messages um ON um.id = t.user_message_id WHERE t.id = ?`)
        .get(id) as Row | undefined;
      const q = String(r?.q ?? "").replace(/\s+/g, " ").trim();
      return q.length > 60 ? q.slice(0, 59) + "…" : q || "Untitled turn";
    };
    // Persisted counts, so the totals survive a restart.
    const counts = db.prepare(`SELECT digest_status AS s, COUNT(*) AS n FROM turns WHERE is_demo = 0 GROUP BY digest_status`).all() as Row[];
    const n = (s: string) => Number(counts.find((r) => r.s === s)?.n ?? 0);
    return c.json({
      available: true,
      name: "memory-digest",
      model: snap.model,
      capacity: snap.concurrency,
      waiting: snap.waiting.map((j) => ({ id: j.id, label: label(j.id) })),
      running: snap.running.map((j) => ({ id: j.id, label: label(j.id), startedAt: j.startedAt })),
      throughputPerMin: snap.throughputPerMin,
      waitP95Ms: snap.waitP95Ms,
      history: snap.history,
      windowMs: snap.windowMs,
      done: n("done"),
      failed: n("failed"),
    });
  });

  // ── Stats (Analytics view) ─────────────────────────────────────────────────
  app.get("/api/stats", (c) => {
    const one = (sql: string) => (db.prepare(sql).get() as Row) ?? {};
    const totals = {
      conversations: one(`SELECT COUNT(*) AS n FROM conversations`).n as number,
      turns: one(`SELECT COUNT(*) AS n FROM turns WHERE is_demo = 0`).n as number,
      sources: one(`SELECT COUNT(*) AS n FROM sources`).n as number,
      files: one(`SELECT COUNT(*) AS n FROM attachments`).n as number,
      thumbsUp: one(`SELECT COUNT(*) AS n FROM feedback WHERE kind = 'up'`).n as number,
      thumbsDown: one(`SELECT COUNT(*) AS n FROM feedback WHERE kind = 'down'`).n as number,
    };
    const searchRows = db.prepare(`SELECT detail FROM traces WHERE stage = 'search'`).all() as Row[];
    let searches = 0;
    for (const r of searchRows) {
      try {
        searches += (JSON.parse(r.detail ?? "{}") as { count?: number }).count ?? 0;
      } catch {
        /* ignore */
      }
    }
    // started_ms is offset from turn start → max(start+duration) is wall-clock length of that turn.
    // Exclude demo turns so Analytics matches the Questions tile. Caller: GET /api/stats → AnalyticsView.
    // User: "analytics is it showing original data... fix... stars how it was calculating"
    const durations = db
      .prepare(
        `SELECT turn_id, MAX(started_ms + duration_ms) AS ms FROM traces
         WHERE turn_id IN (SELECT id FROM turns WHERE is_demo = 0)
         GROUP BY turn_id`,
      )
      .all() as Row[];
    const avgMs = durations.length ? Math.round(durations.reduce((a, r) => a + Number(r.ms ?? 0), 0) / durations.length) : 0;
    const perDay = db
      .prepare(`SELECT local_date AS date, COUNT(*) AS turns FROM turns WHERE is_demo = 0 GROUP BY local_date ORDER BY local_date DESC LIMIT 14`)
      .all() as Row[];
    // ~34 weeks of per-day questions for the home heatmap (local_date is the user's own calendar day).
    const since = new Date(Date.now() - 250 * 86_400_000).toISOString().slice(0, 10);
    const activity = db
      .prepare(`SELECT local_date AS date, COUNT(*) AS turns FROM turns WHERE is_demo = 0 AND local_date >= ? GROUP BY local_date ORDER BY local_date`)
      .all(since) as Row[];
    const urls = db.prepare(`SELECT url FROM sources`).all() as Row[];
    const byHost = new Map<string, number>();
    for (const u of urls) {
      const h = host(String(u.url));
      if (h) byHost.set(h, (byHost.get(h) ?? 0) + 1);
    }
    const topDomains = [...byHost.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([domain, count]) => ({ domain, count }));
    return c.json({ totals: { ...totals, searches, avgMs }, perDay: perDay.reverse(), activity, topDomains });
  });
}
