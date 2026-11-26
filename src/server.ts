import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono, type Context, type Next } from "hono";
import { streamSSE } from "hono/streaming";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { basicAuth } from "hono/basic-auth";
import { logger } from "hono/logger";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, requireChatKeys } from "./config.js";
import { getClock, setClock, clockFromEnv, FixedClock } from "./clock.js";
import { getDb } from "./db.js";
import { MemoryStore } from "./memory/store.js";
import { getTracesForTurn } from "./memory/store.js";
import {
  registerRoutes,
  waitForApproval,
  attachmentContext,
  bindAttachments,
  foldRegeneratedTurn,
  discardFailedRegeneration,
} from "./routes.js";
import { newId } from "./util/ids.js";
import { parseApprovalMode } from "./agent/permissions.js";
import { runTurn, importConversations, getDigestQueue } from "./agent/run-turn.js";
import { registerDiscoverRoutes } from "./discover/routes.js";
import { startDiscoverScheduler } from "./discover/scheduler.js";
import { buildWeb } from "../scripts/build-web-lib.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = getConfig();
setClock(clockFromEnv());
const db = getDb();
const store = new MemoryStore(db);
const digest = getDigestQueue(db); // same instance runTurn enqueues into, so /api/queue sees real jobs
digest.retryPending();

buildWeb(root);

const app = new Hono();

// ── Production hardening ────────────────────────────────────────────────────
if (cfg.isProduction) app.use("*", logger());
app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // tiny inline theme bootstrap in index.html
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
    referrerPolicy: "no-referrer",
  }),
);
// Split deploy: allow the separately hosted frontend (CORS_ORIGIN) to call the API. Registered before auth
// so browser preflight (OPTIONS) requests are answered rather than rejected with 401.
const corsOrigins = (cfg.CORS_ORIGIN ?? "").split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean);
if (corsOrigins.length) {
  app.use(
    "*",
    cors({
      origin: (origin) => (corsOrigins.includes(origin) ? origin : null),
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      maxAge: 600,
    }),
  );
}
// CSRF + DNS-rebinding guard. The API has no per-request secret when ACCESS_TOKEN is unset, so a web page the user visits
// could otherwise POST to it (simple cross-site requests need no preflight) or rebind its hostname to 127.0.0.1.
const loopbackBind = ["127.0.0.1", "localhost", "::1"].includes(cfg.HOST);
app.use("/api/*", async (c, next) => {
  const host = (c.req.header("host") ?? "").toLowerCase();
  if (loopbackBind && cfg.TRUST_PROXY !== "1" && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) {
    return c.json({ error: "Unexpected Host header" }, 403);
  }
  const m = c.req.method;
  if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS") {
    const origin = c.req.header("origin");
    if (origin) {
      let ok = corsOrigins.includes(origin.replace(/\/+$/, ""));
      try {
        ok = ok || new URL(origin).host.toLowerCase() === host;
      } catch {
        /* unparsable Origin: not ok */
      }
      if (!ok) return c.json({ error: "Cross-origin request blocked" }, 403);
    } else if (c.req.header("sec-fetch-site") === "cross-site") {
      return c.json({ error: "Cross-origin request blocked" }, 403);
    }
  }
  return next();
});

// Binary uploads (PDF/XLSX arrive base64-encoded in JSON) get a larger cap on that one route only.
const tooLarge = (c: import("hono").Context) => c.json({ error: "Request too large" }, 413);
const smallBody = bodyLimit({ maxSize: 2 * 1024 * 1024, onError: tooLarge });
const uploadBody = bodyLimit({ maxSize: 14 * 1024 * 1024, onError: tooLarge });
app.use("/api/*", (c, next) => (c.req.method === "POST" && c.req.path === "/api/attachments" ? uploadBody(c, next) : smallBody(c, next)));

