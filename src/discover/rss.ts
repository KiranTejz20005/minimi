import type { ParsedItem } from "./types.js";

/**
 * Linear-time RSS 2.0 / RSS 1.0 (RDF) / Atom parser for UNTRUSTED feed text.
 *
 * No regular expression ever runs over unbounded input. A hand-written scanner walks the document once: every
 * lookahead (indexOf / bounded scan) either succeeds and the cursor jumps past what it scanned, or fails and parsing
 * stops (the remainder becomes text). Nesting depth, node count and input size are capped, end-tag matching is
 * bounded by the depth cap, and DTD / internal entities are never expanded (no "billion laughs").
 * Output text is plain (HTML stripped, entities decoded, invisible characters removed) and length-capped.
 */

export type XmlNode = { name: string; attrs: Record<string, string>; children: (XmlNode | string)[] };

const MAX_DEPTH = 64;
const MAX_NODES = 60_000;
const MAX_INPUT_CHARS = 4_000_000;
const MAX_ATTRS = 32;
export const TITLE_MAX = 200;
export const SUMMARY_MAX = 500;

// ── Entities ────────────────────────────────────────────────────────────────
const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", shy: "",
  zwj: "", zwnj: "", lrm: "", rlm: "", hellip: "…", mdash: "—", ndash: "–", minus: "−", lsquo: "‘", rsquo: "’",
  sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„", laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›", bull: "•",
  middot: "·", prime: "′", copy: "©", reg: "®", trade: "™", euro: "€", pound: "£", yen: "¥", cent: "¢", deg: "°",
  times: "×", divide: "÷", plusmn: "±", frac12: "½", frac14: "¼", frac34: "¾", sect: "§", para: "¶", dagger: "†",
  eacute: "é", egrave: "è", ecirc: "ê", euml: "ë", aacute: "á", agrave: "à", acirc: "â", auml: "ä", atilde: "ã",
  aring: "å", iacute: "í", igrave: "ì", icirc: "î", iuml: "ï", oacute: "ó", ograve: "ò", ocirc: "ô", ouml: "ö",
  otilde: "õ", oslash: "ø", uacute: "ú", ugrave: "ù", ucirc: "û", uuml: "ü", ntilde: "ñ", ccedil: "ç", szlig: "ß",
  Eacute: "É", Aacute: "Á", Ouml: "Ö", Uuml: "Ü", Auml: "Ä", Ntilde: "Ñ", Ccedil: "Ç", Oslash: "Ø", Aring: "Å",
  aelig: "æ", AElig: "Æ", iexcl: "¡", iquest: "¿",
};

function codePoint(n: number): string {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return " ";
  if (n < 32 && n !== 9 && n !== 10 && n !== 13) return " ";
  return String.fromCodePoint(n);
}

function entityValue(ent: string): string | null {
  if (ent.charCodeAt(0) === 35 /* # */) {
    const hex = ent.charCodeAt(1) === 120 || ent.charCodeAt(1) === 88;
    const digits = ent.slice(hex ? 2 : 1);
    if (!digits || digits.length > 7) return null;
    for (let k = 0; k < digits.length; k++) {
      const c = digits.charCodeAt(k);
      const isDec = c >= 48 && c <= 57;
      const isHex = isDec || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
      if (hex ? !isHex : !isDec) return null;
    }
    return codePoint(Number.parseInt(digits, hex ? 16 : 10));
  }
  return NAMED[ent] ?? NAMED[ent.toLowerCase()] ?? null;
}

