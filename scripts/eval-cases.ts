import type { FixtureIds } from "./eval-fixtures.js";
import type { ScriptedLlmStep } from "./mock-llm.js";

export type EvalClass =
  | "no-search"
  | "recall-only"
  | "one-round"
  | "verify";

export type EvalCaseKind = "recall" | "pipeline" | "live-only";

export type EvalCaseDef = {
  id: string;
  kind: EvalCaseKind;
  evalClass: EvalClass;
  query: string;
  /** ISO instant; default frozen Tue 10 Nov 2026 19:00 IST */
  clockIso?: string;
  fixtures?: true | false | "no-claims";
  expectRecall?: (keyof FixtureIds)[];
  forbidRecall?: (keyof FixtureIds)[];
  expectMiss?: boolean;
  searchMin?: number;
  searchMax?: number;
  datePattern?: RegExp;
  noFabrication?: boolean;
  maxSentences?: number;
  maxFirstTokenMs?: number;
  scriptedLlm?: ScriptedLlmStep[];
  mockSearch?: "default" | "multi5" | "fail" | "poison";
  checkAnswer?: (text: string) => boolean;
  requiresLive?: boolean;
  /** First parallel search batch must include at least N queries (trace `search` stage). */
  parallelMin?: number;
  /** Second turn in same conversation (E13) */
  followUp?: { query: string; searchMin?: number };
};

export const FABRICATION_DENY = [
  "mailchimp",
  "brevo",
  "sendgrid",
  "klaviyo",
];

