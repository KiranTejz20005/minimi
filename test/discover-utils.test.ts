import { describe, expect, it } from "vitest";
import {
  amountHeadline,
  amountParts,
  buildQuery,
  contextSections,
  countUnseen,
  dayGroupLabel,
  describeError,
  domainLabel,
  facetChips,
  formatAmount,
  fullDate,
  groupByDay,
  hasMore,
  hostOf,
  humanize,
  investorsLine,
  mergeUnique,
  monogram,
  monogramTone,
  MONOGRAM_TONES,
  originalAmountNote,
  parseRetryAfter,
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
} from "../web/views/discover-utils.js";

// Local-time constructors keep these tests independent of the machine's time zone.
const NOW = new Date(2026, 10, 25, 14, 0, 0).getTime(); // Wed Nov 25 2026, 14:00 local
const at = (y: number, mo: number, d: number, h = 12, mi = 0, s = 0) => new Date(y, mo, d, h, mi, s).toISOString();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HR = 60 * MIN;

describe("relativeTime", () => {
  it("reads recent times in minutes and hours", () => {
    expect(relativeTime(ago(10_000), NOW)).toBe("just now");
    expect(relativeTime(ago(59_999), NOW)).toBe("just now");
    expect(relativeTime(ago(MIN), NOW)).toBe("1 min ago");
    expect(relativeTime(ago(4 * MIN + 30_000), NOW)).toBe("4 min ago");
    expect(relativeTime(ago(59 * MIN), NOW)).toBe("59 min ago");
    expect(relativeTime(ago(HR), NOW)).toBe("1 hr ago");
    expect(relativeTime(ago(23 * HR + 59 * MIN), NOW)).toBe("23 hr ago");
  });

  it("says yesterday, then days, then a date", () => {
    expect(relativeTime(at(2026, 10, 24, 9), NOW)).toBe("yesterday"); // 29 h ago, previous calendar day
    expect(relativeTime(at(2026, 10, 22, 9), NOW)).toBe("3 days ago");
    expect(relativeTime(at(2026, 10, 19, 15), NOW)).toBe("6 days ago");
    expect(relativeTime(at(2026, 10, 3), NOW)).toBe("Nov 3");
    expect(relativeTime(at(2025, 11, 30), NOW)).toBe("Dec 30, 2025");
  });

  it("treats future timestamps (clock skew) as just now and bad input as empty", () => {
    expect(relativeTime(new Date(NOW + 5 * MIN).toISOString(), NOW)).toBe("just now");
    expect(relativeTime("not a date", NOW)).toBe("");
    expect(relativeTime(null, NOW)).toBe("");
    expect(relativeTime(undefined, NOW)).toBe("");
  });
});

describe("relativeUntil / dates / status", () => {
  it("describes the next refresh", () => {
    expect(relativeUntil(new Date(NOW + 20_000).toISOString(), NOW)).toBe("soon");
    expect(relativeUntil(new Date(NOW - 20_000).toISOString(), NOW)).toBe("soon");
    expect(relativeUntil(new Date(NOW + 12 * MIN).toISOString(), NOW)).toBe("in 12 min");
    expect(relativeUntil(new Date(NOW + 2 * HR).toISOString(), NOW)).toBe("in 2 hr");
    expect(relativeUntil(at(2026, 11, 2), NOW)).toBe("on Dec 2");
    expect(relativeUntil(null, NOW)).toBe("");
  });

  it("formats short and full dates", () => {
    expect(shortDate(at(2026, 0, 5), NOW)).toBe("Jan 5");
    expect(shortDate(at(2024, 6, 4), NOW)).toBe("Jul 4, 2024");
    expect(shortDate("", NOW)).toBe("");
    expect(fullDate(at(2026, 10, 25, 9, 5))).toBe("Wednesday, Nov 25, 2026 at 09:05");
    expect(fullDate("nope")).toBe("");
  });

  it("builds the header status line", () => {
    expect(statusText(null, NOW)).toBe("Checking sources…");
    expect(statusText({ refreshing: true, lastRefreshAt: ago(MIN) }, NOW)).toBe("Refreshing sources…");
    expect(statusText({ refreshing: false, lastRefreshAt: ago(4 * MIN) }, NOW)).toBe("Updated 4 min ago");
    expect(statusText({ refreshing: false, lastRefreshAt: null }, NOW)).toBe("Not refreshed yet");
  });
});

