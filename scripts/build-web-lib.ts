import * as esbuild from "esbuild";
import { join } from "node:path";

export function buildWeb(root: string): void {
  esbuild.buildSync({
    entryPoints: [join(root, "web", "main.tsx")],
    bundle: true,
    outfile: join(root, "web", "bundle.js"), // CSS imported from TS lands in web/bundle.css
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".css": "css" },
  });
}
