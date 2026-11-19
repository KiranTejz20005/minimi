/**
 * Builds the static frontend for Vercel into dist-web/:
 *   /            landing page      (from landing/)
 *   /app         the chat UI       (web/index.html + bundle.js/css)
 * The backend origin is baked into the bundle from the API_URL environment variable, so it must be set
 * at BUILD time (Vercel → Project Settings → Environment Variables) and the project redeployed if it changes.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWeb } from "./build-web-lib.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-web");

const apiUrl = (process.env.API_URL ?? "").trim().replace(/\/+$/, "");
if (!/^https?:\/\/[^/\s]+$/.test(apiUrl)) {
  console.error(
    "API_URL must be set to the backend origin, e.g. API_URL=https://minimi-api.onrender.com (no path, no trailing slash).",
  );
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "app"), { recursive: true });

if (existsSync(join(root, "landing"))) cpSync(join(root, "landing"), out, { recursive: true });
buildWeb(root, { apiUrl, outdir: out });
cpSync(join(root, "web", "index.html"), join(out, "app", "index.html"));

console.log(`frontend written to dist-web/ (API -> ${apiUrl})`);