if (cfg.ACCESS_TOKEN?.trim()) {
  const auth = basicAuth({ username: cfg.ACCESS_USER, password: cfg.ACCESS_TOKEN.trim(), realm: "Minimi" });
  app.use("*", async (c, next) => (c.req.path === "/health" ? next() : auth(c, next)));
} else if (cfg.isProduction || !["127.0.0.1", "localhost", "::1"].includes(cfg.HOST)) {
  // Agent tools can read uploaded files, fetch URLs and write memories: an open server exposes all of that.
  console.warn(`[warn] ACCESS_TOKEN is not set and the server listens on ${cfg.HOST}: the app is accessible without a password. Set ACCESS_TOKEN before exposing this server.`);
}

// Per-IP rate limit on the expensive endpoint (in-memory; one process).
const hits = new Map<string, number[]>();
const rateLimited = async (c: Context, next: Next) => {
  const limit = cfg.RATE_LIMIT_PER_MIN;
  if (limit > 0 && c.req.method === "POST") {
    // Last hop = the one our own proxy appended; the first entries are client-controlled and spoofable.
    const fwd = cfg.TRUST_PROXY === "1" ? c.req.header("x-forwarded-for")?.split(",").pop()?.trim() : undefined;
    const ip = fwd || (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress || "local";
    const now = Date.now();
    const key = `${ip}|${c.req.path}`; // separate budget per route
    const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= limit) {
      c.header("Retry-After", "30");
      return c.json({ error: "Too many requests — please slow down and try again shortly." }, 429);
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60_000)) hits.delete(k);
  }
  return next();
};
// The chat endpoint and the other routes that cost money or CPU (LLM/search calls, file parsing).
for (const p of ["/api/chat", "/api/attachments", "/api/suggest", "/api/integrations/test"]) app.use(p, rateLimited);

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse(); // e.g. 401 from basic auth
  console.error("[error]", err);
  return c.json({ error: "Internal server error" }, 500);
});
app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "Not found" }, 404) : c.text("Not found", 404)));

app.get("/health", (c) => {
  let dbOk = true;
  try {
    db.prepare("SELECT 1").get();
  } catch {
    dbOk = false;
  }
  return c.json(
    {
      ok: dbOk,
      hasLlm: cfg.hasLlm,
      hasSearch: cfg.hasSearch,
      devRoutes: !cfg.isProduction,
      now: getClock().now().toISOString(),
    },
    dbOk ? 200 : 503,
  );
});

registerRoutes(app, db, { digest });
registerDiscoverRoutes(app, db);

app.get("/api/trace/:turnId", (c) => {
  return c.json({ traces: getTracesForTurn(db, c.req.param("turnId")) });
});

if (!cfg.isProduction) {
  app.get("/api/dev/clock", (c) =>
    c.json({ now: getClock().now().toISOString() }),
  );
  app.post("/api/dev/clock", async (c) => {
    const body = (await c.req.json()) as { iso?: string; clear?: boolean };
    if (body.clear) {
      setClock(clockFromEnv(""));
      return c.json({ now: getClock().now().toISOString(), cleared: true });
    }
    if (body.iso) {
      const d = new Date(body.iso);
      if (Number.isNaN(d.getTime())) return c.json({ error: "invalid iso" }, 400);
      setClock(new FixedClock(d));
    }
    return c.json({ now: getClock().now().toISOString() });
  });
}

app.post("/api/import", async (c) => {
  if (cfg.isProduction) return c.json({ error: "disabled in production" }, 403);
  const body = await c.req.json();
  const n = importConversations(db, getClock(), body, cfg.DEFAULT_TZ);
  return c.json({ imported: n });
});

