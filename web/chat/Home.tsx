import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { api, type Conversation, type FileRow, type Integrations, type Project, type Stats } from "../api";
import { DropdownMenu } from "../shell/DropdownMenu";
import { fmtMs, relTime } from "../shell/util";
import "./home.css";

/*
 * Home screen of a new chat: brand, a centered composer with its footer strip, and an overview grid.
 * Every number is real (conversations, files, stats.activity); nothing is invented. ChatView mounts
 * <HomeHero> around the composer and <HomeCards> beneath it while no message has been sent.
 */

/** Accepts "#/files"-style targets; navigates to the clean "/app/files" path through App's router. */
const go = (target: string) => {
  window.dispatchEvent(new CustomEvent("minimi:navigate", { detail: `/app/${target.replace(/^#?\/?/, "")}` }));
};
const openSearch = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));

/* ── tiny icon set (14px, 1.5 stroke) ── */
function Ico({ children, size = 14 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}
const IcCalendar = () => <Ico><rect x="2.5" y="3.5" width="11" height="10" rx="2" /><path d="M2.5 6.5h11M5.5 2v2.5M10.5 2v2.5" /></Ico>;
const IcClock = () => <Ico><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.2l2 1.2" /></Ico>;
const IcGauge = () => <Ico><rect x="2.5" y="2.5" width="11" height="11" rx="2.5" /><path d="M5.5 8h5" /></Ico>;
const IcFiles = () => <Ico><path d="M4 2.5h5l3 3v8H4z" /><path d="M9 2.5v3h3M6 9h4M6 11h3" /></Ico>;
const IcChat = () => <Ico size={13}><path d="M3 3.5h10v7H7.5L5 13v-2.5H3z" /></Ico>;
const IcFolder = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M1.5 4.5a1.5 1.5 0 0 1 1.5-1.5h3l1.4 1.5H13a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12z" fill="var(--accent)" />
  </svg>
);
const IcDoc = ({ tone }: { tone: "md" | "csv" | "txt" }) => (
  <span className="home__ficon" data-tone={tone} aria-hidden="true">
    <svg width="10" height="12" viewBox="0 0 10 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"><path d="M1.5 .8h4.6L8.7 3.4v7.8H1.5z" /><path d="M6 .8v2.8h2.7" /></svg>
  </span>
);

/** The in-app logo: the same blue "M" tile as the favicon. */
function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <text x="16" y="22.5" fontSize="18" fontFamily="var(--font)" fontWeight="700" textAnchor="middle" fill="#0b0b0c">M</text>
    </svg>
  );
}

/* ═════════════════ Hero: brand + composer box + footer strip ═════════════════ */

const PROVIDER_TONE: Record<string, string> = { nvidia: "#76b900", tavily: "#8b7cf6", anthropic: "#d97757", openai: "#10a37f" };
const toneFor = (name: string) => PROVIDER_TONE[Object.keys(PROVIDER_TONE).find((k) => name.toLowerCase().includes(k)) ?? ""] ?? "var(--faint)";

