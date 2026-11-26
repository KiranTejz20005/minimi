import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  api,
  ApiError,
  DiscoverError,
  type DiscoverFacet,
  type DiscoverStatus,
  type NewsItem,
  type NewsPage,
  type Startup,
  type StartupContext,
  type StartupStats,
  type StartupsPage,
} from "../api";
import { IconAlert, IconCheck, IconChevronDown, IconDiscover, IconExternal, IconSearch, IconSparkle, IconX } from "../shell/icons";
import { useToast } from "../shell/toast";
import { fmtMs, useStored } from "../shell/util";
import { Loading, Skeleton } from "../ui";
import {
  NEWS_DOMAINS,
  amountHeadline,
  amountParts,
  contextSections,
  countUnseen,
  describeError,
  domainLabel,
  facetChips,
  fullDate,
  groupByDay,
  hasMore,
  hostOf,
  humanize,
  investorsLine,
  mergeUnique,
  monogram,
  monogramTone,
  originalAmountNote,
  plural,
  refreshInPlace,
  relativeTime,
  relativeUntil,
  roundLabel,
  safeHttpUrl,
  sectorLabel,
  shortDate,
  sortSources,
  sourceSummary,
  spokenAmount,
  statusText,
  textLines,
  formatAmount,
} from "./discover-utils";
import "./discover.css";
/* App.tsx "discover" route (/app/discover/news|startups). Reads /api/discover/* via api.discover*. User: "a tab where it should
   update the latest news from time to time ... latest startups that raised funding ... give me some details and context about it". */

type Tab = "news" | "startups";
const TABS: { id: Tab; label: string }[] = [
  { id: "news", label: "News" },
  { id: "startups", label: "Startups" },
];
const PAGE = 30;
const POLL_MS = 60_000;
const FAST_POLL_MS = 3_000;
const EMPTY_IDS: ReadonlySet<string> = new Set();
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

const isAbort = (e: unknown) => typeof e === "object" && e !== null && (e as { name?: string }).name === "AbortError";
const errText = (e: unknown) => describeError(e instanceof ApiError ? e.status : 0, e instanceof Error ? e.message : "");
const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ── Icons used only here (24px grid, same stroke as shell/icons) ── */
function Glyph({ d, size = 16, className, spin }: { d: string; size?: number; className?: string; spin?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
      data-spin={spin || undefined}
    >
      <path d={d} />
    </svg>
  );
}
const REFRESH_D = "M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4";
const INFO_D = "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 8h.01";
const ARROW_UP_D = "M12 19V5M6 11l6-6 6 6";

/* ── Small hooks ── */

/** Re-renders every `ms` so relative times ("4 min ago") stay true while the page is open. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

/** False while the browser tab is hidden: polling pauses then. */
function usePageVisible(): boolean {
  const [v, setV] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    const on = () => setV(!document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return v;
}

/** Debounced value; clearing (empty string) applies at once. */
function useDebounced(value: string, ms: number): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    if (!value) {
      setV("");
      return;
    }
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** A 1 s tick while `on` (elapsed seconds, Retry-After countdowns). */
function useTicker(on: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = window.setInterval(() => setN((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, [on]);
  return n;
}

/** Which edges of a horizontal scroller have hidden content ("none" | "start" | "end" | "both"). */
function useScrollFade(ref: RefObject<HTMLElement | null>, contentKey: string): string {
  const [fade, setFade] = useState("none");
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const start = el.scrollLeft > 2;
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
      setFade(start && end ? "both" : start ? "start" : end ? "end" : "none");
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, [ref, contentKey]);
  return fade;
}

/** True once the sticky bar is pinned to the top of the scroller (draws its hairline only then). */
function useStuck(): [boolean, (el: HTMLDivElement | null) => void] {
  const [stuck, setStuck] = useState(false);
  const obs = useRef<IntersectionObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    obs.current?.disconnect();
    obs.current = null;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const root = el.closest(".view");
    obs.current = new IntersectionObserver(
      ([e]) => {
        if (!e) return;
        setStuck(!e.isIntersecting && e.boundingClientRect.top < (e.rootBounds?.top ?? 0) + 1);
      },
      { root, threshold: 0 },
    );
    obs.current.observe(el);
  }, []);
  return [stuck, ref];
}

/* ── Feed: one filtered, paginated, polled list ─────────────────────────── */

type FeedPage<T> = { items: T[]; total: number; updatedAt: string | null };
type FeedState<T, P> = {
  phase: "loading" | "ready" | "error";
  items: T[];
  total: number;
  /** Server offset for the next "Load more" (independent of de-duplicated items.length). */
  nextOffset: number;
  /** Latest first-page response (facets, stats). */
  page: P | null;
  error: string | null;
  /** A filter change is loading: the old list stays, dimmed, until the answer lands. */
  stale: boolean;
  more: "idle" | "loading" | "error";
  /** A polled first page holding items not on screen yet ("N new"). */
  pending: P | null;
  unseen: number;
  /** Ids that just arrived (fade in once). */
  fresh: ReadonlySet<string>;
  /** First successful load: play the list entrance once. */
  enter: boolean;
};