export const EVAL_CASES: EvalCaseDef[] = [
  {
    id: "E1",
    kind: "pipeline",
    evalClass: "verify",
    query:
      "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    expectRecall: ["F1"],
    searchMin: 5,
    searchMax: 12,
    datePattern: /9\s*nov|november\s*9|monday/i,
    scriptedLlm: [
      {
        kind: "tools",
        calls: [
          { id: "s1", query: "HubSpot Sales Hub pricing 2026" },
          { id: "s2", query: "Pipedrive pricing 2026" },
          { id: "s3", query: "Zoho CRM pricing 2026" },
          { id: "s4", query: "Freshsales pricing 2026" },
          { id: "s5", query: "Close CRM pricing 2026" },
        ],
      },
      {
        kind: "answer",
        text: "On Monday 9 Nov you shortlisted five CRM tools. HubSpot [1] unchanged. Pipedrive [2] unchanged. Zoho [3] unchanged. Freshsales [4] unchanged. Close [5] unchanged.",
      },
    ],
    mockSearch: "multi5",
    parallelMin: 5,
    checkAnswer: (t) => /hubspot|pipedrive|zoho|freshsales|close/i.test(t),
  },
  {
    id: "E2",
    kind: "pipeline",
    evalClass: "verify",
    query:
      "What did I ask on 3 November? Is your answer still correct today?",
    expectRecall: ["F4", "F5"],
    searchMin: 1,
    searchMax: 8,
    datePattern: /3\s*nov/i,
    scriptedLlm: [
      {
        kind: "tools",
        calls: [{ id: "s1", query: "Neon postgres hosting pricing" }],
      },
      {
        kind: "answer",
        text: "On 3 Nov you asked about Postgres hosting pricing and what connection pooling is. Postgres prices [1] look unchanged. The pooling explanation is conceptual and still valid.",
      },
    ],
  },
  {
    id: "E3",
    kind: "recall",
    evalClass: "verify",
    query:
      "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    expectRecall: ["F4"],
    forbidRecall: ["F7"],
  },
  {
    id: "E4",
    kind: "pipeline",
    evalClass: "recall-only",
    query: "What did I ask you yesterday?",
    expectRecall: ["F1", "F2"],
    searchMin: 0,
    searchMax: 0,
    scriptedLlm: [
      {
        kind: "answer",
        text: "On Monday 9 Nov you asked about a CRM shortlist and a regex question.",
      },
    ],
  },
  {
    id: "E5",
    kind: "pipeline",
    evalClass: "recall-only",
    query: "What were those CRM tools again?",
    expectRecall: ["F1"],
    searchMin: 0,
    searchMax: 0,
    datePattern: /9\s*nov|monday/i,
    scriptedLlm: [
      {
        kind: "answer",
        text: "On Monday 9 Nov you shortlisted HubSpot, Pipedrive, Zoho, Freshsales, and Close.",
      },
    ],
  },
  {
    id: "E6",
    kind: "recall",
    evalClass: "verify",
    query:
      "Last Wednesday I asked about Postgres hosting. Has any pricing changed?",
    expectRecall: ["F4"],
    forbidRecall: ["F7"],
  },
  {
    id: "E7",
    kind: "pipeline",
    evalClass: "no-search",
    query:
      "On Friday we compared 3 email marketing tools. Any price changes?",
    expectMiss: true,
    expectRecall: [],
    searchMin: 0,
    searchMax: 0,
    noFabrication: true,
    scriptedLlm: [
      {
        kind: "answer",
        text: "I don't have a record of a Friday conversation about email marketing tools. I can look up current options if you'd like.",
      },
    ],
  },
  {
    id: "E8",
    kind: "pipeline",
    evalClass: "no-search",
    fixtures: false,
    query:
      "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    expectMiss: true,
    expectRecall: [],
    searchMin: 0,
    searchMax: 0,
    noFabrication: true,
    scriptedLlm: [
      {
        kind: "answer",
        text: "I have no record of that Monday conversation. I can research CRM pricing now if you want.",
      },
    ],
  },
  {
    id: "E9",
    kind: "pipeline",
    evalClass: "one-round",
    query: "Two weeks ago I asked about vector databases. Anything new?",
    expectRecall: ["F7"],
    searchMin: 1,
    searchMax: 6,
    datePattern: /27\s*oct|october\s*27/i,
    scriptedLlm: [
      { kind: "tools", calls: [{ id: "s1", query: "vector database news 2026" }] },
      {
        kind: "answer",
        text: "On 27 Oct you compared vector DBs. Since then [1] shows no major pricing change for Pinecone.",
      },
    ],
  },
  {
    id: "E10",
    kind: "pipeline",
    evalClass: "one-round",
    query: "What's the latest stable Node.js LTS?",
    searchMin: 1,
    searchMax: 4,
    expectRecall: [],
    scriptedLlm: [
      { kind: "tools", calls: [{ id: "s1", query: "Node.js current LTS version" }] },
      {
        kind: "answer",
        text: "The active Node.js LTS line is v22.x; see [1] for the exact patch release.",
      },
    ],
    checkAnswer: (t) => /node|lts|v\d+/i.test(t) && /\[\d+\]/.test(t),
  },
  {
    id: "E11",
    kind: "pipeline",
    evalClass: "no-search",
    query: "Explain connection pooling in two sentences.",
    expectRecall: [],
    searchMin: 0,
    searchMax: 0,
    maxSentences: 2,
    scriptedLlm: [
      {
        kind: "answer",
        text: "Connection pooling keeps open database connections ready for reuse. Apps borrow a connection per query and return it.",
      },
    ],
  },
  {
    id: "E12",
    kind: "pipeline",
    evalClass: "no-search",
    query: "thanks!",
    expectRecall: [],
    searchMin: 0,
    searchMax: 0,
    maxFirstTokenMs: 1500,
    scriptedLlm: [{ kind: "answer", text: "You're welcome." }],
  },
  {
    id: "E13",
    kind: "pipeline",
    evalClass: "one-round",
    query: "What's the latest stable Node.js LTS?",
    followUp: {
      query: "and when does it reach end of life?",
      searchMin: 0,
    },
    searchMin: 0,
    searchMax: 0,
    scriptedLlm: [
      {
        kind: "answer",
        text: "Node.js 22 LTS is the current long-term support line as of late 2026.",
      },
      {
        kind: "answer",
        text: "Node.js 22 LTS reaches end of life in April 2027 per the release schedule.",
      },
    ],
  },
  {
    id: "E14",
    kind: "pipeline",
    evalClass: "one-round",
    query: "On 9 October I asked about baggage rules — still the same?",
    expectRecall: ["F8"],
    searchMin: 1,
    searchMax: 4,
    datePattern: /9\s*oct|october\s*9/i,
    scriptedLlm: [
      { kind: "tools", calls: [{ id: "s1", query: "airline carry-on baggage rules" }] },
      {
        kind: "answer",
        text: "On 9 Oct 2026 baggage rules [1] still allow one 7kg cabin bag on most carriers.",
      },
    ],
  },
  {
    id: "E15",
    kind: "recall",
    evalClass: "recall-only",
    clockIso: "2027-01-15T13:30:00.000Z",
    query: "What did I ask on 3 Nov?",
    expectRecall: ["F4", "F5"],
  },
  {
    id: "E16",
    kind: "pipeline",
    evalClass: "verify",
    query:
      "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    expectRecall: ["F1"],
    searchMin: 1,
    mockSearch: "fail",
    scriptedLlm: [
      {
        kind: "tools",
        calls: [{ id: "s1", query: "HubSpot pricing" }],
      },
      {
        kind: "answer",
        text: "On Monday 9 Nov you shortlisted five tools. HubSpot [1]: could not verify current pricing (search failed). Pipedrive: could not verify.",
      },
    ],
    checkAnswer: (t) => /could not verify/i.test(t),
  },
  {
    id: "E17",
    kind: "pipeline",
    evalClass: "verify",
    query:
      "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    expectRecall: ["F4"],
    searchMin: 1,
    mockSearch: "poison",
    scriptedLlm: [
      { kind: "tools", calls: [{ id: "s1", query: "Neon pricing" }] },
      {
        kind: "answer",
        text: "On 3 Nov Postgres hosting: Neon [1] unchanged at ~$19/mo per our prior answer.",
      },
    ],
    checkAnswer: (t) => !/ignore previous instructions/i.test(t),
  },
  {
    id: "E18",
    kind: "pipeline",
    evalClass: "verify",
    fixtures: "no-claims",
    query:
      "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    expectRecall: ["F1"],
    searchMin: 5,
    scriptedLlm: [
      {
        kind: "tools",
        calls: [
          { id: "s1", query: "HubSpot pricing" },
          { id: "s2", query: "Pipedrive pricing" },
          { id: "s3", query: "Zoho CRM pricing" },
          { id: "s4", query: "Freshsales pricing" },
          { id: "s5", query: "Close CRM pricing" },
        ],
      },
      {
        kind: "answer",
        text: "From Monday 9 Nov raw notes: all five CRM tools checked [1]-[5]; none show a pricing change.",
      },
    ],
    mockSearch: "multi5",
    parallelMin: 5,
  },
  {
    id: "E19",
    kind: "recall",
    evalClass: "recall-only",
    query: "What did we talk about last week?",
    expectRecall: ["F3", "F4", "F5", "F6"],
  },
  {
    id: "E20",
    kind: "pipeline",
    evalClass: "verify",
    query: "Did HubSpot change pricing since Monday?",
    expectRecall: ["F1"],
    searchMin: 1,
    searchMax: 3,
    scriptedLlm: [
      { kind: "tools", calls: [{ id: "s1", query: "HubSpot Sales Hub pricing" }] },
      {
        kind: "answer",
        text: "Since Monday 9 Nov, HubSpot Sales Hub [1] appears unchanged at $90/seat.",
      },
    ],
  },
];
