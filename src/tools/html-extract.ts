import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

/** Pure HTML/text extraction for fetch_url (src/tools/fetch-url.ts). No I/O. */

export type Extracted = { title?: string; text: string; method: "readability" | "fallback" };

// C0/C1 controls (except \t \n), zero-width + bidi overrides/isolates, BOM, and Unicode "tag" characters
// (used for invisible-text prompt smuggling).
const INVISIBLE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁯﻿]|\uDB40[\uDC00-\uDC7F]/g;

/** Remove invisible/control characters and normalise whitespace. */
export function cleanText(s: string): string {
  return s
    .replace(INVISIBLE, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function decodeEntities(s: string): string {
  const cp = (n: number): string => {
    if (!Number.isFinite(n) || n < 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return " ";
    return String.fromCodePoint(n);
  };
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d{1,7});/g, (_, n) => cp(Number(n)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/&amp;/gi, "&");
}

export function extractTitle(html: string): string | undefined {
  // No backtracking-prone pattern: find the opening tag, then look for the close only in a bounded window.
  const open = /<title[\s>]/i.exec(html);
  if (!open) return undefined;
  const gt = html.indexOf(">", open.index);
  if (gt < 0) return undefined;
  const region = html.slice(gt + 1, gt + 20_001);
  const close = /<\/title/i.exec(region);
  const raw = close ? region.slice(0, close.index) : region.slice(0, 300);
  return cleanText(decodeEntities(raw)).replace(/\s+/g, " ").slice(0, 200) || undefined;
}

const SKIP_ELEMENTS = new Set(["script", "style", "noscript", "template", "svg", "iframe", "object", "embed", "head"]);
const BLOCK_ELEMENTS = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "br", "section", "article", "blockquote", "pre", "table", "ul", "ol"]);
const TAG_NAME = /^\/?([A-Za-z][A-Za-z0-9-]*)/;

/** Index of the end ('>') of the closing tag </name ...> at or after `from`, or -1. Linear (indexOf only). */
function findClosingTagEnd(html: string, from: number, name: string): number {
  for (let i = html.indexOf("</", from); i >= 0; i = html.indexOf("</", i + 2)) {
    if (html.slice(i + 2, i + 2 + name.length).toLowerCase() !== name) continue;
    const after = html.charCodeAt(i + 2 + name.length);
    const nameChar = (after >= 48 && after <= 57) || (after >= 65 && after <= 90) || (after >= 97 && after <= 122) || after === 45;
    if (nameChar) continue; // a longer tag name (e.g. </headx>), not this one
    const gt = html.indexOf(">", i);
    return gt < 0 ? html.length - 1 : gt;
  }
  return -1;
}

/**
 * Safe tag-stripper: drops script/style/template/etc. wholesale, then every remaining tag.
 * Single forward pass built on indexOf, so hostile input ("<a<a<a…", "<!--<!--…", unterminated scripts) stays
 * linear: a regex like /<[^>]*>/ rescans to the end of the input from every '<' (quadratic, seconds at 80 KB).
 */
export function htmlToText(html: string): string {
  const out: string[] = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out.push(html.slice(i));
      break;
    }
    if (lt > i) out.push(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end < 0) break; // unterminated comment: nothing after it is trustworthy text
      out.push(" ");
      i = end + 3;
      continue;
    }
    const c = html.charCodeAt(lt + 1);
    const tagLike = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 47 || c === 33 || c === 63;
    if (!tagLike) {
      out.push("<");
      i = lt + 1;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) {
      out.push(" "); // no '>' left anywhere: the remainder is a broken tag, not text
      break;
    }
    const m = TAG_NAME.exec(html.slice(lt + 1, lt + 41));
    const name = m ? m[1]!.toLowerCase() : "";
    const closing = html.charCodeAt(lt + 1) === 47;
    if (name && !closing && SKIP_ELEMENTS.has(name)) {
      const end = findClosingTagEnd(html, gt + 1, name);
      out.push(" ");
      if (end < 0) break; // unterminated script/style: drop the rest
      i = end + 1;
      continue;
    }
    out.push(name && BLOCK_ELEMENTS.has(name) && (closing || name === "br") ? "\n" : " ");
    i = gt + 1;
  }
  return cleanText(decodeEntities(out.join("")));
}

const MAX_ELEMS = 20_000;
const MAX_DEPTH = 120;
const MAX_DOM_CHARS = 600_000; // above this, skip the (super-linear) DOM path
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "p", "li"]);

/**
 * Linear pre-scan. linkedom+Readability are roughly quadratic in nesting depth (4000 nested divs ~3s of blocked
 * event loop), so hostile deep/huge DOMs skip Readability and use the linear tag-stripper instead.
 */
export function isSafeForDom(html: string): boolean {
  if (html.length > MAX_DOM_CHARS) return false;
  let depth = 0;
  let count = 0;
  for (let lt = html.indexOf("<"); lt >= 0; lt = html.indexOf("<", lt + 1)) {
    const c = html.charCodeAt(lt + 1);
    const closing = c === 47;
    const nc = closing ? html.charCodeAt(lt + 2) : c;
    if (!((nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122))) continue;
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) break; // no more tags
    if (++count > MAX_ELEMS) return false;
    const m = TAG_NAME.exec(html.slice(lt + 1, lt + 41));
    const name = m ? m[1]!.toLowerCase() : "";
    lt = gt; // resume after this tag: never rescan to the same '>' from every '<' inside it (quadratic)
    if (VOID.has(name) || html.charCodeAt(gt - 1) === 47) continue; // void/self-closing: depth unchanged
    if (closing) depth = Math.max(0, depth - 1);
    else if (++depth > MAX_DEPTH) return false;
  }
  return true;
}

function readabilityText(html: string): { title?: string; text: string } | null {
  if (!isSafeForDom(html)) return null;
  try {
    const { document } = parseHTML(html);
    const reader = new Readability(document as unknown as Document, { maxElemsToParse: MAX_ELEMS, charThreshold: 200 });
    const article = reader.parse();
    if (!article) return null;
    const text = cleanText(article.textContent ?? "");
    const title = article.title ? cleanText(article.title).replace(/\s+/g, " ").slice(0, 200) : undefined;
    return { title: title || undefined, text };
  } catch {
    return null; // hostile / oversized DOM: fall back
  }
}

/** Main-article extraction via Readability; safe tag-stripper when it yields nothing useful. */
export function extractHtml(html: string): Extracted {
  const title = extractTitle(html);
  const r = readabilityText(html);
  if (r && r.text.length >= 40) {
    return { title: r.title || title, text: r.text, method: "readability" };
  }
  return { title: r?.title || title, text: htmlToText(html), method: "fallback" };
}

/** Plain-text bodies (text/plain, json, xml...). */
export function extractPlain(text: string): string {
  return cleanText(text);
}

export function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\r\n]+/g, " ");
}

export function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
