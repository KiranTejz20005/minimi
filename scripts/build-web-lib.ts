import * as esbuild from "esbuild";
import { join } from "node:path";

/**
 * Bundles the React client.
 *  - Default (server-rendered): writes web/bundle.js + web/bundle.css; API calls are same-origin.
 *  - Split deploy: pass `apiUrl` (the backend origin) and an `outdir`; the URL is baked into the bundle.
 */
export function buildWeb(root: string, opts: { apiUrl?: string; outdir?: string } = {}): void {
  esbuild.buildSync({
    entryPoints: [join(root, "web", "main.tsx")],
    bundle: true,
    // CSS imported from TS lands next to the JS as bundle.css
    outfile: join(opts.outdir ?? join(root, "web"), "bundle.js"),
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    define: {
      "process.env.NODE_ENV": '"production"',
      __API_URL__: JSON.stringify((opts.apiUrl ?? "").replace(/\/+$/, "")),
    },
    loader: { ".css": "css" },
  });
}
