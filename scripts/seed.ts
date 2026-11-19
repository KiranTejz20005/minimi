import "dotenv/config";
import { DateTime } from "luxon";
import { getClock, setClock, clockFromEnv } from "../src/clock.js";
import { getConfig } from "../src/config.js";
import { getDb } from "../src/db.js";
import { insertTurnAt } from "../src/memory/store.js";
import { loadEvalFixtures } from "./eval-fixtures.js";

const useFixtures = process.argv.includes("--fixtures");

setClock(clockFromEnv());
const cfg = getConfig();
const db = getDb();
const tz = cfg.DEFAULT_TZ;

if (useFixtures) {
  const ids = loadEvalFixtures(db);
  console.log("Seed complete: eval fixtures F1–F8", Object.keys(ids).join(", "));
  process.exit(0);
}

const now = DateTime.fromJSDate(getClock().now(), { zone: tz });

function lastMonday() {
  let d = now.startOf("day");
  while (d.weekday !== 1) d = d.minus({ days: 1 });
  return d;
}

function lastTuesday() {
  let d = now.startOf("day").minus({ days: 1 });
  while (d.weekday !== 2) d = d.minus({ days: 1 });
  return d;
}

const mon = lastMonday();
const tue = lastTuesday();

insertTurnAt(db, {
  conversationId: "demo-crm",
  userContent:
    "Shortlist 5 CRM tools for a 20-person sales team and compare pricing.",
  assistantContent: `[demo] On ${mon.toFormat("d LLL")} I suggested HubSpot ($90/seat), Pipedrive ($49), Freshsales ($69), Zoho ($52), and Close ($99). [1]`,
  localDate: mon.toISODate()!,
  localTime: "10:30",
  tz,
  title: "[demo] CRM shortlist",
  topic: "CRM shortlist for 20-person sales team",
  entities: ["HubSpot", "Pipedrive", "Freshsales", "Zoho", "Close"],
  isDemo: true,
  claims: [
    { subject: "HubSpot Sales Hub Professional", attribute: "price/seat/month", value: "$90", as_of: mon.toISODate()!, source_url: "https://www.hubspot.com/pricing/sales", volatility: "high" },
    { subject: "Pipedrive", attribute: "price/seat/month", value: "$49", as_of: mon.toISODate()!, source_url: "https://www.pipedrive.com/en/pricing", volatility: "high" },
  ],
});

insertTurnAt(db, {
  conversationId: "demo-pg",
  userContent: "Compare Postgres hosting: Neon, Supabase, RDS, Crunchy for a small app.",
  assistantContent: `[demo] Postgres hosting (Tue ${tue.toFormat("d LLL")}): Neon ~$19, Supabase Pro $25, RDS ~$15, Crunchy $25.`,
  localDate: tue.toISODate()!,
  localTime: "14:00",
  tz,
  title: "[demo] Postgres hosting",
  topic: "Postgres hosting comparison",
  entities: ["Neon", "Supabase", "RDS", "Crunchy"],
  isDemo: true,
});

console.log("Seed complete:", mon.toISODate(), tue.toISODate());