/** Decode XML/HTML character references. Linear: each '&' looks at most 12 characters ahead for ';'. */
export function decodeEntities(s: string): string {
  let amp = s.indexOf("&");
  if (amp === -1) return s;
  let out = "";
  let last = 0;
  const n = s.length;
  while (amp !== -1) {
    let semi = -1;
    const limit = Math.min(n, amp + 12);
    for (let k = amp + 1; k < limit; k++) {
      const c = s.charCodeAt(k);
      if (c === 59 /* ; */) {
        semi = k;
        break;
      }
      if (c === 38 /* & */ || c === 32 || c === 60) break;
    }
    if (semi > amp + 1) {
      const rep = entityValue(s.slice(amp + 1, semi));
      if (rep !== null) {
        out += s.slice(last, amp) + rep;
        last = semi + 1;
        amp = s.indexOf("&", last);
        continue;
      }
    }
    amp = s.indexOf("&", amp + 1);
  }
  return out + s.slice(last);
}

// ── Scanner helpers ─────────────────────────────────────────────────────────
function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
}
function isNameStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58 || c > 127;
}
function isNameChar(c: number): boolean {
  return isNameStart(c) || (c >= 48 && c <= 57) || c === 45 || c === 46;
}

type Tag = { name: string; attrs: Record<string, string>; selfClosing: boolean; end: number };

/**
 * Scan a start (or end) tag whose name starts at `start` (just after '<' or '</'). Returns null when the tag never
 * closes: callers then stop, so no character is scanned twice.
 */
function scanTag(src: string, start: number): Tag | null {
  const n = src.length;
  let i = start;
  while (i < n && isNameChar(src.charCodeAt(i))) i++;
  const name = src.slice(start, i).toLowerCase();
  const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
  let count = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 62 /* > */) return { name, attrs, selfClosing: src.charCodeAt(i - 1) === 47, end: i + 1 };
    if (isSpace(c) || c === 47 /* / */) {
      i++;
      continue;
    }
    const ns = i;
    while (i < n) {
      const d = src.charCodeAt(i);
      if (isSpace(d) || d === 61 || d === 62 || d === 47) break;
      i++;
    }
    if (i === ns) {
      i++; // stray '='
      continue;
    }
    const attrName = src.slice(ns, i).toLowerCase();
    while (i < n && isSpace(src.charCodeAt(i))) i++;
    if (src.charCodeAt(i) !== 61 /* = */) {
      if (count++ < MAX_ATTRS) attrs[attrName] = "";
      continue;
    }
    i++;
    while (i < n && isSpace(src.charCodeAt(i))) i++;
    const q = src.charCodeAt(i);
    let value: string;
    if (q === 34 || q === 39) {
      const close = src.indexOf(q === 34 ? '"' : "'", i + 1);
      if (close === -1) return null;
      value = src.slice(i + 1, close);
      i = close + 1;
    } else {
      const vs = i;
      while (i < n) {
        const d = src.charCodeAt(i);
        if (isSpace(d) || d === 62) break;
        i++;
      }
      value = src.slice(vs, i);
    }
    if (count++ < MAX_ATTRS) attrs[attrName] = decodeEntities(value);
  }
  return null;
}

/** Skip `<!DOCTYPE ...>` (with an optional internal subset `[...]`). Returns the index after '>' or -1. */
function skipDeclaration(src: string, start: number): number {
  const n = src.length;
  for (let i = start; i < n; i++) {
    const c = src.charCodeAt(i);
    if (c === 62) return i + 1;
    if (c === 91 /* [ */) {
      const close = src.indexOf("]", i + 1);
      if (close === -1) return -1;
      i = close;
    }
  }
  return -1;
}

function appendText(node: XmlNode, text: string): void {
  if (!text) return;
  const last = node.children.length - 1;
  if (last >= 0 && typeof node.children[last] === "string") node.children[last] = (node.children[last] as string) + text;
  else node.children.push(text);
}