export function HomeHero({
  children,
  heroRef,
  integrations,
  onOpenIntegrations,
  onFolder,
}: {
  children: ReactNode;
  heroRef?: Ref<HTMLDivElement>;
  integrations: Integrations | null;
  onOpenIntegrations: () => void;
  /** Chosen folder id (null = none). The chat is attached to it once it exists. */
  onFolder: (projectId: string | null) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [folder, setFolder] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.listConversations().then((r) => live && setProjects(r.projects)).catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const chosen = projects.find((p) => p.id === folder);
  // A folder that was deleted elsewhere must not stay attached.
  useEffect(() => {
    if (folder && projects.length && !chosen) {
      setFolder(null);
      onFolder(null);
    }
  }, [folder, projects, chosen, onFolder]);
  useEffect(() => () => onFolder(null), [onFolder]);

  const pick = (id: string | null) => {
    setFolder(id);
    onFolder(id);
  };

  const marks = integrations
    ? [
        { name: integrations.llm.provider, ok: integrations.llm.connected },
        { name: integrations.search.provider, ok: integrations.search.connected },
      ]
    : [];

  return (
    <>
      <div className="hero__brand">
        <Logo />
        <span>Minimi</span>
      </div>
      <div className="hero__box" ref={heroRef}>
        {children}
        <div className="hero__strip">
          <DropdownMenu
            side="bottom"
            align="start"
            width={250}
            aria-label="Work in a folder"
            items={[
              { label: "No folder", description: "Keep this chat on its own", type: "radio", checked: folder === null, onSelect: () => pick(null) },
              ...projects.map((p) => ({
                label: p.name,
                description: `${p.chat_count} chat${p.chat_count === 1 ? "" : "s"} · ${p.file_count} file${p.file_count === 1 ? "" : "s"}`,
                type: "radio" as const,
                checked: folder === p.id,
                onSelect: () => pick(p.id),
              })),
              { label: "Manage folders…", onSelect: () => go("#/files") },
            ]}
            trigger={({ triggerProps }) => (
              <button type="button" className="hero__link" {...triggerProps}>
                <IcFolder />
                <span>{chosen ? `Working in ${chosen.name}` : "Work in a folder"}</span>
              </button>
            )}
          />
          <button type="button" className="hero__link hero__link--apps" onClick={onOpenIntegrations}>
            <span>Connect apps</span>
            <span className="hero__marks" aria-hidden="true">
              {marks.map((m) => (
                <i key={m.name} data-off={m.ok ? undefined : ""} style={{ ["--mk" as string]: toneFor(m.name) }}>
                  {m.name.charAt(0).toUpperCase()}
                </i>
              ))}
            </span>
          </button>
        </div>
      </div>
    </>
  );
}

/* ═════════════════ Overview cards ═════════════════ */

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const monthKey = (d: Date) => ymd(d).slice(0, 7);
const inMonth = (iso: string, key: string) => {
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && monthKey(d) === key;
};
const WEEKS = 34;

function Card({ i, title, icon, more, onMore, className, children }: { i: number; title: string; icon: ReactNode; more?: string; onMore?: () => void; className?: string; children: ReactNode }) {
  return (
    <section className={`home__card ${className ?? ""}`} style={{ ["--i" as string]: i }}>
      <header>
        <h3>
          {icon}
          {title}
        </h3>
        {more && (
          <button type="button" onClick={onMore}>
            {more}
          </button>
        )}
      </header>
      {children}
    </section>
  );
}

function Delta({ now, prev }: { now: number; prev: number }) {
  const d = now - prev;
  return <em data-dir={d > 0 ? "up" : d < 0 ? "down" : "flat"}>{d > 0 ? `+${d}` : d < 0 ? `−${Math.abs(d)}` : "±0"}</em>;
}

export function HomeCards({ suggestions, onPrompt }: { suggestions: { label: string; prompt: string }[]; onPrompt: (prompt: string) => void }) {
  const [convs, setConvs] = useState<Conversation[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [files, setFiles] = useState<FileRow[] | null>(null);
  const [statsDone, setStatsDone] = useState(false);

  useEffect(() => {
    let live = true;
    api.listConversations().then((r) => live && setConvs(r.conversations)).catch(() => live && setConvs([]));
    api.stats().then((s) => live && setStats(s)).catch(() => {}).finally(() => live && setStatsDone(true));
    api.listFiles().then((r) => live && setFiles(r.files)).catch(() => live && setFiles([]));
    return () => {
      live = false;
    };
  }, []);

  const model = useMemo(() => {
    if (!convs || !files) return null;
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((WEEKS - 1) * 7 + today.getDay()));
    const byDate = new Map((stats?.activity ?? stats?.perDay ?? []).map((d) => [d.date, d.turns]));
    const cells = Array.from({ length: WEEKS * 7 }, (_, i) => {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const date = ymd(d);
      return { i, d, date, turns: d > today ? -1 : (byDate.get(date) ?? 0) };
    });
    const peak = Math.max(1, ...cells.map((c) => c.turns));
    const thisKey = monthKey(today);
    const prev = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const prevKey = monthKey(prev);
    const q = (key: string) => [...byDate].filter(([d]) => d.startsWith(key)).reduce((n, [, v]) => n + v, 0);
    return {
      cells,
      peak,
      range: `${start.toLocaleDateString(undefined, { month: "short" })} – ${today.toLocaleDateString(undefined, { month: "short" })}`,
      chats: { now: convs.filter((c) => inMonth(c.created_at, thisKey)).length, prev: convs.filter((c) => inMonth(c.created_at, prevKey)).length },
      files: { now: files.filter((f) => inMonth(f.created_at, thisKey)).length, prev: files.filter((f) => inMonth(f.created_at, prevKey)).length },
      qs: { now: q(thisKey), prev: q(prevKey) },
    };
  }, [convs, files, stats]);

  const heatRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string; edge: "l" | "c" | "r" } | null>(null);
  const showTip = (el: HTMLElement, text: string) => {
    const box = heatRef.current?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!box) return;
    const x = r.left - box.left + r.width / 2;
    // Keep the bubble inside the card: anchor it to the nearer edge when the cell is close to a side.
    setTip({ x, y: r.top - box.top, text, edge: x < 90 ? "l" : x > box.width - 90 ? "r" : "c" });
  };

  if (!convs || !files || !model || !statsDone) return null;

  // Brand-new install: nothing to summarize yet, so offer starting points instead of empty cards.
  if (convs.length === 0 && files.length === 0) {
    return (
      <div className="home__starts" role="group" aria-label="Try asking">
        {suggestions.map((s) => (
          <button key={s.label} type="button" className="home__start" onClick={() => onPrompt(s.prompt)}>
            {s.label}
          </button>
        ))}
      </div>
    );
  }

  const recent = convs.slice(0, 3);
  const recentFiles = files.slice(0, 3);
  const tone = (n: string) => (/\.md$|\.markdown$/i.test(n) ? "md" : /\.(csv|tsv)$/i.test(n) ? "csv" : "txt");
  const usagePct = model.qs.prev > 0 ? Math.min(100, Math.round((model.qs.now / model.qs.prev) * 100)) : model.qs.now > 0 ? 100 : 0;
  const totalQ = stats?.totals.turns ?? 0;

  return (
    <div className="home" aria-label="Overview">
      <Card i={0} title="Activity" icon={<IcCalendar />} className="home__c2">
        <div
          className="home__heat"
          ref={heatRef}
          role="img"
          aria-label={`${totalQ.toLocaleString()} questions asked, shown per day over the last ${WEEKS} weeks`}
          onMouseLeave={() => setTip(null)}
        >
          {model.cells.map((c) => {
            const col = Math.floor(c.i / 7);
            return c.turns < 0 ? (
              <i key={c.date} className="is-future" />
            ) : (
              <i
                key={c.date}
                style={{ ["--lv" as string]: c.turns === 0 ? 0 : Math.ceil((c.turns / model.peak) * 4), ["--c" as string]: col }}
                onMouseEnter={(e) =>
                  showTip(e.currentTarget, `${c.d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · ${c.turns === 0 ? "No questions" : `${c.turns} question${c.turns === 1 ? "" : "s"}`}`)
                }
              />
            );
          })}
          {tip && (
            <span className="home__tip" data-edge={tip.edge} style={{ left: tip.x, top: tip.y }} role="tooltip">
              {tip.text}
            </span>
          )}
        </div>
        <p className="home__foot home__foot--split">
          <span>
            <b>{convs.length.toLocaleString()}</b> chats · <b>{files.length.toLocaleString()}</b> files · <b>{(stats?.totals.searches ?? 0).toLocaleString()}</b> searches
          </span>
          <span>{model.range}</span>
        </p>
      </Card>

      <Card i={1} title="Recent chats" icon={<IcClock />} more={convs.length > 3 ? `${convs.length - 3} more` : undefined} onMore={openSearch} className="home__c2">
        <ul className="home__list">
          {recent.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => go(`#/chat/${encodeURIComponent(c.id)}`)}>
                <IcChat />
                <span>{c.title || "Untitled chat"}</span>
                <time>{relTime(c.updated_at)}</time>
              </button>
            </li>
          ))}
        </ul>
      </Card>

      <Card i={2} title="Usage" icon={<IcGauge />} className="home__c1">
        <p className="home__big">
          {model.qs.now.toLocaleString()}
          <small>{model.qs.prev > 0 ? ` / ${model.qs.prev.toLocaleString()} questions` : " questions this month"}</small>
        </p>
        <div className="home__bar" role="progressbar" aria-label="Questions this month compared with last month" aria-valuemin={0} aria-valuemax={100} aria-valuenow={usagePct}>
          <i style={{ ["--w" as string]: `${usagePct}%` }} />
        </div>
        <p className="home__foot">avg {totalQ && stats ? fmtMs(stats.totals.avgMs) : "—"} per answer</p>
      </Card>

      <Card i={3} title="Files made for you" icon={<IcFiles />} more={files.length > 3 ? `${files.length - 3} more` : undefined} onMore={() => go("#/files")} className="home__c2">
        {recentFiles.length === 0 ? (
          <p className="home__foot">Files you upload or the agent creates show up here.</p>
        ) : (
          <ul className="home__list">
            {recentFiles.map((f) => (
              <li key={f.id}>
                <button type="button" onClick={() => go("#/files")}>
                  <IcDoc tone={tone(f.name)} />
                  <span>{f.name}</span>
                  <time>{relTime(f.created_at)}</time>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card i={4} title="This month" icon={<IcCalendar />} className="home__c1">
        <dl className="home__month">
          <div>
            <dt>Chats</dt>
            <dd>
              {model.chats.now}
              <Delta now={model.chats.now} prev={model.chats.prev} />
            </dd>
          </div>
          <div>
            <dt>Files made</dt>
            <dd>
              {model.files.now}
              <Delta now={model.files.now} prev={model.files.prev} />
            </dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}