function useFeed<T extends { id: string }, P extends FeedPage<T>>(o: {
  key: string;
  fetchPage: (offset: number, signal: AbortSignal) => Promise<P>;
  active: boolean;
  visible: boolean;
  reloadSignal: number;
  pollSignal: number;
}) {
  const [s, setS] = useState<FeedState<T, P>>(() => ({
    phase: "loading",
    items: [],
    total: 0,
    nextOffset: 0,
    page: null,
    error: null,
    stale: false,
    more: "idle",
    pending: null,
    unseen: 0,
    fresh: EMPTY_IDS,
    enter: false,
  }));
  const sRef = useRef(s);
  sRef.current = s;
  const fetchRef = useRef(o.fetchPage);
  fetchRef.current = o.fetchPage;
  const pollCtl = useRef<AbortController | null>(null);
  const moreCtl = useRef<AbortController | null>(null);
  const busy = useRef(false); // the filtered first page is loading; polls wait for it
  const lastFetch = useRef(0);
  const shownOnce = useRef(false);
  const [nonce, setNonce] = useState(0);

  // Filters changed (or Retry): load the first page; stale requests are aborted.
  useEffect(() => {
    pollCtl.current?.abort();
    moreCtl.current?.abort();
    const ctl = new AbortController();
    busy.current = true;
    setS((p) =>
      p.items.length
        ? { ...p, stale: true, pending: null, unseen: 0, more: "idle" }
        : { ...p, phase: "loading", error: null, pending: null, unseen: 0, more: "idle" },
    );
    fetchRef.current(0, ctl.signal).then(
      (page) => {
        if (ctl.signal.aborted) return;
        busy.current = false;
        lastFetch.current = Date.now();
        const enter = !shownOnce.current && page.items.length > 0;
        if (page.items.length) shownOnce.current = true;
        setS((p) => ({
          ...p,
          phase: "ready",
          items: page.items,
          total: page.total,
          nextOffset: page.items.length,
          page,
          error: null,
          stale: false,
          pending: null,
          unseen: 0,
          fresh: EMPTY_IDS,
          enter,
        }));
      },
      (e) => {
        if (ctl.signal.aborted || isAbort(e)) return;
        busy.current = false;
        setS((p) => ({ ...p, phase: "error", items: [], total: 0, nextOffset: 0, error: errText(e), stale: false }));
      },
    );
    return () => {
      ctl.abort();
      busy.current = false;
    };
  }, [o.key, nonce]);

  // A polled or reloaded first page. Polls never reorder what is on screen: new items wait behind the "N new" pill.
  const applyFirstPage = useCallback((page: P, mode: "poll" | "reload") => {
    lastFetch.current = Date.now();
    setS((p) => {
      if (p.phase !== "ready" || !p.items.length) {
        if (!page.items.length && p.phase === "ready") return { ...p, page, total: page.total };
        return {
          ...p,
          phase: "ready",
          items: page.items,
          total: page.total,
          nextOffset: page.items.length,
          page,
          error: null,
          stale: false,
          pending: null,
          unseen: 0,
          fresh: new Set(page.items.map((i) => i.id)),
          enter: false,
        };
      }
      const unseen = countUnseen(page.items, p.items);
      if (mode === "poll" && unseen > 0) return { ...p, page, pending: page, unseen };
      if (!unseen) return { ...p, items: refreshInPlace(p.items, page.items), total: page.total, page, pending: null, unseen: 0 };
      const shown = new Set(p.items.map((i) => i.id));
      return {
        ...p,
        items: mergeUnique(page.items, p.items),
        total: page.total,
        nextOffset: Math.max(p.nextOffset, page.items.length),
        page,
        pending: null,
        unseen: 0,
        fresh: new Set(page.items.filter((i) => !shown.has(i.id)).map((i) => i.id)),
      };
    });
  }, []);

  const fetchFirst = useCallback(
    (mode: "poll" | "reload") => {
      if (busy.current) return; // the filter load in flight is already fetching fresh data
      pollCtl.current?.abort();
      const ctl = new AbortController();
      pollCtl.current = ctl;
      fetchRef.current(0, ctl.signal).then(
        (page) => {
          if (!ctl.signal.aborted) applyFirstPage(page, mode);
        },
        () => {
          /* background request: the next poll tries again */
        },
      );
    },
    [applyFirstPage],
  );

  const showPending = useCallback(() => {
    setS((p) => {
      if (!p.pending) return p;
      const page = p.pending;
      const shown = new Set(p.items.map((i) => i.id));
      return {
        ...p,
        items: mergeUnique(page.items, p.items),
        total: page.total,
        nextOffset: Math.max(p.nextOffset, page.items.length),
        page,
        pending: null,
        unseen: 0,
        fresh: new Set(page.items.filter((i) => !shown.has(i.id)).map((i) => i.id)),
      };
    });
  }, []);

  const loadMore = useCallback(() => {
    if (busy.current || sRef.current.more === "loading") return;
    moreCtl.current?.abort();
    const ctl = new AbortController();
    moreCtl.current = ctl;
    const offset = sRef.current.nextOffset;
    setS((p) => ({ ...p, more: "loading" }));
    fetchRef.current(offset, ctl.signal).then(
      (page) => {
        if (ctl.signal.aborted) return;
        setS((p) => ({
          ...p,
          items: mergeUnique(p.items, page.items),
          total: page.items.length ? page.total : offset, // an empty page ends paging
          nextOffset: offset + page.items.length,
          more: "idle",
        }));
      },
      (e) => {
        if (ctl.signal.aborted || isAbort(e)) return;
        setS((p) => ({ ...p, more: "error" }));
      },
    );
  }, []);

  // Background polling: every 60 s while this list is shown and the browser tab is visible; catch up on return/focus.
  const { active, visible } = o;
  useEffect(() => {
    if (!active || !visible) return;
    if (lastFetch.current && Date.now() - lastFetch.current >= POLL_MS) fetchFirst("poll");
    const t = window.setInterval(() => fetchFirst("poll"), POLL_MS);
    const onFocus = () => {
      if (lastFetch.current && Date.now() - lastFetch.current > 15_000) fetchFirst("poll");
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [active, visible, fetchFirst]);

  // A refresh the user asked for finished: show its results directly. One the server ran on its own: poll (pill).
  useEffect(() => {
    if (o.reloadSignal) fetchFirst("reload");
  }, [o.reloadSignal, fetchFirst]);
  useEffect(() => {
    if (o.pollSignal) fetchFirst("poll");
  }, [o.pollSignal, fetchFirst]);

  // One-shot animation flags clear themselves, so later renders (filters, polls) are instant.
  useEffect(() => {
    if (!s.enter) return;
    const t = window.setTimeout(() => setS((p) => ({ ...p, enter: false })), 900);
    return () => window.clearTimeout(t);
  }, [s.enter]);
  useEffect(() => {
    if (!s.fresh.size) return;
    const t = window.setTimeout(() => setS((p) => ({ ...p, fresh: EMPTY_IDS })), 1200);
    return () => window.clearTimeout(t);
  }, [s.fresh]);

  useEffect(
    () => () => {
      pollCtl.current?.abort();
      moreCtl.current?.abort();
    },
    [],
  );

  return { ...s, hasMore: hasMore(s.nextOffset, s.total), retry: () => setNonce((n) => n + 1), loadMore, showPending };
}

/* ── Status + manual refresh ────────────────────────────────────────────── */

const EMPTY_STATUS: DiscoverStatus = { lastRefreshAt: null, nextRefreshAt: null, refreshing: false, newsCount: 0, startupCount: 0, sources: [] };

function useDiscoverStatus(visible: boolean) {
  const toast = useToast();
  const [status, setStatus] = useState<DiscoverStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [reloadSignal, setReloadSignal] = useState(0);
  const [pollSignal, setPollSignal] = useState(0);
  const [announce, setAnnounce] = useState("");
  const manual = useRef(false);
  const wasRefreshing = useRef(false);
  const ctl = useRef<AbortController | null>(null);
  const lastLoad = useRef(0);

  const load = useCallback(() => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    lastLoad.current = Date.now();
    api.discoverStatus(c.signal).then(
      (st) => {
        if (c.signal.aborted) return;
        setStatus(st);
        setError(null);
        const was = wasRefreshing.current;
        wasRefreshing.current = st.refreshing;
        if (!was || st.refreshing) return;
        // A refresh just finished.
        if (manual.current) {
          manual.current = false;
          setReloadSignal((n) => n + 1);
          const failing = st.sources.filter((x) => !x.ok).length;
          setAnnounce(failing ? `Sources refreshed. ${plural(failing, "source", "sources")} couldn't be reached.` : "Sources refreshed.");
          if (failing) toast(`Refreshed, but ${plural(failing, "source", "sources")} couldn't be reached. See the status line for details.`, "info");
        } else {
          setPollSignal((n) => n + 1);
        }
      },
      (e) => {
        if (c.signal.aborted || isAbort(e)) return;
        setError(errText(e));
      },
    );
  }, [toast]);

  // Every 60 s while visible; every 3 s while a refresh runs, so the lists reload as soon as it ends.
  const refreshing = !!status?.refreshing;
  useEffect(() => {
    if (!visible) return;
    if (Date.now() - lastLoad.current > 2000) load();
    const t = window.setInterval(load, refreshing ? FAST_POLL_MS : POLL_MS);
    return () => window.clearInterval(t);
  }, [visible, refreshing, load]);
  useEffect(() => () => ctl.current?.abort(), []);

  const refresh = useCallback(async () => {
    if (requesting || refreshing) return;
    setRequesting(true);
    try {
      const r = await api.discoverRefresh();
      if (r.started || r.reason === "already_running") {
        ctl.current?.abort(); // a status answer from before the refresh must not end it early
        manual.current = true;
        wasRefreshing.current = true;
        setStatus((s) => ({ ...(s ?? EMPTY_STATUS), refreshing: true }));
        setAnnounce("Refreshing sources.");
      } else {
        setReloadSignal((n) => n + 1);
        toast("Sources were refreshed a moment ago. Showing the latest.", "info");
      }
    } catch (e) {
      toast(`Couldn't refresh: ${errText(e)}`, "error");
    } finally {
      setRequesting(false);
    }
  }, [requesting, refreshing, toast]);

  return { status, error, busy: requesting || refreshing, refresh, reloadSignal, pollSignal, announce };
}

/* ── AI context jobs (kept here so a brief keeps generating after its panel closes) ── */

type CtxJob = { phase: "loading"; startedAt: number } | { phase: "error"; error: string; retryAt: number | null };

/* ── View ───────────────────────────────────────────────────────────────── */

export function DiscoverView({ tab: tabParam, onTab }: { tab?: string; onTab: (t: Tab) => void }) {
  const toast = useToast();
  const [storedTab, setStoredTab] = useStored<string>("minimi.discover.tab", "news");
  const tab: Tab = tabParam === "news" || tabParam === "startups" ? tabParam : storedTab === "startups" ? "startups" : "news";
  const visible = usePageVisible();
  const now = useNow(30_000);
  const st = useDiscoverStatus(visible);
  const [queries, setQueries] = useState<Record<Tab, string>>({ news: "", startups: "" });
  const qNews = useDebounced(queries.news.trim(), 250);
  const qStartups = useDebounced(queries.startups.trim(), 250);
  const [contexts, setContexts] = useState<Record<string, StartupContext>>({});
  const [jobs, setJobs] = useState<Record<string, CtxJob>>({});
  const inflight = useRef(new Set<string>());
  const [selected, setSelected] = useState<Startup | null>(null);
  // The card's sector label (built from the server's facets, e.g. "E-commerce"), so the sheet shows the same words.
  const [selectedSector, setSelectedSector] = useState("");
  const openStartup = useCallback((s: Startup, sectorText: string) => {
    setSelectedSector(sectorText);
    setSelected(s);
  }, []);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollPos = useRef<Record<Tab, number>>({ news: 0, startups: 0 });
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ news: null, startups: null });
  const searchRef = useRef<HTMLInputElement>(null);
  const [stuck, sentinelRef] = useStuck();

  // /app/discover → /app/discover/<tab>, so the address always names what is shown.
  useEffect(() => {
    if (tabParam !== tab) onTab(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Each tab keeps its own scroll position (tab switches are instant, never animated).
  const selectTab = (t: Tab, focus = false) => {
    if (t !== tab) {
      if (scrollRef.current) scrollPos.current[tab] = scrollRef.current.scrollTop;
      setStoredTab(t);
      onTab(t);
    }
    if (focus) tabRefs.current[t]?.focus();
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = scrollPos.current[tab];
  }, [tab]);

  const onTabsKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    let n = -1;
    if (e.key === "ArrowRight") n = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") n = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = TABS.length - 1;
    if (n < 0) return;
    e.preventDefault();
    selectTab(TABS[n]!.id, true);
  };

  const scrollToTop = useCallback(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, []);

  const generate = useCallback(
    (s: Startup) => {
      const id = s.id;
      if (inflight.current.has(id)) return;
      inflight.current.add(id);
      setJobs((j) => ({ ...j, [id]: { phase: "loading", startedAt: Date.now() } }));
      api.discoverContext(id).then(
        (r) => {
          inflight.current.delete(id);
          setContexts((c) => ({ ...c, [id]: r.context }));
          setJobs((j) => {
            const n = { ...j };
            delete n[id];
            return n;
          });
          if (selectedRef.current?.id !== id) toast(`Context for ${s.company || "the startup"} is ready.`, "success");
        },
        (e) => {
          inflight.current.delete(id);
          const retryAt = e instanceof DiscoverError && e.status === 429 ? Date.now() + (e.retryAfterSec ?? 30) * 1000 : null;
          setJobs((j) => ({ ...j, [id]: { phase: "error", error: errText(e), retryAt } }));
        },
      );
    },
    [toast],
  );

  const setQuery = (t: Tab, v: string) => setQueries((q) => (q[t] === v ? q : { ...q, [t]: v }));

  return (
    <div className="view discover-view" ref={scrollRef}>
      <div className="view-inner dv">
        <header className="dv-head">
          <div className="dv-head__text">
            <h1>Discover</h1>
            <StatusLine status={st.status} error={st.error} now={now} />
          </div>
          <button type="button" className="btn dv-refresh" onClick={() => void st.refresh()} aria-disabled={st.busy || undefined}>
            <Glyph d={REFRESH_D} size={14} className="dv-refresh__icon" spin={st.busy} />
            <span>{st.busy ? "Refreshing…" : "Refresh"}</span>
          </button>
        </header>

        <div ref={sentinelRef} className="dv-sentinel" aria-hidden="true" />
        <div className="dv-bar" data-stuck={stuck || undefined}>
          <div role="tablist" aria-label="Discover sections" className="dv-tabs" onKeyDown={onTabsKey}>
            {TABS.map((t) => (
              <button
                key={t.id}
                ref={(el) => {
                  tabRefs.current[t.id] = el;
                }}
                type="button"
                role="tab"
                id={`dv-tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`dv-panel-${t.id}`}
                tabIndex={tab === t.id ? 0 : -1}
                className="dv-tab"
                onClick={() => selectTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <SearchField
            value={queries[tab]}
            onChange={(v) => setQuery(tab, v)}
            label={tab === "news" ? "Search news" : "Search startups"}
            inputRef={searchRef}
          />
        </div>

        <section role="tabpanel" id="dv-panel-news" aria-labelledby="dv-tab-news" hidden={tab !== "news"} className="dv-panel">
          <NewsPanel
            active={tab === "news"}
            visible={visible}
            now={now}
            q={qNews}
            reloadSignal={st.reloadSignal}
            pollSignal={st.pollSignal}
            refreshing={st.busy}
            onRefresh={() => void st.refresh()}
            onClearSearch={() => setQuery("news", "")}
            onShowNew={scrollToTop}
          />
        </section>
        <section role="tabpanel" id="dv-panel-startups" aria-labelledby="dv-tab-startups" hidden={tab !== "startups"} className="dv-panel">
          <StartupsPanel
            active={tab === "startups"}
            visible={visible}
            now={now}
            q={qStartups}
            reloadSignal={st.reloadSignal}
            pollSignal={st.pollSignal}
            refreshing={st.busy}
            onRefresh={() => void st.refresh()}
            onClearSearch={() => setQuery("startups", "")}
            onShowNew={scrollToTop}
            contexts={contexts}
            jobs={jobs}
            onOpen={openStartup}
          />
        </section>
      </div>

      <StartupSheet
        startup={selected}
        sectorText={selectedSector}
        context={selected ? (contexts[selected.id] ?? selected.context) : null}
        job={selected ? jobs[selected.id] : undefined}
        now={now}
        onClose={() => setSelected(null)}
        onGenerate={generate}
      />
      <p className="sr-only" aria-live="polite">
        {st.announce}
      </p>
    </div>
  );
}

/* ── Header status line + source health popover ─────────────────────────── */

function StatusLine({ status, error, now }: { status: DiscoverStatus | null; error: string | null; now: number }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const popId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      btn.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const summary = sourceSummary(status?.sources);
  const text = !status && error ? "Status unavailable" : statusText(status, now);

  return (
    <div
      className="dv-status"
      ref={wrap}
      onBlur={(e) => {
        // Tabbing out closes the popover. A null relatedTarget (click on plain text) is left to the outside-click handler.
        const next = e.relatedTarget as Node | null;
        if (open && next && !wrap.current?.contains(next)) setOpen(false);
      }}
    >
      <button ref={btn} type="button" className="dv-status__btn" aria-expanded={open} aria-controls={popId} onClick={() => setOpen((o) => !o)}>
        {status?.refreshing ? (
          <span className="dv-live" aria-hidden="true" />
        ) : summary.failing || (!status && error) ? (
          <IconAlert size={13} className="dv-status__warn" />
        ) : null}
        <span>{text}</span>
        {status && summary.total > 0 && (
          <>
            <span className="dv-sep" aria-hidden="true">
              ·
            </span>
            <span>{summary.text}</span>
          </>
        )}
        <IconChevronDown size={12} className="dv-status__chev" />
      </button>
      {open && (
        <div id={popId} className="dv-pop" role="region" aria-label="Source health">
          <div className="dv-pop__head">
            <strong>Sources</strong>
            {status?.refreshing ? <span>Refreshing now</span> : status?.nextRefreshAt ? <span>Next refresh {relativeUntil(status.nextRefreshAt, now)}</span> : null}
          </div>
          {error && (
            <p className="dv-pop__err">
              <IconAlert size={13} /> {error}
            </p>
          )}
          {status && status.sources.length > 0 ? (
            <ul className="dv-sources">
              {sortSources(status.sources).map((s, i) => (
                <li key={`${s.kind}-${s.name}-${i}`} data-ok={s.ok}>
                  <span className="dv-sources__icon" aria-hidden="true">
                    {s.ok ? <IconCheck size={13} /> : <IconAlert size={13} />}
                  </span>
                  <span className="dv-sources__name">
                    {s.name}
                    {s.kind && <small>{humanize(s.kind)}</small>}
                  </span>
                  <span className="dv-sources__meta">
                    <span className="sr-only">{s.ok ? "Working, " : ""}</span>
                    {s.ok ? `${plural(s.items, "item", "items")} · ${fmtMs(s.ms)}` : "Failed"}
                  </span>
                  {!s.ok && s.error && <span className="dv-sources__err">{s.error}</span>}
                </li>
              ))}
            </ul>
          ) : (
            !error && <p className="dv-pop__empty">{status ? "No sources have reported yet. They appear after the first refresh." : "Checking sources…"}</p>
          )}
          {status && (
            <p className="dv-pop__foot">
              {plural(status.newsCount, "story", "stories")} · {plural(status.startupCount, "startup", "startups")} stored
              {status.lastRefreshAt ? ` · last refresh ${shortDate(status.lastRefreshAt, now)}, ${relativeTime(status.lastRefreshAt, now)}` : ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Controls ───────────────────────────────────────────────────────────── */

function SearchField({ value, onChange, label, inputRef }: { value: string; onChange: (v: string) => void; label: string; inputRef: RefObject<HTMLInputElement | null> }) {
  const id = useId();
  return (
    <div className="dv-search">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <IconSearch size={14} />
      <input
        ref={inputRef}
        id={id}
        type="search"
        value={value}
        placeholder={label}
        maxLength={120}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.preventDefault();
            e.stopPropagation();
            onChange("");
          }
        }}
      />
      {value && (
        <button
          type="button"
          className="dv-search__clear"
          aria-label="Clear search"
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
        >
          <IconX size={12} />
        </button>
      )}
    </div>
  );
}

type RadioOption = { id: string; label: string; count?: number };

/** Single-choice row (role="radiogroup", roving tabindex, arrow keys). Filtering is instant: no animation. */
function RadioRow({
  label,
  options,
  value,
  onChange,
  variant,
  unit,
}: {
  label: string;
  options: RadioOption[];
  value: string;
  onChange: (id: string) => void;
  variant: "chips" | "seg";
  unit?: [string, string];
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const fade = useScrollFade(scroller, options.map((o) => o.id).join("|"));
  const sel = Math.max(0, options.findIndex((o) => o.id === value));
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const n = options.length;
    if (!n) return;
    let i = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") i = (sel + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") i = (sel - 1 + n) % n;
    else if (e.key === "Home") i = 0;
    else if (e.key === "End") i = n - 1;
    if (i < 0) return;
    e.preventDefault();
    onChange(options[i]!.id);
    refs.current[i]?.focus();
  };
  return (
    <div
      ref={scroller}
      role="radiogroup"
      aria-label={label}
      className={variant === "chips" ? "dv-chips" : "dv-seg"}
      data-fade={variant === "chips" && fade !== "none" ? fade : undefined}
      onKeyDown={onKey}
    >
      {options.map((o, i) => (
        <button
          key={o.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          tabIndex={i === sel ? 0 : -1}
          className={variant === "chips" ? "dv-chip" : "dv-seg__btn"}
          aria-label={unit && o.count !== undefined && o.count > 0 ? `${o.label}, ${plural(o.count, unit[0], unit[1])}` : undefined}
          onClick={() => onChange(o.id)}
        >
          <span>{o.label}</span>
          {o.count !== undefined && o.count > 0 && (
            <span className="dv-chip__n" aria-hidden="true">
              {o.count.toLocaleString("en-US")}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function NewPill({ count, unit, onShow }: { count: number; unit: [string, string]; onShow: () => void }) {
  return (
    <div className="dv-newpill-wrap" aria-live="polite">
      {count > 0 && (
        <button type="button" className="dv-newpill" onClick={onShow}>
          <Glyph d={ARROW_UP_D} size={13} />
          {plural(count, unit[0], unit[1])}
        </button>
      )}
    </div>
  );
}

function StateBlock({ icon, title, children, action, tone }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode; tone?: "error" }) {
  return (
    <div className="dv-state" data-tone={tone} role={tone === "error" ? "alert" : undefined}>
      <div className="dv-state__icon" aria-hidden="true">
        {icon}
      </div>
      <p className="dv-state__title">{title}</p>
      {children && <p className="dv-state__sub">{children}</p>}
      {action && <div className="dv-state__act">{action}</div>}
    </div>
  );
}

function FeedFooter({
  shown,
  total,
  more,
  canLoadMore,
  onMore,
  unit,
}: {
  shown: number;
  total: number;
  more: "idle" | "loading" | "error";
  canLoadMore: boolean;
  onMore: () => void;
  unit: [string, string];
}) {
  if (!shown) return null;
  const all = Math.max(total, shown);
  return (
    <div className="dv-foot">
      {canLoadMore && (
        <button type="button" className="btn dv-more" onClick={onMore} aria-disabled={more === "loading" || undefined}>
          {more === "loading" ? (
            <>
              <span className="dv-spinner" aria-hidden="true" />
              Loading…
            </>
          ) : (
            "Load more"
          )}
        </button>
      )}
      <p className="dv-foot__count">{canLoadMore ? `Showing ${shown.toLocaleString("en-US")} of ${plural(all, unit[0], unit[1])}` : `Showing all ${plural(shown, unit[0], unit[1])}`}</p>
      {more === "error" && (
        <p className="dv-foot__err" role="alert">
          <IconAlert size={13} /> Couldn't load more.
          <button type="button" className="dv-link" onClick={onMore}>
            Retry
          </button>
        </p>
      )}
    </div>
  );
}

/* ── News ───────────────────────────────────────────────────────────────── */

type PanelProps = {
  active: boolean;
  visible: boolean;
  now: number;
  q: string;
  reloadSignal: number;
  pollSignal: number;
  refreshing: boolean;
  onRefresh: () => void;
  onClearSearch: () => void;
  onShowNew: () => void;
};

function NewsPanel(p: PanelProps) {
  const [domain, setDomain] = useState("all");
  const listRef = useRef<HTMLDivElement>(null);
  const uid = useId();
  const fetchPage = useCallback(
    (offset: number, signal: AbortSignal) => api.discoverNews({ domain, q: p.q, limit: PAGE, offset }, signal),
    [domain, p.q],
  );
  const feed = useFeed<NewsItem, NewsPage>({
    key: `${domain}\u0000${p.q}`,
    fetchPage,
    active: p.active,
    visible: p.visible,
    reloadSignal: p.reloadSignal,
    pollSignal: p.pollSignal,
  });
  const facets: DiscoverFacet[] | undefined = feed.page?.domains;
  const chips = useMemo(() => facetChips(facets, NEWS_DOMAINS), [facets]);
  const groups = useMemo(() => groupByDay(feed.items, p.now), [feed.items, p.now]);
  const label = domainLabel(domain, facets);

  const showNew = () => {
    feed.showPending();
    p.onShowNew();
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>("a[href]")?.focus({ preventScroll: true }));
  };
  const clear = () => {
    setDomain("all");
    p.onClearSearch();
  };

  let index = 0;
  let body: ReactNode;
  if (feed.phase === "loading") body = <NewsSkeleton />;
  else if (feed.phase === "error")
    body = (
      <StateBlock
        tone="error"
        icon={<IconAlert size={20} />}
        title="Couldn't load news"
        action={
          <button type="button" className="btn" onClick={feed.retry}>
            Retry
          </button>
        }
      >
        {feed.error}
      </StateBlock>
    );
  else if (!feed.items.length)
    body =
      domain !== "all" || p.q ? (
        <StateBlock
          icon={<IconSearch size={20} />}
          title={p.q ? `No ${domain !== "all" ? `${label} ` : ""}stories match “${p.q}”` : `No ${label} stories yet`}
          action={
            <button type="button" className="btn" onClick={clear}>
              Clear filters
            </button>
          }
        >
          {p.q ? "Try a different word, or search every domain." : "Stories in this domain appear after the next refresh."}
        </StateBlock>
      ) : (
        <StateBlock
          icon={<IconDiscover size={20} />}
          title="No news yet"
          action={
            <button type="button" className="btn btn-primary" onClick={p.onRefresh} aria-disabled={p.refreshing || undefined}>
              {p.refreshing ? "Refreshing…" : "Refresh now"}
            </button>
          }
        >
          Minimi gathers stories from its sources on a schedule. Refresh to fetch the latest now.
        </StateBlock>
      );
  else
    body = (
      <div ref={listRef} className="dv-news" data-stale={feed.stale || undefined} aria-busy={feed.stale || undefined} data-enter={feed.enter || undefined}>
        {groups.map((g, gi) => (
          <section key={g.key} className="dv-day" aria-labelledby={`${uid}-g${gi}`}>
            <h2 id={`${uid}-g${gi}`} className="dv-day__h">
              {g.label}
            </h2>
            <ul className="dv-stories">
              {g.items.map((it) => (
                <NewsRow key={it.id} item={it} i={index++} now={p.now} showDomain={domain === "all"} facets={facets} fresh={feed.fresh.has(it.id)} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    );

  return (
    <>
      <div className="dv-filters">
        <RadioRow variant="chips" label="Filter news by domain" options={chips} value={domain} onChange={setDomain} unit={["story", "stories"]} />
      </div>
      <NewPill count={feed.unseen} unit={["new story", "new stories"]} onShow={showNew} />
      {body}
      {feed.phase === "ready" && (
        <FeedFooter shown={feed.items.length} total={feed.total} more={feed.more} canLoadMore={feed.hasMore} onMore={feed.loadMore} unit={["story", "stories"]} />
      )}
    </>
  );
}

function NewsRow({ item, i, now, showDomain, facets, fresh }: { item: NewsItem; i: number; now: number; showDomain: boolean; facets?: DiscoverFacet[]; fresh: boolean }) {
  // Feed text is rendered as React text only; links are allowed only for absolute http(s) URLs.
  const href = safeHttpUrl(item.url);
  const source = item.source?.trim() || hostOf(item.url) || "Unknown source";
  const when = relativeTime(item.publishedAt, now);
  return (
    <li className="dv-story dv-item" style={{ "--i": i } as CSSProperties} data-fresh={fresh || undefined} data-link={href ? "" : undefined}>
      <span className="dv-mono" data-tone={monogramTone(source)} aria-hidden="true">
        {monogram(source)}
      </span>
      <div className="dv-story__body">
        <p className="dv-story__meta">
          <span className="dv-story__src">{source}</span>
          {when && (
            <>
              <span className="dv-sep" aria-hidden="true">
                ·
              </span>
              <time dateTime={item.publishedAt} title={fullDate(item.publishedAt)}>
                {when}
              </time>
            </>
          )}
          {showDomain && item.domain && (
            <>
              <span className="dv-sep" aria-hidden="true">
                ·
              </span>
              <span className="dv-story__dom">{domainLabel(item.domain, facets)}</span>
            </>
          )}
        </p>
        <h3 className="dv-story__title">
          {href ? (
            <a className="dv-story__a" href={href} target="_blank" rel="noopener noreferrer">
              {item.title || "Untitled story"}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : (
            item.title || "Untitled story"
          )}
        </h3>
        {item.summary && <p className="dv-story__sum">{item.summary}</p>}
      </div>
      {href && <IconExternal size={14} className="dv-story__ext" />}
    </li>
  );
}

function NewsSkeleton() {
  return (
    <Loading label="Loading news" className="dv-news">
      <div className="dv-day">
        <Skeleton line={18} width={72} height={9} className="dv-day__skel" />
        <ul className="dv-stories">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="dv-story">
              <Skeleton width={32} height={32} radius={8} />
              <div className="dv-story__body">
                <Skeleton line={18} width="34%" height={9} />
                <Skeleton line={22} width="94%" height={12} />
                <Skeleton line={22} width={i % 2 ? "56%" : "72%"} height={12} />
                <Skeleton line={20} width="86%" height={10} />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Loading>
  );
}

/* ── Startups ───────────────────────────────────────────────────────────── */

const SORTS: RadioOption[] = [
  { id: "recent", label: "Recent" },
  { id: "amount", label: "Amount" },
];

function StartupsPanel(
  p: PanelProps & { contexts: Record<string, StartupContext>; jobs: Record<string, CtxJob>; onOpen: (s: Startup, sectorText: string) => void },
) {
  const [sector, setSector] = useState("all");
  const [sort, setSort] = useState<"recent" | "amount">("recent");
  const listRef = useRef<HTMLUListElement>(null);
  const fetchPage = useCallback(
    (offset: number, signal: AbortSignal) => api.discoverStartups({ sector, q: p.q, sort, limit: PAGE, offset }, signal),
    [sector, sort, p.q],
  );
  const feed = useFeed<Startup, StartupsPage>({
    key: `${sector}\u0000${sort}\u0000${p.q}`,
    fetchPage,
    active: p.active,
    visible: p.visible,
    reloadSignal: p.reloadSignal,
    pollSignal: p.pollSignal,
  });
  const facets: DiscoverFacet[] | undefined = feed.page?.sectors;
  const chips = useMemo(() => facetChips(facets), [facets]);
  const label = sectorLabel(sector, facets);

  const showNew = () => {
    feed.showPending();
    p.onShowNew();
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true }));
  };
  const clear = () => {
    setSector("all");
    p.onClearSearch();
  };

  let body: ReactNode;
  if (feed.phase === "loading") body = <StartupsSkeleton />;
  else if (feed.phase === "error")
    body = (
      <StateBlock
        tone="error"
        icon={<IconAlert size={20} />}
        title="Couldn't load startups"
        action={
          <button type="button" className="btn" onClick={feed.retry}>
            Retry
          </button>
        }
      >
        {feed.error}
      </StateBlock>
    );
  else if (!feed.items.length)
    body =
      sector !== "all" || p.q ? (
        <StateBlock
          icon={<IconSearch size={20} />}
          title={p.q ? `No ${sector !== "all" ? `${label} ` : ""}startups match “${p.q}”` : `No ${label} startups yet`}
          action={
            <button type="button" className="btn" onClick={clear}>
              Clear filters
            </button>
          }
        >
          {p.q ? "Try a company, investor or another word." : "Funding rounds in this sector appear after the next refresh."}
        </StateBlock>
      ) : (
        <StateBlock
          icon={<IconDiscover size={20} />}
          title="No funding rounds yet"
          action={
            <button type="button" className="btn btn-primary" onClick={p.onRefresh} aria-disabled={p.refreshing || undefined}>
              {p.refreshing ? "Refreshing…" : "Refresh now"}
            </button>
          }
        >
          Minimi scans funding news on a schedule. Refresh to look for new rounds now.
        </StateBlock>
      );
  else
    body = (
      <ul ref={listRef} className="dv-cards" data-stale={feed.stale || undefined} aria-busy={feed.stale || undefined} data-enter={feed.enter || undefined}>
        {feed.items.map((s, i) => (
          <StartupCard
            key={s.id}
            s={s}
            i={i}
            now={p.now}
            facets={facets}
            fresh={feed.fresh.has(s.id)}
            hasContext={!!(p.contexts[s.id] ?? s.context)}
            generating={p.jobs[s.id]?.phase === "loading"}
            onOpen={p.onOpen}
          />
        ))}
      </ul>
    );

  return (
    <>
      <h2 className="sr-only">Recently funded startups</h2>
      <StatsLine stats={feed.page?.stats} phase={feed.phase} />
      <div className="dv-filters">
        <RadioRow variant="chips" label="Filter startups by sector" options={chips} value={sector} onChange={setSector} unit={["startup", "startups"]} />
        <div className="dv-sort">
          <span className="dv-sort__label" aria-hidden="true">
            Sort
          </span>
          <RadioRow variant="seg" label="Sort startups by" options={SORTS} value={sort} onChange={(v) => setSort(v === "amount" ? "amount" : "recent")} />
        </div>
      </div>
      <NewPill count={feed.unseen} unit={["new startup", "new startups"]} onShow={showNew} />
      {body}
      {feed.phase === "ready" && (
        <FeedFooter shown={feed.items.length} total={feed.total} more={feed.more} canLoadMore={feed.hasMore} onMore={feed.loadMore} unit={["startup", "startups"]} />
      )}
    </>
  );
}

/** A quiet sentence, not a row of big-number tiles: the card amounts are the one signature element. */
function StatsLine({ stats, phase }: { stats?: StartupStats; phase: "loading" | "ready" | "error" }) {
  if (!stats) {
    if (phase === "error") return null;
    return (
      <div className="dv-stats" aria-hidden="true">
        <Skeleton line={22} width="min(100%, 440px)" height={10} />
      </div>
    );
  }
  return (
    <p className="dv-stats">
      <span>
        <b>{stats.count.toLocaleString("en-US")}</b> {stats.count === 1 ? "startup" : "startups"} tracked
      </span>
      <span className="dv-sep" aria-hidden="true">
        ·
      </span>
      <span>
        <b>{stats.last7d.toLocaleString("en-US")}</b> raised in the last 7 days
      </span>
      {stats.totalUsd !== null && stats.totalUsd > 0 && (
        <>
          <span className="dv-sep" aria-hidden="true">
            ·
          </span>
          <span>
            <b>{formatAmount(stats.totalUsd)}</b> disclosed in total
          </span>
        </>
      )}
    </p>
  );
}

function Amount({ s, large }: { s: Pick<Startup, "amountUsd" | "amountText">; large?: boolean }) {
  const parts = amountParts(s.amountUsd);
  const head = amountHeadline(s);
  return (
    <p className={`dv-amount${large ? " dv-amount--lg" : ""}`} data-kind={parts ? undefined : head.disclosed ? "raw" : "none"}>
      {parts ? (
        <>
          <span className="sr-only">{spokenAmount(s.amountUsd)}</span>
          <span aria-hidden="true">
            <span className="dv-amount__sym">{parts.symbol}</span>
            {parts.value}
            {parts.unit && <span className="dv-amount__unit">{parts.unit}</span>}
          </span>
        </>
      ) : (
        head.text
      )}
    </p>
  );
}

function StartupCard({
  s,
  i,
  now,
  facets,
  fresh,
  hasContext,
  generating,
  onOpen,
}: {
  s: Startup;
  i: number;
  now: number;
  facets?: DiscoverFacet[];
  fresh: boolean;
  hasContext: boolean;
  generating: boolean;
  onOpen: (s: Startup, sectorText: string) => void;
}) {
  const uid = useId();
  const round = roundLabel(s.round);
  const sector = s.sector && s.sector !== "all" ? sectorLabel(s.sector, facets) : "";
  const inv = investorsLine(s.investors);
  const when = relativeTime(s.publishedAt, now);
  return (
    <li className="dv-item dv-card-li" style={{ "--i": i } as CSSProperties} data-fresh={fresh || undefined}>
      <article className="dv-card" aria-labelledby={`${uid}-name`}>
        <div className="dv-card__top">
          <span className="dv-tags" id={`${uid}-tags`}>
            {round && <span className="dv-tag">{round}</span>}
            {sector && <span className="dv-tag">{sector}</span>}
          </span>
          {when && (
            <time className="dv-card__time" dateTime={s.publishedAt} title={fullDate(s.publishedAt)}>
              {when}
            </time>
          )}
        </div>
        <div id={`${uid}-amt`}>
          <Amount s={s} />
        </div>
        <h3 className="dv-card__name">
          <button type="button" id={`${uid}-name`} className="dv-card__open" aria-haspopup="dialog" aria-describedby={`${uid}-amt ${uid}-tags`} onClick={() => onOpen(s, sector)}>
            {s.company || "Unnamed company"}
          </button>
        </h3>
        {s.summary && <p className="dv-card__sum">{s.summary}</p>}
        {(inv || hasContext || generating) && (
          <div className="dv-card__foot">
            {inv ? (
              <p className="dv-card__inv">
                <span className="sr-only">Investors: </span>
                {inv}
              </p>
            ) : (
              <span />
            )}
            {(hasContext || generating) && (
              <span className="dv-card__brief">
                <IconSparkle size={12} />
                {hasContext ? "Context ready" : "Writing context…"}
              </span>
            )}
          </div>
        )}
      </article>
    </li>
  );
}

function StartupsSkeleton() {
  return (
    <Loading label="Loading startups">
      <ul className="dv-cards">
        {Array.from({ length: 6 }, (_, i) => (
          <li key={i} className="dv-card-li">
            <div className="dv-card">
              <Skeleton line={22} width="42%" height={10} />
              <Skeleton line={36} width={i % 2 ? "38%" : "48%"} height={24} style={{ marginTop: 12 }} />
              <Skeleton line={22} width="58%" height={13} />
              <Skeleton line={20} width="100%" height={10} style={{ marginTop: 4 }} />
              <Skeleton line={20} width="70%" height={10} />
              <Skeleton line={18} width="50%" height={9} style={{ marginTop: 12 }} />
            </div>
          </li>
        ))}
      </ul>
    </Loading>
  );
}

/* ── Detail panel: right side on wide windows, full sheet on narrow ones ── */

function StartupSheet({
  startup,
  sectorText,
  context,
  job,
  now,
  onClose,
  onGenerate,
}: {
  startup: Startup | null;
  /** Label the card showed (from the server's sector facets); falls back to the humanized id. */
  sectorText: string;
  context: StartupContext | null;
  job: CtxJob | undefined;
  now: number;
  onClose: () => void;
  onGenerate: (s: Startup) => void;
}) {
  const [shown, setShown] = useState<Startup | null>(null);
  const [state, setState] = useState<"open" | "closed">("closed");
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleId = useId();
  const invId = useId();

  // Mount closed, then open on the next frames so the CSS transition runs; on close, transition out, then unmount.
  useEffect(() => {
    if (startup) {
      if (!opener.current) opener.current = document.activeElement as HTMLElement | null;
      setShown(startup);
      let r2 = 0;
      const r1 = requestAnimationFrame(() => {
        r2 = requestAnimationFrame(() => setState("open"));
      });
      return () => {
        cancelAnimationFrame(r1);
        cancelAnimationFrame(r2);
      };
    }
    setState("closed");
    const el = opener.current;
    opener.current = null;
    if (el && document.contains(el)) el.focus({ preventScroll: true });
    const t = window.setTimeout(() => setShown(null), 170);
    return () => window.clearTimeout(t);
  }, [startup]);

  // Focus moves into the panel when it opens.
  useEffect(() => {
    if (startup && shown === startup) panel.current?.focus({ preventScroll: true });
  }, [shown, startup]);

  // Esc closes; Tab stays inside while open.
  useEffect(() => {
    if (!startup) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const node = panel.current;
      if (!node) return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (!node.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || active === node)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [startup]);

  if (!shown) return null;
  const s = shown;
  const href = safeHttpUrl(s.url);
  const host = hostOf(s.url);
  const round = roundLabel(s.round);
  const sector = sectorText || (s.sector && s.sector !== "all" ? sectorLabel(s.sector) : "");
  const source = s.source?.trim() || host;
  const note = originalAmountNote(s);
  const investors = (s.investors ?? []).map((x) => String(x).trim()).filter(Boolean);
  const when = relativeTime(s.publishedAt, now);

  return createPortal(
    <>
      <div className="dv-sheet-backdrop" data-state={state} onMouseDown={() => closeRef.current()} aria-hidden="true" />
      <div ref={panel} className="dv-sheet" data-state={state} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="dv-sheet__head">
          <span className="dv-mono dv-mono--lg" data-tone={monogramTone(s.company)} aria-hidden="true">
            {monogram(s.company)}
          </span>
          <div className="dv-sheet__title">
            <h2 id={titleId}>{s.company || "Unnamed company"}</h2>
            {(sector || s.location) && <p>{[sector, s.location].filter(Boolean).join(" · ")}</p>}
          </div>
          <button type="button" className="icon-btn dv-close" aria-label="Close details" onClick={() => closeRef.current()}>
            <IconX size={16} />
          </button>
        </header>

        <div className="dv-sheet__body">
          <section className="dv-sheet__hero" aria-label="Funding round">
            <Amount s={s} large />
            <p className="dv-sheet__round">
              {round && <span className="dv-tag">{round}</span>}
              {s.publishedAt && (
                <span>
                  Announced <time dateTime={s.publishedAt} title={fullDate(s.publishedAt)}>{shortDate(s.publishedAt, now)}</time>
                  {when ? ` · ${when}` : ""}
                </span>
              )}
            </p>
            {note && <p className="dv-note">{note}</p>}
          </section>

          {s.summary && <p className="dv-sheet__sum">{s.summary}</p>}

          <dl className="dv-facts">
            <div>
              <dt>Round</dt>
              <dd>{round || "Not stated"}</dd>
            </div>
            <div>
              <dt>Sector</dt>
              <dd>{sector || "Not stated"}</dd>
            </div>
            <div>
              <dt>Location</dt>
              <dd>{s.location || "Not stated"}</dd>
            </div>
            <div>
              <dt>Reported by</dt>
              <dd>{source || "Unknown source"}</dd>
            </div>
          </dl>

          <section aria-labelledby={invId}>
            <h3 id={invId} className="dv-sheet__h">
              Investors
            </h3>
            {investors.length ? (
              <ul className="dv-investors">
                {investors.map((n, i) => (
                  <li key={`${i}-${n}`}>{n}</li>
                ))}
              </ul>
            ) : (
              <p className="dv-muted">The article doesn't name the investors.</p>
            )}
          </section>

          {href && (
            <a className="btn dv-source" href={href} target="_blank" rel="noopener noreferrer">
              Read on {source || "the source"}
              <IconExternal size={14} />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          )}

          <ContextBlock company={s.company} context={context} job={job} now={now} onGenerate={() => onGenerate(s)} />
        </div>
      </div>
    </>,
    document.body,
  );
}

function ContextBlock({
  company,
  context,
  job,
  now,
  onGenerate,
}: {
  company: string;
  context: StartupContext | null;
  job: CtxJob | undefined;
  now: number;
  onGenerate: () => void;
}) {
  const hId = useId();
  const cId = useId();
  const loading = job?.phase === "loading";
  const retryAt = job?.phase === "error" ? job.retryAt : null;
  useTicker(loading || !!retryAt);
  const elapsed = job?.phase === "loading" ? Math.max(0, Math.floor((Date.now() - job.startedAt) / 1000)) : 0;
  const wait = retryAt ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) : 0;
  const sections = contextSections(context);
  const caveats = textLines(context?.caveats);
  const model = context?.model ? context.model.split("/").pop() : null;
  const generated = context ? relativeTime(context.generatedAt, now) : "";

  return (
    <section className="dv-ctx" aria-labelledby={hId} aria-busy={loading || undefined}>
      <div className="dv-ctx__head">
        <h3 id={hId} className="dv-sheet__h">
          <IconSparkle size={14} /> Context
        </h3>
        {context && (generated || model) && (
          <span className="dv-ctx__meta">
            {generated ? `Generated ${generated}` : ""}
            {generated && model ? " · " : ""}
            {model ?? ""}
          </span>
        )}
      </div>

      {context ? (
        <>
          <p className="dv-ctx__note">
            <Glyph d={INFO_D} size={14} />
            {/* model === null: the server built it from the stored record without a model (src/discover/enrich.ts) */}
            {context.model ? "AI-generated from the article, may be incomplete." : "Summarized from the headline and feed text only. No AI model was used."}
          </p>
          {sections.length ? (
            sections.map((sec) => (
              <div key={sec.key} className="dv-ctx__sec">
                <h4>{sec.title}</h4>
                {sec.lines.length > 1 ? (
                  <ul>
                    {sec.lines.map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ul>
                ) : (
                  <p>{sec.lines[0]}</p>
                )}
              </div>
            ))
          ) : (
            <p className="dv-muted">The article didn't have enough detail for a brief.</p>
          )}
          {caveats.length > 0 && (
            <div className="dv-caveats" role="note" aria-labelledby={cId}>
              <IconAlert size={14} />
              <div>
                <h4 id={cId}>Caveats</h4>
                {caveats.length > 1 ? (
                  <ul>
                    {caveats.map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ul>
                ) : (
                  <p>{caveats[0]}</p>
                )}
              </div>
            </div>
          )}
        </>
      ) : loading ? (
        <div className="dv-ctx__loading">
          <p className="dv-ctx__progress" role="status">
            Reading the article and writing a brief
            <span aria-hidden="true">… {elapsed}s</span>
          </p>
          {["34%", "26%", "30%", "38%", "24%"].map((w, i) => (
            <div key={i} className="dv-ctx__sec" aria-hidden="true">
              <Skeleton line={18} width={w} height={9} />
              <Skeleton line={22} width="100%" height={10} />
              <Skeleton line={22} width={i % 2 ? "64%" : "82%"} height={10} />
            </div>
          ))}
        </div>
      ) : job?.phase === "error" ? (
        <div className="dv-ctx__error" role="alert">
          <p>
            <IconAlert size={14} />
            <span>Couldn't generate context. {job.error}</span>
          </p>
          <button
            type="button"
            className="btn"
            aria-disabled={wait > 0 || undefined}
            onClick={() => {
              if (wait <= 0) onGenerate();
            }}
          >
            {wait > 0 ? `Try again in ${wait}s` : "Retry"}
          </button>
        </div>
      ) : (
        <div className="dv-ctx__idle">
          <p>
            A short brief on what {company || "this company"} does, the round, its investors, why it matters and the market around it. Written by AI from the
            article when a model is connected, which can take up to 20 seconds.
          </p>
          <button type="button" className="btn btn-primary" onClick={onGenerate}>
            <IconSparkle size={14} />
            Generate context
          </button>
        </div>
      )}
    </section>
  );
}
