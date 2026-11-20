import { useEffect, useMemo, useState } from "react";
import { api, type Stats } from "../api";
import { IconChart } from "../shell/icons";
import { useToast } from "../shell/toast";
import { Empty } from "../shell/ui";
import { ChangeSummary, type MetricChange, Loading, Rating, Skeleton } from "../ui";
import { errMsg, fmtMs } from "../shell/util";
/* App.tsx Analytics route. Rating is AffectUI read-only stars for aggregate feedback; ChangeSummary already covers metrics text. Schema: Stats.totals thumbs. User: "use components in suitable places and use them to improve user interaction" */

/** Sum turns whose local_date falls in [startDay, endDay] inclusive (Date at noon local). */
function turnsInRange(perDay: { date: string; turns: number }[], start: Date, end: Date): number {
  return perDay
    .filter((d) => {
      const day = new Date(`${d.date}T12:00:00`);
      return !Number.isNaN(day.getTime()) && day >= start && day <= end;
    })
    .reduce((n, d) => n + d.turns, 0);
}

function dayAtNoon(offsetDays: number): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
}

/** Positive feedback ratio → nearest half-star on a 1–5 scale (0 ratings → null). */
export function feedbackStars(thumbsUp: number, thumbsDown: number): number | null {
  const rated = thumbsUp + thumbsDown;
  if (rated <= 0) return null;
  const ratio = thumbsUp / rated;
  // Map 0%→1★, 100%→5★; round to nearest half
  return Math.round((1 + ratio * 4) * 2) / 2;
}

function analyticsChanges(stats: Stats): MetricChange[] {
  const t = stats.totals;
  const rated = t.thumbsUp + t.thumbsDown;
  const thisWeek = turnsInRange(stats.perDay, dayAtNoon(-6), dayAtNoon(0));
  const lastWeek = turnsInRange(stats.perDay, dayAtNoon(-13), dayAtNoon(-7));
  const delta = thisWeek - lastWeek;
  const deltaTxt =
    lastWeek === 0 && thisWeek === 0
      ? "No questions yet this week"
      : lastWeek === 0
        ? `${thisWeek.toLocaleString()} this week (first activity)`
        : `${thisWeek.toLocaleString()} this week · ${delta === 0 ? "same as" : delta > 0 ? `up ${delta} vs` : `down ${Math.abs(delta)} vs`} last week`;

  const searchesPerTurn = t.turns > 0 ? t.searches / t.turns : 0;
  const changes: MetricChange[] = [
    {
      label: "Questions this week",
      change: deltaTxt,
      tone: delta > 0 ? "good" : delta < 0 ? "bad" : "neutral",
      direction: delta < 0 ? "down" : "up",
    },
    {
      label: "Web searches",
      change:
        t.searches === 0
          ? "No searches yet"
          : `${t.searches.toLocaleString()} total · ${searchesPerTurn.toFixed(1)} per question`,
      tone: "neutral",
    },
    {
      label: "Avg. response time",
      change: t.turns ? fmtMs(t.avgMs) : "No answers yet",
      tone: t.avgMs > 0 && t.avgMs < 8000 ? "good" : t.avgMs >= 20000 ? "bad" : "neutral",
      direction: t.avgMs >= 20000 ? "down" : "up",
    },
  ];
  if (rated) {
    const pct = Math.round((t.thumbsUp / rated) * 100);
    changes.push({
      label: "Feedback",
      change: `${pct}% positive (${t.thumbsUp} up · ${t.thumbsDown} down)`,
      tone: pct >= 60 ? "good" : pct < 40 ? "bad" : "neutral",
      direction: pct >= 50 ? "up" : "down",
    });
  } else {
    changes.push({ label: "Feedback", change: "No ratings yet", tone: "neutral" });
  }
  return changes;
}