describe("amounts", () => {
  it("formats compact USD amounts", () => {
    expect(formatAmount(12_500_000)).toBe("$12.5M");
    expect(formatAmount(1_200_000_000)).toBe("$1.2B");
    expect(formatAmount(12_000_000)).toBe("$12M");
    expect(formatAmount(850_000)).toBe("$850K");
    expect(formatAmount(500)).toBe("$500");
    expect(formatAmount(0)).toBe("$0");
    expect(formatAmount(2_000_000_000_000)).toBe("$2T");
    expect(formatAmount(1_049_999)).toBe("$1M");
    expect(formatAmount(1_050_000)).toBe("$1.1M");
  });

  it("promotes values that round up to the next unit", () => {
    expect(formatAmount(999_960_000)).toBe("$1B");
    expect(formatAmount(999_960)).toBe("$1M");
    expect(formatAmount(999_400)).toBe("$999.4K");
  });

  it("returns a dash for unknown, negative or non-finite amounts", () => {
    expect(formatAmount(null)).toBe("—");
    expect(formatAmount(undefined)).toBe("—");
    expect(formatAmount(-5)).toBe("—");
    expect(formatAmount(Number.NaN)).toBe("—");
    expect(formatAmount(Number.POSITIVE_INFINITY)).toBe("—");
    expect(amountParts(null)).toBeNull();
  });

  it("splits parts for the hero and speaks them in words", () => {
    expect(amountParts(12_500_000)).toEqual({ symbol: "$", value: "12.5", unit: "M" });
    expect(amountParts(42)).toEqual({ symbol: "$", value: "42", unit: "" });
    expect(spokenAmount(12_500_000)).toBe("$12.5 million");
    expect(spokenAmount(3_000_000_000)).toBe("$3 billion");
    expect(spokenAmount(900)).toBe("$900");
    expect(spokenAmount(null)).toBe("Amount not disclosed");
  });

  it("chooses a card headline", () => {
    expect(amountHeadline({ amountUsd: 30_000_000, amountText: "$30 million" })).toEqual({ text: "$30M", disclosed: true });
    expect(amountHeadline({ amountUsd: null, amountText: "€20 million" })).toEqual({ text: "€20 million", disclosed: true });
    expect(amountHeadline({ amountUsd: null, amountText: "  " })).toEqual({ text: "Undisclosed", disclosed: false });
    expect(amountHeadline({ amountUsd: null, amountText: null })).toEqual({ text: "Undisclosed", disclosed: false });
    const long = amountHeadline({ amountUsd: null, amountText: "an undisclosed eight-figure sum" });
    expect(long.text.length).toBeLessThanOrEqual(24);
    expect(long.text.endsWith("…")).toBe(true);
  });

  it("notes the original currency only when it differs from USD", () => {
    expect(originalAmountNote({ amountUsd: 21_600_000, amountText: "€20 million", currency: "EUR" })).toBe("Reported as €20 million");
    expect(originalAmountNote({ amountUsd: 20_000_000, amountText: "$20 million", currency: "USD" })).toBeNull();
    expect(originalAmountNote({ amountUsd: null, amountText: "€20 million", currency: "EUR" })).toBeNull();
    expect(originalAmountNote({ amountUsd: 5, amountText: null, currency: "EUR" })).toBeNull();
  });
});

describe("labels", () => {
  it("humanizes ids in sentence case and keeps acronyms", () => {
    expect(humanize("climate_tech")).toBe("Climate tech");
    expect(humanize("ai-infra")).toBe("AI infra");
    expect(humanize("b2b saas")).toBe("B2B SaaS");
    expect(humanize("FINTECH")).toBe("Fintech");
    expect(humanize("OpenAI")).toBe("OpenAI");
    expect(humanize("")).toBe("");
    expect(humanize(null)).toBe("");
  });

  it("labels domains and sectors, preferring the server's labels", () => {
    expect(domainLabel("ai")).toBe("AI");
    expect(domainLabel("world")).toBe("World");
    expect(domainLabel("space_tech")).toBe("Space tech");
    expect(domainLabel("ai", [{ id: "ai", label: "Artificial intelligence", count: 3 }])).toBe("Artificial intelligence");
    expect(sectorLabel("all")).toBe("All");
    expect(sectorLabel("fintech")).toBe("Fintech");
    expect(sectorLabel("dev_tools", [{ id: "dev_tools", label: "Developer tools", count: 1 }])).toBe("Developer tools");
  });

  it("labels funding rounds", () => {
    expect(roundLabel("series_a")).toBe("Series A");
    expect(roundLabel("Series B")).toBe("Series B");
    expect(roundLabel("series-c")).toBe("Series C");
    expect(roundLabel("series b extension")).toBe("Series B extension");
    expect(roundLabel("pre_seed")).toBe("Pre-seed");
    expect(roundLabel("Pre-Seed")).toBe("Pre-seed");
    expect(roundLabel("pre-series-a")).toBe("Pre-Series A");
    expect(roundLabel("seed")).toBe("Seed");
    expect(roundLabel("growth_equity")).toBe("Growth equity");
    expect(roundLabel(null)).toBe("");
    expect(roundLabel("")).toBe("");
  });

  it("builds a stable chip row with All first", () => {
    const chips = facetChips(
      [
        { id: "ai", label: "AI", count: 4 },
        { id: "health", label: "", count: 2 },
        { id: "all", label: "All", count: 99 },
      ],
      ["all", "ai", "health", "world"],
    );
    expect(chips.map((c) => c.id)).toEqual(["all", "ai", "health", "world"]);
    expect(chips[0]).toEqual({ id: "all", label: "All", count: 6 });
    expect(chips[2]!.label).toBe("Health");
    expect(chips[3]).toEqual({ id: "world", label: "World", count: 0 });
    expect(facetChips(null)).toEqual([{ id: "all", label: "All", count: 0 }]);
  });

  it("pluralizes and lists investors", () => {
    expect(plural(1, "story", "stories")).toBe("1 story");
    expect(plural(1200, "story", "stories")).toBe("1,200 stories");
    expect(investorsLine([])).toBe("");
    expect(investorsLine(null)).toBe("");
    expect(investorsLine(["Sequoia"])).toBe("Sequoia");
    expect(investorsLine(["Sequoia", "Accel"])).toBe("Sequoia and Accel");
    expect(investorsLine(["Sequoia", "Accel", "Index"])).toBe("Sequoia, Accel and 1 other");
    expect(investorsLine(["A", "B", "C", "D", "E"])).toBe("A, B and 3 others");
    expect(investorsLine(["A", " ", "B"], 3)).toBe("A and B");
  });
});