/** Parse XML into a small tree. Never throws; malformed input yields whatever was well-formed before the damage. */
export function parseXml(input: string): XmlNode {
  const src = input.length > MAX_INPUT_CHARS ? input.slice(0, MAX_INPUT_CHARS) : input;
  const root: XmlNode = { name: "#document", attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  const n = src.length;
  let nodes = 0;
  let i = 0;
  let textStart = 0;
  const top = () => stack[stack.length - 1]!;
  const flush = (end: number) => {
    if (end > textStart) appendText(top(), decodeEntities(src.slice(textStart, end)));
    textStart = end;
  };

  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt === -1) break;
    const next = src.charCodeAt(lt + 1);
    if (next === 33 /* ! */) {
      if (src.startsWith("<![CDATA[", lt)) {
        flush(lt);
        const end = src.indexOf("]]>", lt + 9);
        appendText(top(), src.slice(lt + 9, end === -1 ? n : end)); // CDATA is raw: no entity decoding
        i = textStart = end === -1 ? n : end + 3;
        continue;
      }
      flush(lt);
      const end = src.startsWith("<!--", lt)
        ? (() => {
            const e = src.indexOf("-->", lt + 4);
            return e === -1 ? -1 : e + 3;
          })()
        : skipDeclaration(src, lt + 2);
      if (end === -1) {
        i = textStart = n;
        break;
      }
      i = textStart = end;
      continue;
    }
    if (next === 63 /* ? */) {
      flush(lt);
      const end = src.indexOf("?>", lt + 2);
      if (end === -1) {
        i = textStart = n;
        break;
      }
      i = textStart = end + 2;
      continue;
    }
    if (next === 47 /* / */) {
      const gt = src.indexOf(">", lt + 2);
      if (gt === -1) break;
      flush(lt);
      const name = src.slice(lt + 2, Math.min(gt, lt + 2 + 128)).trim().toLowerCase();
      for (let k = stack.length - 1; k >= 1; k--) {
        if (stack[k]!.name === name) {
          stack.length = k;
          break;
        }
      }
      i = textStart = gt + 1;
      continue;
    }
    if (!isNameStart(next)) {
      i = lt + 1; // a literal '<' inside text: keep scanning, it stays part of the text run
      continue;
    }
    const tag = scanTag(src, lt + 1);
    if (!tag) break;
    flush(lt);
    i = textStart = tag.end;
    if (++nodes > MAX_NODES) {
      textStart = n;
      break;
    }
    if (stack.length <= MAX_DEPTH) {
      const el: XmlNode = { name: tag.name, attrs: tag.attrs, children: [] };
      top().children.push(el);
      if (!tag.selfClosing) stack.push(el);
    }
  }
  flush(n);
  return root;
}

// ── Tree helpers ────────────────────────────────────────────────────────────
function elements(node: XmlNode): XmlNode[] {
  const out: XmlNode[] = [];
  for (const c of node.children) if (typeof c !== "string") out.push(c);
  return out;
}

function child(node: XmlNode, ...names: string[]): XmlNode | undefined {
  for (const name of names) {
    for (const c of node.children) if (typeof c !== "string" && c.name === name) return c;
  }
  return undefined;
}

function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  for (const c of node.children) if (typeof c !== "string" && c.name === name) out.push(c);
  return out;
}

/** Concatenated text of a node and its descendants (iterative; bounded by the parser's node cap). */
export function textOf(node: XmlNode, maxChars = 200_000): string {
  let out = "";
  const stack: (XmlNode | string)[] = [node];
  while (stack.length && out.length < maxChars) {
    const cur = stack.pop()!;
    if (typeof cur === "string") {
      out += cur;
      continue;
    }
    for (let k = cur.children.length - 1; k >= 0; k--) stack.push(cur.children[k]!);
  }
  return out;
}

function localName(name: string): string {
  const k = name.indexOf(":");
  return k === -1 ? name : name.slice(k + 1);
}

// ── Text cleaning ───────────────────────────────────────────────────────────
// C0/C1 controls (except tab/newline), soft hyphen, zero-width + bidi overrides/isolates, BOM. Single char class: linear.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁯﻿]/g;
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu;
const WS = /\s+/g;

