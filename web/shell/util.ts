import { useCallback, useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";

/* ── Formatting ── */
export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0]![0]! + (parts.length > 1 ? parts[parts.length - 1]![0]! : "")).toUpperCase();
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong";
}

/* ── Markdown ── */
let hooked = false;
marked.setOptions({ breaks: true, gfm: true });
export function renderMd(text: string): string {
  if (!hooked) {
    DOMPurify.addHook("afterSanitizeAttributes", (n) => {
      if (n.tagName === "A") {
        n.setAttribute("target", "_blank");
        n.setAttribute("rel", "noopener noreferrer");
      }
    });
    hooked = true;
  }
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
}

/* ── Persisted state ── */
export function useStored<T extends string | boolean>(key: string, initial: T): [T, (v: T) => void] {
  const [val, setVal] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return initial;
      return (typeof initial === "boolean" ? raw === "true" : raw) as T;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setVal(v);
      try {
        localStorage.setItem(key, String(v));
      } catch {
        /* storage unavailable */
      }
    },
    [key],
  );
  return [val, set];
}

/* ── Theme ── */
export type ThemePref = "dark" | "light" | "system";
export function applyTheme(pref: ThemePref): void {
  const dark = typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = pref === "system" ? (dark ? "dark" : "light") : pref;
}

export function useTheme(): [ThemePref, (t: ThemePref) => void] {
  const [pref, setPref] = useStored<string>("minimi.theme", "dark");
  const p = (pref === "light" || pref === "system" ? pref : "dark") as ThemePref;
  useEffect(() => {
    applyTheme(p);
    if (p !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const fn = () => applyTheme("system");
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [p]);
  // Every useTheme() instance (App, Settings) stays in sync: a change is broadcast and the others adopt it.
  useEffect(() => {
    const on = (e: Event) => {
      const t = (e as CustomEvent<string>).detail;
      if (t === "dark" || t === "light" || t === "system") setPref(t);
    };
    window.addEventListener("minimi:theme", on);
    return () => window.removeEventListener("minimi:theme", on);
  }, [setPref]);
  return [
    p,
    (t) => {
      setPref(t);
      window.dispatchEvent(new CustomEvent("minimi:theme", { detail: t }));
    },
  ];
}

/* ── Misc hooks ── */
export function useMediaQuery(q: string): boolean {
  const [m, setM] = useState(() => (typeof window !== "undefined" ? window.matchMedia(q).matches : false));
  useEffect(() => {
    const mq = window.matchMedia(q);
    const fn = () => setM(mq.matches);
    fn();
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [q]);
  return m;
}

/** Latest-value ref, so event handlers never go stale. */
export function useLatest<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}