describe("grouping", () => {
  it("labels days", () => {
    expect(dayGroupLabel(at(2026, 10, 25, 1), NOW)).toBe("Today");
    expect(dayGroupLabel(at(2026, 10, 24, 23), NOW)).toBe("Yesterday");
    expect(dayGroupLabel(at(2026, 10, 21), NOW)).toBe("Saturday");
    expect(dayGroupLabel(at(2026, 10, 10), NOW)).toBe("Nov 10");
    expect(dayGroupLabel("bad", NOW)).toBe("Earlier");
  });

  it("groups consecutive items under day headings in order", () => {
    const items = [
      { id: "a", publishedAt: at(2026, 10, 25, 13) },
      { id: "b", publishedAt: at(2026, 10, 25, 8) },
      { id: "c", publishedAt: at(2026, 10, 24, 20) },
      { id: "d", publishedAt: at(2026, 10, 20, 20) },
    ];
    const g = groupByDay(items, NOW);
    expect(g.map((x) => x.label)).toEqual(["Today", "Yesterday", "Friday"]);
    expect(g[0]!.items.map((x) => x.id)).toEqual(["a", "b"]);
    expect(new Set(g.map((x) => x.key)).size).toBe(g.length);
    expect(groupByDay([], NOW)).toEqual([]);
  });
});

describe("monograms", () => {
  it("picks one meaningful letter", () => {
    expect(monogram("TechCrunch")).toBe("T");
    expect(monogram("The Verge")).toBe("V");
    expect(monogram("https://www.reuters.com/x")).toBe("R");
    expect(monogram("  42 Capital")).toBe("4");
    expect(monogram("élan")).toBe("É");
    expect(monogram("— !")).toBe("?");
    expect(monogram("")).toBe("?");
    expect(monogram(null)).toBe("?");
  });

  it("assigns a deterministic tone from the theme tokens", () => {
    const t = monogramTone("TechCrunch");
    expect(MONOGRAM_TONES).toContain(t);
    expect(monogramTone("TechCrunch")).toBe(t);
    expect(monogramTone("  techcrunch ")).toBe(t);
    const used = new Set(["Reuters", "TechCrunch", "The Verge", "BBC", "Wired", "Axios", "Bloomberg", "Nature", "STAT", "Ars Technica"].map(monogramTone));
    expect(used.size).toBeGreaterThan(1);
    expect(MONOGRAM_TONES).toContain(monogramTone(null));
  });
});

