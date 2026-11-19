import { useEffect, useState } from "react";
import { api, type Stats } from "../api";
import { IconChart } from "../shell/icons";
import { useToast } from "../shell/toast";
import { Empty, Spinner } from "../shell/ui";
import { errMsg, fmtMs } from "../shell/util";

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

  if (!stats)
    return (
      <div className="view">
        <div className="loading-row"><Spinner /></div>
      </div>
    );

  const t = stats.totals;
  const rated = t.thumbsUp + t.thumbsDown;
  const maxDay = Math.max(1, ...stats.perDay.map((d) => d.turns));
  const maxDomain = Math.max(1, ...stats.topDomains.map((d) => d.count));
  const empty = t.turns === 0;

  return (
    <div className="view analytics-view">
      <div className="view-inner">
        <header className="view-head">
          <h1>Analytics</h1>
          <p>How you use Minimi — measured from your own chats on this device.</p>
        </header>

        <dl className="tiles">
          <Tile label="Chats" value={t.conversations.toLocaleString()} />
          <Tile label="Questions" value={t.turns.toLocaleString()} />
          <Tile label="Web searches" value={t.searches.toLocaleString()} />
          <Tile label="Avg. response time" value={t.turns ? fmtMs(t.avgMs) : "—"} />
          <Tile label="Sources cited" value={t.sources.toLocaleString()} />
          <Tile label="Feedback" value={rated ? `${Math.round((t.thumbsUp / rated) * 100)}% 👍` : "—"} sub={rated ? `${t.thumbsUp} up · ${t.thumbsDown} down` : "No ratings yet"} />
        </dl>

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