export function squash(s: string): string {
  return s.replace(INVISIBLE, "").replace(TAG_CHARS, "").replace(WS, " ").trim();
}

/** Cut to `max` characters at a word boundary, adding an ellipsis. Never leaves half a surrogate pair. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  if (sp > max * 0.6) cut = cut.slice(0, sp);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  let end = cut.length;
  while (end > 0 && " ,;:.-–—\t\n".includes(cut[end - 1]!)) end--;
  return `${cut.slice(0, end)}…`;
}

/** Absolute http(s) URL or null (drops javascript:, data:, credentials, garbage). */
export function safeHttpUrl(raw: string | undefined | null, base?: string): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t || t.length > 2048) return null;
  try {
    const u = base ? new URL(t, base) : new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

const BLOCK_TAGS = new Set([
  "p", "br", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "td", "th", "table", "blockquote",
  "section", "article", "header", "footer", "figure", "figcaption", "hr", "pre", "dd", "dt", "dl", "aside", "nav",
]);
const SKIP_CONTENT_TAGS = new Set(["script", "style", "noscript", "iframe", "svg", "object", "template", "math", "select"]);
/** Inline tags that may appear (double-escaped) inside RSS titles; any other tag-like text in a title is kept literally. */
export const INLINE_TAGS: ReadonlySet<string> = new Set(["b", "i", "em", "strong", "span", "a", "br", "sup", "sub", "code", "mark", "small", "u", "s", "font", "abbr", "cite", "q", "time"]);

function isAsciiLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function pickImgSrc(attrs: Record<string, string>, base?: string): string | null {
  if (attrs.width === "1" || attrs.height === "1") return null;
  const src = safeHttpUrl(attrs.src || attrs["data-src"] || attrs["data-lazy-src"], base);
  if (!src) return null;
  if (/gravatar\.com|feedburner\.com|\/pixel|doubleclick\.net|stats\.wp\.com/i.test(src.slice(0, 300))) return null;
  return src;
}

/**
 * Strip HTML to plain text (linear scan, shares scanTag with the XML parser). Optionally returns the first usable <img>.
 * With `onlyTags`, only those tags are removed and anything else that looks like a tag stays as literal text.
 */
export function htmlToText(
  html: string,
  opts: { maxChars?: number; onlyTags?: ReadonlySet<string>; base?: string } = {},
): { text: string; image: string | null } {
  const max = opts.maxChars ?? 4_000;
  const budget = max * 3;
  const n = html.length;
  let out = "";
  let image: string | null = null;
  let i = 0;
  let textStart = 0;
  let lower: string | null = null;
  const flush = (end: number) => {
    if (end > textStart) out += html.slice(textStart, Math.min(end, textStart + budget));
    textStart = end;
  };

  while (i < n && out.length < budget) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    const c = html.charCodeAt(lt + 1);
    if (c === 33 /* ! */ && !opts.onlyTags) {
      flush(lt);
      let end: number;
      if (html.startsWith("<!--", lt)) {
        const e = html.indexOf("-->", lt + 4);
        end = e === -1 ? -1 : e + 3;
      } else if (html.startsWith("<![CDATA[", lt)) {
        const e = html.indexOf("]]>", lt + 9);
        out += html.slice(lt + 9, e === -1 ? Math.min(n, lt + 9 + budget) : e);
        end = e === -1 ? -1 : e + 3;
      } else {
        const e = html.indexOf(">", lt + 2);
        end = e === -1 ? -1 : e + 1;
      }
      if (end === -1) {
        i = textStart = n;
        break;
      }
      i = textStart = end;
      continue;
    }
    const closing = c === 47;
    const nameStart = closing ? lt + 2 : lt + 1;
    if (!isAsciiLetter(html.charCodeAt(nameStart))) {
      i = lt + 1;
      continue;
    }
    const tag = scanTag(html, nameStart);
    if (!tag) break;
    if (opts.onlyTags && !opts.onlyTags.has(tag.name)) {
      i = tag.end; // not a tag we strip: it stays in the text run
      continue;
    }
    flush(lt);
    i = textStart = tag.end;
    if (BLOCK_TAGS.has(tag.name)) out += " ";
    if (closing) continue;
    if (tag.name === "img" && !image) image = pickImgSrc(tag.attrs, opts.base);
    if (SKIP_CONTENT_TAGS.has(tag.name) && !tag.selfClosing) {
      lower ??= html.toLowerCase();
      const e = lower.indexOf(`</${tag.name}`, i);
      const gt = e === -1 ? -1 : html.indexOf(">", e);
      if (gt === -1) {
        i = textStart = n;
        break;
      }
      i = textStart = gt + 1;
    }
  }
  flush(n);
  return { text: squash(decodeEntities(out)).slice(0, max), image };
}