app.post("/api/chat", async (c) => {
  const keys = requireChatKeys(cfg);
  if (!keys.ok) return c.json({ error: keys.message }, 503);

  const body = (await c.req.json()) as {
    message: string;
    conversationId?: string;
    tz?: string;
    model?: "auto" | "main" | "fast" | "smart";
    approval?: boolean;
    approvalMode?: unknown;
    attachmentIds?: string[];
    regenerateTurnId?: string;
  };
  if (!body.message?.trim()) return c.json({ error: "message required" }, 400);

  const devNow = !cfg.isProduction ? c.req.header("x-dev-now") : undefined;
  if (devNow?.trim()) {
    const d = new Date(devNow);
    if (!Number.isNaN(d.getTime())) setClock(new FixedClock(d));
  }

  const tz = body.tz ?? cfg.DEFAULT_TZ;
  const ac = new AbortController();
  c.req.raw.signal.addEventListener("abort", () => ac.abort());

  const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds.filter((x) => typeof x === "string") : [];
  const fileCtx = attachmentContext(db, body.conversationId, attachmentIds);
  const message = body.message.trim();
  const model = body.model === "fast" ? cfg.MODEL_FAST : body.model === "smart" ? cfg.MODEL_SMART : undefined;

  return streamSSE(c, async (stream) => {
    // Serialize writes and drain them before the stream closes (token replays are many tiny writes).
    let chain: Promise<unknown> = Promise.resolve();
    const emit = (event: string, payload: unknown) => {
      chain = chain.then(() => stream.writeSSE({ event, data: JSON.stringify(payload) })).catch(() => {});
    };
    try {
      const result = await runTurn(
        {
          message,
          contextMessage: fileCtx ? `${fileCtx}

${message}` : undefined,
          model,
          attachmentIds,
          // Untrusted input: validated, with a safe default. `approval: true` is the pre-modes client's "ask me".
          approvalMode: parseApprovalMode(body.approvalMode ?? (body.approval === true ? "request" : undefined)),
          tz,
          conversationId: body.conversationId,
          signal: ac.signal,
        },
        {
          onConversation: (id) => emit("conversation", { id }),
          // Always available; which calls need a prompt is decided per tool by PermissionGate (src/agent/permissions.ts).
          requestApproval: async (actions) => {
            const id = newId("apr");
            const list = actions.map((a) =>
              typeof a === "string" ? { tool: "action", label: a } : a,
            );
            const queries = list.map((a) => a.label);
            emit("approval_request", { id, queries, actions: list });
            const ok = await waitForApproval(id, ac.signal);
            emit("approval_result", { id, approved: ok });
            return ok;
          },
          onToolStart: (tools) => {
            emit("tool_start", { tools });
          },
          onToolDone: (payload) => {
            emit("tool_done", payload);
          },
          onStatus: (text) => {
            emit("status", { text });
          },
          onMemory: (payload) => {
            emit("memory", payload);
          },
          onSearchStart: (queries, ids) => {
            emit("search_start", { queries, ids });
          },
          onSearchDone: (payload) => {
            emit("search_done", payload);
          },
          onToken: (text) => {
            emit("token", { text });
          },
          onSources: (sources) => {
            emit("sources", sources);
          },
          onDone: (payload) => {
            emit("done", {
                turnId: payload.turnId,
                conversationId: payload.conversationId,
                trace: { searchCount: payload.searchCount ?? 0 },
              });
          },
          onError: (message) => {
            emit("error", { message });
          },
        },
      );
      if (attachmentIds.length) bindAttachments(db, result.conversationId, attachmentIds);
      if (body.regenerateTurnId) {
        if (ac.signal.aborted) discardFailedRegeneration(db, result.conversationId, body.regenerateTurnId);
        else foldRegeneratedTurn(db, body.regenerateTurnId, result.conversationId, result.turnId);
      }
    } catch (err) {
      if (body.regenerateTurnId && body.conversationId) {
        try {
          discardFailedRegeneration(db, body.conversationId, body.regenerateTurnId);
        } catch {
          /* best effort */
        }
      }
      const msg = err instanceof Error ? err.message : "error";
      if (!ac.signal.aborted) {
        emit("error", { message: msg });
      }
    }
    await chain;
  });
});

const landingDir = join(root, "landing");
const webDir = join(root, "web");