describe("URL safety", () => {
  it("allows only absolute http(s) URLs", () => {
    expect(safeHttpUrl("https://techcrunch.com/a?b=1")).toBe("https://techcrunch.com/a?b=1");
    expect(safeHttpUrl("  http://example.com  ")).toBe("http://example.com/");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeHttpUrl(" javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeHttpUrl("vbscript:x")).toBeNull();
    expect(safeHttpUrl("file:///etc/passwd")).toBeNull();
    expect(safeHttpUrl("ftp://example.com")).toBeNull();
    expect(safeHttpUrl("/relative/path")).toBeNull();
    expect(safeHttpUrl("//evil.com/x")).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });

  it("extracts a readable host", () => {
    expect(hostOf("https://www.techcrunch.com/2026/11/25/x")).toBe("techcrunch.com");
    expect(hostOf("https://news.ycombinator.com")).toBe("news.ycombinator.com");
    expect(hostOf("javascript:alert(1)")).toBe("");
  });
});

describe("lists and polling", () => {
  const A = { id: "a", v: 1 };
  const B = { id: "b", v: 1 };
  const C = { id: "c", v: 1 };

  it("appends pages without duplicates", () => {
    expect(mergeUnique([A, B], [B, C]).map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(mergeUnique([], [A, A]).map((x) => x.id)).toEqual(["a"]);
  });

  it("counts unseen items in a polled page", () => {
    expect(countUnseen([C, A, B], [A, B])).toBe(1);
    expect(countUnseen([A, B], [A, B])).toBe(0);
    expect(countUnseen([A], [])).toBe(1);
  });

  it("refreshes shown items in place without reordering", () => {
    const B2 = { id: "b", v: 2 };
    const shown = [A, B];
    const out = refreshInPlace(shown, [C, B2]);
    expect(out.map((x) => x.id)).toEqual(["a", "b"]);
    expect(out[1]).toBe(B2);
    expect(refreshInPlace(shown, [])).toBe(shown);
    expect(refreshInPlace(shown, [A])).toBe(shown);
  });

  it("knows when more pages remain", () => {
    expect(hasMore(30, 31)).toBe(true);
    expect(hasMore(30, 30)).toBe(false);
    expect(hasMore(0, Number.NaN)).toBe(false);
  });

  it("builds query strings, skipping empty values and encoding the rest", () => {
    expect(buildQuery({ domain: "ai", q: "", limit: 30, offset: 0 })).toBe("?domain=ai&limit=30&offset=0");
    expect(buildQuery({ q: "a&b=c d" })).toBe("?q=a%26b%3Dc%20d");
    expect(buildQuery({ q: "  ", x: null, y: undefined, z: Number.NaN })).toBe("");
  });

  it("parses Retry-After in seconds or as a date", () => {
    expect(parseRetryAfter("30")).toBe(30);
    expect(parseRetryAfter("99999")).toBe(3600);
    expect(parseRetryAfter(new Date(NOW + 12_000).toUTCString(), NOW)).toBe(12);
    expect(parseRetryAfter(new Date(NOW - 12_000).toUTCString(), NOW)).toBe(0);
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });

  it("describes errors in plain language", () => {
    expect(describeError(0, "Failed to fetch")).toMatch(/reach the server/);
    expect(describeError(404, "Not found")).toBe("Discover isn't available on this server yet.");
    expect(describeError(404, "Startup not found")).toBe("Startup not found");
    expect(describeError(429, "slow down")).toMatch(/Too many requests/);
    expect(describeError(500, "Internal server error")).toMatch(/ran into a problem/);
    expect(describeError(502, "Upstream feed timed out")).toBe("Upstream feed timed out");
    expect(describeError(400, "")).toBe("Something went wrong.");
  });
});

describe("AI context", () => {
  it("normalizes strings, bullets and arrays into lines", () => {
    expect(textLines("One.\n- Two\n• Three\n1. Four\n\n")).toEqual(["One.", "Two", "Three", "Four"]);
    expect(textLines(["a", "", " b "])).toEqual(["a", "b"]);
    expect(textLines(42)).toEqual([]);
    expect(textLines(undefined)).toEqual([]);
  });

  it("returns the five sections in reading order, skipping empty ones", () => {
    const s = contextSections({ whatTheyDo: "Builds X.", funding: "", investors: ["Sequoia led."], whyItMatters: "Because.", market: "Crowded." });
    expect(s.map((x) => x.title)).toEqual(["What they do", "Investors", "Why it matters", "Market"]);
    expect(s[1]!.lines).toEqual(["Sequoia led."]);
    expect(contextSections(null)).toEqual([]);
  });
});

describe("source health", () => {
  it("summarizes working and failing sources", () => {
    expect(sourceSummary([])).toEqual({ text: "No sources yet", failing: 0, total: 0 });
    expect(sourceSummary([{ name: "a", ok: true }, { name: "b", ok: true }]).text).toBe("2 sources");
    const s = sourceSummary([{ name: "a", ok: true }, { name: "b", ok: false }, { name: "c", ok: true }]);
    expect(s).toEqual({ text: "2 of 3 sources working", failing: 1, total: 3 });
  });

  it("lists failing sources first, then by name", () => {
    const out = sortSources([
      { name: "Wired", ok: true },
      { name: "Axios", ok: true },
      { name: "Zeta", ok: false },
      { name: "Beta", ok: false },
    ]);
    expect(out.map((x) => x.name)).toEqual(["Beta", "Zeta", "Axios", "Wired"]);
  });
});