/** Feed titles: decode a second time (many feeds double-escape) and strip only inline formatting tags. */
export function cleanTitle(raw: string): string {
  const once = squash(raw);
  if (!once.includes("<") && !once.includes("&")) return truncate(once, TITLE_MAX);
  return truncate(htmlToText(once, { onlyTags: INLINE_TAGS, maxChars: TITLE_MAX * 2 }).text, TITLE_MAX);
}

/** Remove boilerplate feeds append to descriptions (WordPress "The post … appeared first on …", "Continue reading"). */
function stripBoilerplate(s: string): string {
  let t = s;
  const post = t.lastIndexOf("The post ");
  if (post !== -1 && t.indexOf(" appeared first on ", post) !== -1) t = t.slice(0, post);
  for (const tail of ["Continue reading…", "Continue reading...", "Continue reading", "Read more…", "Read More", "Read more", "[…]", "[...]", "[&hellip;]"]) {
    const tt = t.trimEnd();
    if (tt.endsWith(tail)) t = tt.slice(0, tt.length - tail.length);
  }
  // Hacker News items carry only links + counters: keep the counters.
  if (t.includes("Article URL:") && t.includes("Comments URL:")) {
    const points = /Points:\s*(\d{1,7})/.exec(t.slice(0, 2_000))?.[1];
    const comments = /# Comments:\s*(\d{1,7})/.exec(t.slice(0, 2_000))?.[1];
    t = points ? `${points} points${comments ? ` · ${comments} comments` : ""} on Hacker News` : "";
  }
  return t.trim();
}

// ── Dates ───────────────────────────────────────────────────────────────────
const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const TZ_MIN: Record<string, number> = {
  GMT: 0, UT: 0, UTC: 0, Z: 0, WET: 0, EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480,
  PDT: -420, IST: 330, CET: 60, CEST: 120, BST: 60, WEST: 60, EET: 120, EEST: 180, MSK: 180, JST: 540, KST: 540,
  SGT: 480, HKT: 480, AEST: 600, AEDT: 660, NZST: 720, NZDT: 780,
};
const RFC822 = /^(?:[A-Za-z]{2,9},?\s{0,3})?(\d{1,2})\s{1,3}([A-Za-z]{3,9})\.?\s{1,3}(\d{2,4})(?:\s{1,3}(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s{0,3}([A-Za-z]{1,5}|[+-]\d{2}:?\d{2})?/;

/** RFC 822 / RFC 3339 date → ISO, or `fallbackIso` when missing, unparseable, before 2000 or in the future. */
export function parseFeedDate(raw: string | undefined, fallbackIso: string): string {
  const s = (raw ?? "").trim().slice(0, 64);
  if (!s) return fallbackIso;
  let ms = Number.NaN;
  const m = RFC822.exec(s);
  if (m) {
    const mon = MONTHS[m[2]!.slice(0, 3).toLowerCase()];
    let year = Number(m[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    if (mon !== undefined) {
      let offset = 0;
      const tz = m[7];
      if (tz) {
        if (tz[0] === "+" || tz[0] === "-") {
          const digits = tz.replace(":", "");
          offset = (Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5))) * (tz[0] === "-" ? -1 : 1);
        } else offset = TZ_MIN[tz.toUpperCase()] ?? 0;
      }
      ms = Date.UTC(year, mon, Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)) - offset * 60_000;
    }
  } else if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    ms = Date.parse(s);
  }
  const fallbackMs = Date.parse(fallbackIso);
  if (!Number.isFinite(ms) || ms < Date.UTC(2000, 0, 1) || ms > fallbackMs + 60 * 60_000) return fallbackIso;
  return new Date(ms).toISOString();
}