function serveLandingFile(relPath: string) {
  const file = join(landingDir, relPath);
  if (existsSync(file) && statSync(file).isFile()) {
    const ext = file.split(".").pop()?.toLowerCase();
    const ct =
      ext === "html" ? "text/html; charset=utf-8" :
      ext === "css" ? "text/css; charset=utf-8" :
      ext === "js" ? "application/javascript; charset=utf-8" :
      ext === "woff2" ? "font/woff2" :
      ext === "svg" ? "image/svg+xml" :
      ext === "json" ? "application/json" :
      ext === "txt" ? "text/plain; charset=utf-8" :
      "application/octet-stream";
    return { found: true, body: readFileSync(file), ct };
  }
  return { found: false, body: null, ct: null };
}

// ── 1. Landing page at root "/" and alias "/landing" ──
app.get("/", (c) => c.html(readFileSync(join(landingDir, "index.html"), "utf8")));
app.get("/landing", (c) => c.redirect("/"));
app.get("/landing/", (c) => c.redirect("/"));
app.get("/landing/*", (c) => {
  const rel = c.req.path.replace(/^\/landing\//, "");
  if (!rel || rel === "index.html") {
    return c.html(readFileSync(join(landingDir, "index.html"), "utf8"));
  }
  const res = serveLandingFile(rel);
  if (res.found && res.body && res.ct) {
    return c.body(res.body, 200, { "Content-Type": res.ct });
  }
  return c.text("Not found", 404);
});

// ── 2. Web Application at "/app" (and alias "/chat") ──
app.get("/app", (c) => c.html(readFileSync(join(webDir, "index.html"), "utf8")));
app.get("/app/*", (c) => c.html(readFileSync(join(webDir, "index.html"), "utf8")));
app.get("/chat", (c) => c.redirect("/app"));
app.get("/chat/*", (c) => c.redirect("/app"));

// ── 3. Assets for landing page (css, js, fonts) ──
app.get("/css/*", (c) => {
  const res = serveLandingFile(c.req.path.replace(/^\//, ""));
  if (res.found && res.body && res.ct) return c.body(res.body, 200, { "Content-Type": res.ct });
  return c.text("Not found", 404);
});
app.get("/js/*", (c) => {
  const res = serveLandingFile(c.req.path.replace(/^\//, ""));
  if (res.found && res.body && res.ct) return c.body(res.body, 200, { "Content-Type": res.ct });
  return c.text("Not found", 404);
});
app.get("/assets/*", (c) => {
  const res = serveLandingFile(c.req.path.replace(/^\//, ""));
  if (res.found && res.body && res.ct) return c.body(res.body, 200, { "Content-Type": res.ct });
  return c.text("Not found", 404);
});

// ── 4. App bundles ──
app.get("/bundle.js", (c) => {
  const p = join(webDir, "bundle.js");
  if (!existsSync(p)) return c.text("bundle missing — restart server", 503);
  return c.body(readFileSync(p), 200, {
    "Content-Type": "application/javascript",
  });
});
app.get("/bundle.css", (c) => {
  const p = join(webDir, "bundle.css");
  if (!existsSync(p)) return c.text("", 200, { "Content-Type": "text/css" });
  return c.body(readFileSync(p), 200, { "Content-Type": "text/css" });
});
app.get("/app/bundle.js", (c) => c.redirect("/bundle.js"));
app.get("/app/bundle.css", (c) => c.redirect("/bundle.css"));

const stopDiscover = startDiscoverScheduler(db); // news + startup-funding refresh in the background
const server = serve({ fetch: app.fetch, port: cfg.PORT, hostname: cfg.HOST }, (info) => {
  console.log(`Minimi listening on http://${cfg.HOST === "0.0.0.0" ? "localhost" : cfg.HOST}:${info.port} (${cfg.isProduction ? "production" : "development"})`);
  if (!cfg.hasLlm) console.warn("[warn] No LLM key set (ANTHROPIC_API_KEY or NVIDIA_API_KEY): chat will return an error until one is added to .env");
});

// Graceful shutdown: stop accepting requests, let in-flight ones finish, close the database.
let closing = false;
function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`${signal} received, shutting down…`);
  server.close(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("exit", () => stopDiscover());
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));