function dayLabel(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function AnalyticsView() {
  const toast = useToast();
  const [stats, setStats] = useState<Stats | null>(null);
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    api
      .stats()
      .then((s) => live && setStats(s))
      .catch((e) => {
        if (live) {
          toast(`Couldn't load analytics: ${errMsg(e)}`, "error");
          setStats({ totals: { conversations: 0, turns: 0, sources: 0, files: 0, thumbsUp: 0, thumbsDown: 0, searches: 0, avgMs: 0 }, perDay: [], topDomains: [] });
        }
      });
    return () => {
      live = false;
    };
  }, [toast]);

  const summaryChanges = useMemo(() => (stats ? analyticsChanges(stats) : []), [stats]);

  if (!stats)
    return (
      <div className="view">
        <Loading label="Loading analytics" className="view-inner analytics-loading">
          <Skeleton line width="28%" height={22} />
          <Skeleton line width="52%" height={14} style={{ marginTop: 10 }} />
          <div className="analytics-skel-tiles">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} height={76} radius={10} />
            ))}
          </div>
        </Loading>
      </div>
    );

  const t = stats.totals;
  const rated = t.thumbsUp + t.thumbsDown;
  const stars = feedbackStars(t.thumbsUp, t.thumbsDown);
  const maxDay = Math.max(1, ...stats.perDay.map((d) => d.turns));
  const maxDomain = Math.max(1, ...stats.topDomains.map((d) => d.count));
  const empty = t.turns === 0;

  return (
    <div className="view analytics-view">
      <div className="view-inner">
        <header className="view-head">
          <h1>Analytics</h1>
          <p>How you use Minimi — measured from your own chats on this device (live DB, not demo data).</p>
        </header>

        <dl className="tiles">
          <Tile label="Chats" value={t.conversations.toLocaleString()} />
          <Tile label="Questions" value={t.turns.toLocaleString()} />
          <Tile label="Web searches" value={t.searches.toLocaleString()} />
          <Tile label="Avg. response time" value={t.turns ? fmtMs(t.avgMs) : "—"} />
          <Tile label="Sources cited" value={t.sources.toLocaleString()} />
          <Tile label="Feedback" value={rated ? `${Math.round((t.thumbsUp / rated) * 100)}% positive` : "—"} sub={rated ? `${t.thumbsUp} up · ${t.thumbsDown} down` : "No ratings yet"} />
        </dl>

        {stars != null && (
          <div className="analytics-rating" aria-label="Feedback score">
            <Rating readOnly value={stars} size="sm" aria-label={`${stars} out of 5 from ${rated} ratings`} />
            <span className="analytics-rating__meta muted small">{stars} / 5 from {rated} rating{rated === 1 ? "" : "s"}</span>
          </div>
        )}

        {!empty && <ChangeSummary title="What's changed" period="Recent activity" changes={summaryChanges} className="analytics-summary" />}

        {empty ? (
          <Empty icon={<IconChart size={22} />} title="No data yet">Ask a question in Chat and your usage shows up here.</Empty>
        ) : (
          <>
            <section className="card chart-card" aria-labelledby="perday-h">
              <header>
                <h3 id="perday-h">Questions per day</h3>
                <button type="button" className="btn btn-ghost sm" aria-pressed={table} onClick={() => setTable((v) => !v)}>
                  {table ? "Show chart" : "Show table"}
                </button>
              </header>
              {table ? (
                <table className="data-table">
                  <thead>
                    <tr><th scope="col">Date</th><th scope="col">Questions</th></tr>
                  </thead>
                  <tbody>
                    {stats.perDay.map((d) => (
                      <tr key={d.date}><td>{dayLabel(d.date)}</td><td>{d.turns}</td></tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="bars" role="img" aria-label={`Bar chart of questions per day. ${stats.perDay.map((d) => `${dayLabel(d.date)}: ${d.turns}`).join(", ")}`}>
                  {stats.perDay.map((d, i) => (
                    <div key={d.date} className="bar-col" data-hover={hover === i || undefined} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                      <span className="bar-val">{d.turns}</span>
                      <div className="bar-track">
                        <div className="bar" style={{ height: `${(d.turns / maxDay) * 100}%` }} />
                      </div>
                      <span className="bar-label">{dayLabel(d.date)}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="card" aria-labelledby="domains-h">
              <header>
                <h3 id="domains-h">Most cited sources</h3>
                <span className="muted small">{stats.topDomains.length ? "by number of citations" : ""}</span>
              </header>
              {stats.topDomains.length ? (
                <ul className="hbars">
                  {stats.topDomains.map((d) => (
                    <li key={d.domain}>
                      <span className="hb-label">{d.domain}</span>
                      <span className="hb-track">
                        <span className="hb-bar" style={{ width: `${(d.count / maxDomain) * 100}%` }} />
                      </span>
                      <span className="hb-val">{d.count}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">No web sources have been cited yet.</p>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="tile">
      <dt>{label}</dt>
      <dd>{value}</dd>
      {sub && <small>{sub}</small>}
    </div>
  );
}
