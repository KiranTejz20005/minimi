import { marked } from "marked";
import DOMPurify from "dompurify";
import type { SourceRef } from "../api";

marked.setOptions({ breaks: true, gfm: true });

let hooked = false;
function ensureHook() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Markdown → sanitized HTML. `[n]` becomes a superscript link when source n is known. */
export function renderMarkdown(src: string, sources: SourceRef[] = []): string {
  ensureHook();
  const byN = new Map(sources.map((s) => [s.n, s]));
  const text = byN.size
    ? src.replace(/\[(\d{1,3})\](?!\()/g, (m, n: string) => {
        const s = byN.get(Number(n));
        return s ? `<sup class="cite"><a href="${esc(s.url)}" title="${esc(s.title)}">${n}</a></sup>` : m;
      })
    : src;
  const raw = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(raw, { ADD_ATTR: ["target", "rel"] });
}

/** Markdown → plain text (for read-aloud and previews). */
export function plainText(src: string): string {
  ensureHook();
  const html = DOMPurify.sanitize(marked.parse(src, { async: false }) as string);
  const el = document.createElement("div");
  el.innerHTML = html;
  return (el.textContent ?? "").replace(/\[\d{1,3}\]/g, "").replace(/\s+/g, " ").trim();
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function fmtMs(ms?: number): string {
  if (ms === undefined || ms === null) return "";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function slug(s: string): string {
  return (s || "answer").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "answer";
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
