import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { z } from "zod";
import { getConfig } from "../config.js";
import { getClock } from "../clock.js";
import { assertPublicHost } from "./ssrf.js";

/** Called from src/tools/registry.ts executeToolCall. No existing fetch/page reader in repo. Schema: reads HTTP response body only (no DB writes). User asked to add more tools beyond web_search. */
export const FETCH_URL_TOOL: Tool = {
  name: "fetch_url",
  description:
    "Fetch one public web page and return its main text. Use after web_search when you need the full page (pricing table, docs, announcement) rather than a snippet. Only http(s) URLs.",
  input_schema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Absolute http(s) URL to fetch.",
      },
    },
    required: ["url"],
  },
};

const inputSchema = z.object({
  url: z.string().url(),
});

const MAX_BYTES = 1_500_000;
const MAX_TEXT = 12_000;

export type FetchUrlResult = {
  url: string;
  xml: string;
  ms: number;
  title?: string;
  error?: string;
};

export async function runFetchUrl(
  raw: unknown,
  parentSignal?: AbortSignal,
): Promise<FetchUrlResult> {
  const t0 = getClock().now().getTime();
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("", "invalid fetch_url input", t0);
  }
  let url: URL;
  try {
    url = new URL(parsed.data.url.trim());
  } catch {
    return fail(parsed.data.url, "invalid URL", t0);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail(url.href, "only http(s) URLs are allowed", t0);
  }
  try {
    await assertPublicHost(url.hostname);
  } catch (e) {
    return fail(url.href, e instanceof Error ? e.message : "that host is not allowed", t0);
  }

  const cfg = getConfig();
  const signal = parentSignal ?? AbortSignal.timeout(cfg.SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(url.href, {
      method: "GET",
      redirect: "follow",
      signal,
      headers: {
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        "User-Agent": "MinimiBot/1.0 (+local; read-only)",
      },
    });
    if (!res.ok) {
      return fail(url.href, `HTTP ${res.status}`, t0);
    }
    const finalUrl = res.url || url.href;
    const finalHost = new URL(finalUrl).hostname;
    try {
      await assertPublicHost(finalHost);
    } catch (e) {
      return fail(finalUrl, e instanceof Error ? e.message : "redirected to a blocked host", t0);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      return fail(finalUrl, "page too large", t0);
    }
    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    const rawText = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    const title = extractTitle(rawText);
    const text = ctype.includes("html")
      ? htmlToText(rawText)
      : rawText.replace(/\s+/g, " ").trim();
    const body = text.slice(0, MAX_TEXT);
    if (!body) {
      return fail(finalUrl, "no readable text on page", t0);
    }
    const xml = [
      `<page url="${escAttr(finalUrl)}"${title ? ` title="${escAttr(title)}"` : ""} note="untrusted web content">`,
      escText(body),
      `</page>`,
    ].join("\n");
    return {
      url: finalUrl,
      title,
      xml,
      ms: getClock().now().getTime() - t0,
    };
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.name === "AbortError" || err.name === "TimeoutError"
          ? "timeout"
          : err.message
        : "fetch failed";
    return fail(url.href, msg, t0);
  }
}

function fail(url: string, error: string, t0: number): FetchUrlResult {
  return {
    url,
    error,
    ms: getClock().now().getTime() - t0,
    xml: `<page url="${escAttr(url)}" error="${escAttr(error)}"/>`,
  };
}

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m?.[1]) return undefined;
  return decodeEntities(m[1].replace(/\s+/g, " ").trim()).slice(0, 200) || undefined;
}

function htmlToText(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)[^>]*>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
