import type { FeedDef } from "./types.js";

/**
 * The one editable list of Discover sources. Every URL was checked with a real HTTP GET (200 + valid RSS/Atom) on
 * 2026-11-25. Hosts are constants: nothing here comes from user input. All fetches go through safeFetch (SSRF-safe).
 *
 * kind "funding": items also go through the funding extractor and appear in the news list under "startups".
 * Dead/blocked when checked (do not re-add without re-testing): entrackr.com/feed (404, use /rss), finsmes.com/feed (403),
 * venturebeat.com/feed (429), feeds.arstechnica.com/arstechnica/ai (404).
 */
export const FEEDS: readonly FeedDef[] = [
  // ── World / business / science / health ──
  { name: "BBC World", url: "https://feeds.bbci.co.uk/news/world/rss.xml", kind: "news", domain: "world" },
  { name: "The Guardian World", url: "https://www.theguardian.com/world/rss", kind: "news", domain: "world" },
  { name: "BBC Business", url: "https://feeds.bbci.co.uk/news/business/rss.xml", kind: "news", domain: "business" },
  { name: "BBC Science", url: "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml", kind: "news", domain: "science" },
  { name: "Ars Technica Science", url: "https://feeds.arstechnica.com/arstechnica/science", kind: "news", domain: "science" },
  { name: "ScienceDaily", url: "https://www.sciencedaily.com/rss/top/science.xml", kind: "news", domain: "science" },
  { name: "BBC Health", url: "https://feeds.bbci.co.uk/news/health/rss.xml", kind: "news", domain: "health" },
  { name: "ScienceDaily Health", url: "https://www.sciencedaily.com/rss/top/health.xml", kind: "news", domain: "health" },

  // ── Technology / AI ──
  { name: "BBC Technology", url: "https://feeds.bbci.co.uk/news/technology/rss.xml", kind: "news", domain: "technology" },
  { name: "TechCrunch", url: "https://techcrunch.com/feed/", kind: "news", domain: "technology" },
  { name: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index", kind: "news", domain: "technology" },
  { name: "The Verge", url: "https://www.theverge.com/rss/index.xml", kind: "news", domain: "technology" },
  { name: "TechCrunch AI", url: "https://techcrunch.com/category/artificial-intelligence/feed/", kind: "news", domain: "ai" },
  { name: "The Verge AI", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", kind: "news", domain: "ai" },
  { name: "MIT Technology Review AI", url: "https://www.technologyreview.com/topic/artificial-intelligence/feed", kind: "news", domain: "ai" },

  // ── Startups & funding ──
  { name: "TechCrunch Startups", url: "https://techcrunch.com/category/startups/feed/", kind: "funding", domain: "startups" },
  { name: "TechCrunch Venture", url: "https://techcrunch.com/category/venture/feed/", kind: "funding", domain: "startups" },
  { name: "Crunchbase News", url: "https://news.crunchbase.com/feed/", kind: "funding", domain: "startups" },
  { name: "Tech Funding News", url: "https://techfundingnews.com/feed/", kind: "funding", domain: "startups" },
  { name: "EU-Startups", url: "https://www.eu-startups.com/feed/", kind: "funding", domain: "startups" },
  { name: "Tech.eu", url: "https://tech.eu/feed", kind: "funding", domain: "startups" },
  { name: "Inc42", url: "https://inc42.com/feed/", kind: "funding", domain: "startups" },
  { name: "Entrackr", url: "https://entrackr.com/rss", kind: "funding", domain: "startups" },
  { name: "YourStory", url: "https://yourstory.com/feed", kind: "funding", domain: "startups" },
];

/** Domains whose items are also scanned for funding headlines (besides kind "funding" feeds). */
export const FUNDING_SCAN_DOMAINS: readonly string[] = ["ai", "technology", "startups"];
