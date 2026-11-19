import type { DatabaseSync } from "node:sqlite";
import { ensureConversation, insertTurnAt, saveClaims } from "../src/memory/store.js";

const tz = "Asia/Kolkata";

export type FixtureIds = Record<string, string>;

export function loadEvalFixtures(
  db: DatabaseSync,
  opts?: { omitClaims?: boolean },
): FixtureIds {
  const skipClaims = opts?.omitClaims === true;
  const ids: FixtureIds = {};

  const f1conv = "fixture_f1";
  ensureConversation(db, f1conv, "CRM shortlist", "2026-11-09T04:30:00.000Z");
  ids.F1 = insertTurnAt(db, {
    conversationId: f1conv,
    localDate: "2026-11-09",
    localTime: "10:00",
    tz,
    title: "CRM shortlist",
    topic: "CRM shortlist for 20-person sales team",
    entities: ["HubSpot", "Pipedrive", "Zoho", "Freshsales", "Close"],
    userContent:
      "Shortlist 5 CRM tools for a 20-person sales team with monthly pricing.",
    assistantContent:
      "HubSpot Sales Hub Pro $90/seat, Pipedrive $49, Zoho $52, Freshsales $69, Close $99 per seat (annual billing).",
  }).id;
  if (!skipClaims)
    saveClaims(db, ids.F1, [
    {
      subject: "HubSpot Sales Hub Professional",
      attribute: "price/seat/month",
      value: "$90",
      as_of: "2026-11-09",
      source_url: "https://www.hubspot.com/pricing/sales",
      volatility: "high",
    },
    {
      subject: "Pipedrive",
      attribute: "price/seat/month",
      value: "$49",
      as_of: "2026-11-09",
      source_url: "https://www.pipedrive.com/en/pricing",
      volatility: "high",
    },
    ]);

  ids.F2 = insertTurnAt(db, {
    conversationId: f1conv,
    localDate: "2026-11-09",
    localTime: "16:00",
    tz,
    topic: "regex",
    userContent: "How do I match emails with regex?",
    assistantContent: "Use a pattern like [a-z]+@[a-z]+\\.[a-z]+ for a simple match.",
  }).id;

  const f3conv = "fixture_f3";
  ensureConversation(db, f3conv, "Laptop", "2026-11-04T05:00:00.000Z");
  ids.F3 = insertTurnAt(db, {
    conversationId: f3conv,
    localDate: "2026-11-04",
    localTime: "11:00",
    tz,
    topic: "laptop video editing budget",
    userContent: "Best laptop for video editing under a budget?",
    assistantContent: "MacBook Air M3, ASUS ProArt, Lenovo Slim 7 — all under $1500.",
  }).id;

  const f4conv = "fixture_f4";
  ensureConversation(db, f4conv, "Postgres hosting", "2026-11-03T04:00:00.000Z");
  ids.F4 = insertTurnAt(db, {
    conversationId: f4conv,
    localDate: "2026-11-03",
    localTime: "11:00",
    tz,
    topic: "Postgres hosting",
    entities: ["Neon", "Supabase", "RDS", "Crunchy"],
    userContent: "Compare Postgres hosting prices for a small app.",
    assistantContent: "Neon ~$19/mo, Supabase Pro $25, RDS ~$52, Crunchy $25.",
  }).id;
  if (!skipClaims)
    saveClaims(db, ids.F4, [
      {
        subject: "Neon",
        attribute: "price/month",
        value: "$19",
        as_of: "2026-11-03",
        source_url: "https://neon.tech/pricing",
        volatility: "high",
      },
    ]);

  ids.F5 = insertTurnAt(db, {
    conversationId: f4conv,
    localDate: "2026-11-03",
    localTime: "15:00",
    tz,
    topic: "connection pooling concept",
    userContent: "What is connection pooling?",
    assistantContent: "Connection pooling reuses open DB connections instead of opening new ones per query.",
  }).id;

  const f6conv = "fixture_f6";
  ensureConversation(db, f6conv, "Framework version", "2026-11-02T04:00:00.000Z");
  ids.F6 = insertTurnAt(db, {
    conversationId: f6conv,
    localDate: "2026-11-02",
    localTime: "09:00",
    tz,
    topic: "framework stable version",
    userContent: "What is the latest stable version of the framework?",
    assistantContent: "The current stable release is v5.2.1 as of November 2026.",
  }).id;
  if (!skipClaims)
    saveClaims(db, ids.F6, [
      {
        subject: "framework",
        attribute: "stable version",
        value: "v5.2.1",
        as_of: "2026-11-02",
        source_url: null,
        volatility: "medium",
      },
    ]);

  const f7conv = "fixture_f7";
  ensureConversation(db, f7conv, "Vector DB", "2026-10-27T04:00:00.000Z");
  ids.F7 = insertTurnAt(db, {
    conversationId: f7conv,
    localDate: "2026-10-27",
    localTime: "14:00",
    tz,
    topic: "vector database comparison",
    entities: ["Pinecone", "Weaviate", "Milvus"],
    userContent: "Compare vector databases for our RAG stack.",
    assistantContent: "Pinecone managed, Weaviate hybrid search, Milvus OSS at scale.",
  }).id;

  const f8conv = "fixture_f8";
  ensureConversation(db, f8conv, "Baggage", "2026-10-09T04:00:00.000Z");
  ids.F8 = insertTurnAt(db, {
    conversationId: f8conv,
    localDate: "2026-10-09",
    localTime: "08:00",
    tz,
    topic: "flight baggage rules",
    userContent: "What are the carry-on baggage rules?",
    assistantContent: "One cabin bag up to 7kg and one personal item on most carriers.",
  }).id;

  return ids;
}
