import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { basicAuth } from "hono/basic-auth";
import { logger } from "hono/logger";
import { HTTPException } from "hono/http-exception";
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
import { DigestQueue } from "./memory/digest.js";
import { runTurn, importConversations } from "./agent/run-turn.js";
import { buildWeb } from "../scripts/build-web-lib.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = getConfig();
setClock(clockFromEnv());
const db = getDb();
const store = new MemoryStore(db);
const digest = new DigestQueue(store);
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
app.use("/api/*", bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json({ error: "Request too large" }, 413) }));

if (cfg.ACCESS_TOKEN?.trim()) {
  const auth = basicAuth({ username: cfg.ACCESS_USER, password: cfg.ACCESS_TOKEN.trim(), realm: "Minimi" });
  app.use("*", async (c, next) => (c.req.path === "/health" ? next() : auth(c, next)));
} else if (cfg.isProduction) {
  console.warn("[warn] ACCESS_TOKEN is not set: the app is publicly accessible. Set it before exposing this server.");
}

// Per-IP rate limit on the expensive endpoint (in-memory; one process).
const hits = new Map<string, number[]>();
app.use("/api/chat", async (c, next) => {
  const limit = cfg.RATE_LIMIT_PER_MIN;
  if (limit > 0 && c.req.method === "POST") {
    const fwd = cfg.TRUST_PROXY === "1" ? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() : undefined;
    const ip = fwd || (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress || "local";
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= limit) {
      c.header("Retry-After", "30");
      return c.json({ error: "Too many requests — please slow down and try again shortly." }, 429);
    }
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60_000)) hits.delete(k);
  }
  return next();
});

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

registerRoutes(app, db);

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
          tz,
          conversationId: body.conversationId,
          signal: ac.signal,
        },
        {
          onConversation: (id) => emit("conversation", { id }),
          requestApproval: body.approval
            ? async (queries) => {
                const id = newId("apr");
                emit("approval_request", { id, queries });
                const ok = await waitForApproval(id, ac.signal);
                emit("approval_result", { id, approved: ok });
                return ok;
              }
            : undefined,
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
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));


