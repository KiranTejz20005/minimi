/**
 * Discover tab: shared types. The API shapes (NewsItem, Startup, StartupContext, FeedStatus) are a contract with the
 * frontend (web/) — change them only together with the UI.
 */

export const NEWS_DOMAINS = [
  { id: "ai", label: "AI" },
  { id: "startups", label: "Startups" },
  { id: "technology", label: "Technology" },
  { id: "business", label: "Business" },
  { id: "science", label: "Science" },
  { id: "health", label: "Health" },
  { id: "world", label: "World" },
] as const;
export type NewsDomain = (typeof NEWS_DOMAINS)[number]["id"];
export const NEWS_DOMAIN_IDS: readonly string[] = NEWS_DOMAINS.map((d) => d.id);

export const SECTORS = [
  { id: "ai", label: "AI" },
  { id: "fintech", label: "Fintech" },
  { id: "health", label: "Health" },
  { id: "climate", label: "Climate" },
  { id: "saas", label: "SaaS" },
  { id: "ecommerce", label: "E-commerce" },
  { id: "mobility", label: "Mobility" },
  { id: "cybersecurity", label: "Cybersecurity" },
  { id: "hardware", label: "Hardware" },
  { id: "other", label: "Other" },
] as const;
export type Sector = (typeof SECTORS)[number]["id"];
export const SECTOR_IDS: readonly string[] = SECTORS.map((s) => s.id);

export type FeedKind = "news" | "funding";

/** One RSS/Atom source. Hosts are constants in feeds.ts, never user input. */
export type FeedDef = {
  name: string;
  url: string;
  kind: FeedKind;
  domain: NewsDomain;
};

/** One entry parsed out of a feed (all text already plain, capped and untrusted). */
export type ParsedItem = {
  title: string;
  url: string;
  summary: string;
  imageUrl: string | null;
  /** ISO-8601; the fetch time when the feed's date was missing or invalid. */
  publishedAt: string;
};

export type NewsItem = {
  id: string;
  title: string;
  url: string;
  source: string;
  domain: string;
  summary: string;
  imageUrl: string | null;
  publishedAt: string;
  fetchedAt: string;
};

export type StartupContext = {
  whatTheyDo: string;
  funding: string;
  investors: string;
  whyItMatters: string;
  market: string;
  caveats: string;
  generatedAt: string;
  /** Model that wrote it; null = deterministic summary built without an LLM. */
  model: string | null;
};

export type Startup = {
  id: string;
  company: string;
  amountUsd: number | null;
  amountText: string | null;
  currency: string | null;
  round: string | null;
  sector: string;
  summary: string;
  investors: string[];
  location: string | null;
  publishedAt: string;
  source: string;
  url: string;
  context: StartupContext | null;
};

/** Deterministic output of extract-funding.ts for one headline. */
export type FundingExtraction = {
  company: string;
  amountUsd: number | null;
  amountText: string | null;
  currency: string | null;
  round: string | null;
  investors: string[];
  location: string | null;
  sector: Sector;
};

export type FeedStatus = {
  name: string;
  kind: FeedKind;
  ok: boolean;
  items: number;
  ms: number;
  error?: string;
};