// ── Feed → items ────────────────────────────────────────────────────────────
export type ParsedFeed = { format: "rss" | "atom" | "rdf" | null; title: string; items: ParsedItem[] };

const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif|avif)(?:$|[?#])/i;

function imageFrom(node: XmlNode, base: string): string | null {
  // 1. media:content (incl. inside media:group), widest first
  const media: XmlNode[] = [...childrenNamed(node, "media:content")];
  for (const g of childrenNamed(node, "media:group")) media.push(...childrenNamed(g, "media:content"));
  const candidates = media.filter((m) => {
    const medium = (m.attrs.medium ?? "").toLowerCase();
    const type = (m.attrs.type ?? "").toLowerCase();
    if (medium) return medium === "image";
    if (type) return type.startsWith("image/");
    return IMAGE_EXT.test(m.attrs.url ?? "");
  });
  const widest = (list: XmlNode[]) =>
    [...list].sort((a, b) => (Number(b.attrs.width) || 0) - (Number(a.attrs.width) || 0)).map((m) => safeHttpUrl(m.attrs.url, base)).find(Boolean) ?? null;
  const fromMedia = widest(candidates);
  if (fromMedia) return fromMedia;
  // 2. media:thumbnail
  const thumbs = [...childrenNamed(node, "media:thumbnail")];
  for (const g of childrenNamed(node, "media:group")) thumbs.push(...childrenNamed(g, "media:thumbnail"));
  const fromThumb = widest(thumbs);
  if (fromThumb) return fromThumb;
  // 3. enclosure / Atom link rel=enclosure with an image type
  for (const e of [...childrenNamed(node, "enclosure"), ...childrenNamed(node, "link").filter((l) => l.attrs.rel === "enclosure")]) {
    const type = (e.attrs.type ?? "").toLowerCase();
    const url = e.attrs.url ?? e.attrs.href;
    if (type.startsWith("image/") || (!type && IMAGE_EXT.test(url ?? ""))) {
      const u = safeHttpUrl(url, base);
      if (u) return u;
    }
  }
  return null;
}

function rssLink(item: XmlNode, base: string): string | null {
  const link = child(item, "link");
  if (link) {
    const fromText = safeHttpUrl(squash(textOf(link, 4_096)), base);
    if (fromText) return fromText;
    const fromHref = safeHttpUrl(link.attrs.href, base);
    if (fromHref) return fromHref;
  }
  const atomLink = child(item, "atom:link");
  if (atomLink) {
    const u = safeHttpUrl(atomLink.attrs.href, base);
    if (u) return u;
  }
  const guid = child(item, "guid");
  if (guid && (guid.attrs.ispermalink ?? "true").toLowerCase() !== "false") return safeHttpUrl(squash(textOf(guid, 4_096)), base);
  return null;
}

function atomLink(entry: XmlNode, base: string): string | null {
  const links = elements(entry).filter((e) => localName(e.name) === "link");
  const alt =
    links.find((l) => (!l.attrs.rel || l.attrs.rel === "alternate") && (!l.attrs.type || /html/i.test(l.attrs.type))) ??
    links.find((l) => !l.attrs.rel || l.attrs.rel === "alternate") ??
    links[0];
  return alt ? safeHttpUrl(alt.attrs.href, base) : null;
}

/** Atom type="xhtml" content arrives as child elements: find an <img> element directly (bounded walk). */
function elementImage(node: XmlNode | undefined, base: string): string | null {
  if (!node) return null;
  const stack = [...elements(node)];
  let guard = 0;
  while (stack.length && guard++ < 2_000) {
    const el = stack.pop()!;
    if (el.name === "img") {
      const src = pickImgSrc(el.attrs, base);
      if (src) return src;
    }
    stack.push(...elements(el));
  }
  return null;
}

function summaryAndImage(descNode: XmlNode | undefined, contentNode: XmlNode | undefined, base: string): { summary: string; image: string | null } {
  const opts = { maxChars: SUMMARY_MAX * 4, base };
  const content = contentNode ? htmlToText(textOf(contentNode, 400_000), opts) : null;
  const desc = descNode ? htmlToText(textOf(descNode, 400_000), opts) : null;
  const image = elementImage(contentNode, base) ?? elementImage(descNode, base) ?? content?.image ?? desc?.image ?? null;
  // Prefer the short description; the full content is the fallback when a feed has no description.
  const summary = desc?.text || content?.text || "";
  return { summary: truncate(stripBoilerplate(summary), SUMMARY_MAX), image };
}

export function parseFeed(xml: string, opts: { baseUrl: string; fetchedAt: string; maxItems?: number }): ParsedFeed {
  const doc = parseXml(xml);
  const rootEl = elements(doc)[0];
  const max = opts.maxItems ?? 200;
  if (!rootEl) return { format: null, title: "", items: [] };
  const rootName = localName(rootEl.name);

  let format: ParsedFeed["format"] = null;
  let container: XmlNode | undefined;
  let entries: XmlNode[] = [];
  if (rootName === "rss") {
    format = "rss";
    container = child(rootEl, "channel");
    entries = container ? elements(container).filter((e) => e.name === "item") : [];
  } else if (rootName === "feed") {
    format = "atom";
    container = rootEl;
    entries = elements(rootEl).filter((e) => localName(e.name) === "entry");
  } else if (rootName === "rdf") {
    format = "rdf";
    container = child(rootEl, "channel");
    entries = elements(rootEl).filter((e) => localName(e.name) === "item");
    if (!entries.length && container) entries = elements(container).filter((e) => localName(e.name) === "item");
  } else {
    return { format: null, title: "", items: [] };
  }

  const titleNode = container ? elements(container).find((e) => localName(e.name) === "title") : undefined;
  const feedTitle = titleNode ? cleanTitle(textOf(titleNode, 2_000)) : "";
  const items: ParsedItem[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (items.length >= max) break;
    const byLocal = (name: string) => elements(e).find((c) => localName(c.name) === name && !c.name.startsWith("media:"));
    const titleEl = format === "atom" ? byLocal("title") : child(e, "title", "dc:title");
    const title = titleEl ? cleanTitle(textOf(titleEl, 4_000)) : "";
    const url = format === "atom" ? atomLink(e, opts.baseUrl) : rssLink(e, opts.baseUrl);
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);

    const descNode = format === "atom" ? byLocal("summary") : child(e, "description", "dc:description", "summary");
    const contentNode = format === "atom" ? byLocal("content") : child(e, "content:encoded", "content");
    const { summary, image } = summaryAndImage(descNode, contentNode, url);
    const dateEl =
      format === "atom"
        ? byLocal("published") ?? byLocal("updated") ?? byLocal("issued")
        : child(e, "pubdate", "dc:date", "published", "updated", "a10:updated", "dcterms:modified");
    const publishedAt = parseFeedDate(dateEl ? textOf(dateEl, 200) : undefined, opts.fetchedAt);
    items.push({ title, url, summary, imageUrl: imageFrom(e, url) ?? image, publishedAt });
  }
  return { format, title: feedTitle, items };
}
