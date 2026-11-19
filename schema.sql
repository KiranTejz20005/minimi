PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL DEFAULT 'local',
  title       TEXT,
  created_at  TEXT NOT NULL,            -- UTC ISO-8601
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

-- One user question + the assistant's final answer. The unit of recall.
CREATE TABLE IF NOT EXISTS turns (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL DEFAULT 'local',
  conversation_id      TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_message_id      TEXT NOT NULL REFERENCES messages(id),
  assistant_message_id TEXT REFERENCES messages(id),
  created_at           TEXT NOT NULL,   -- UTC
  tz                   TEXT NOT NULL,   -- IANA zone of the user at the time
  local_date           TEXT NOT NULL,   -- YYYY-MM-DD in tz; computed once at write time
  local_time           TEXT NOT NULL,   -- HH:MM in tz
  topic                TEXT,            -- from digest
  entities             TEXT,            -- JSON array, from digest
  digest_status        TEXT NOT NULL DEFAULT 'pending'
                       CHECK (digest_status IN ('pending','done','failed','skipped')),
  status               TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error','aborted')),
  is_demo              INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_turns_date ON turns(user_id, local_date);

-- Time-sensitive, checkable facts stated in an answer.
CREATE TABLE IF NOT EXISTS claims (
  id          TEXT PRIMARY KEY,
  turn_id     TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  subject     TEXT NOT NULL,
  attribute   TEXT NOT NULL,
  value       TEXT NOT NULL,
  as_of       TEXT NOT NULL,            -- local date of the turn
  source_url  TEXT,
  volatility  TEXT NOT NULL DEFAULT 'high'
);
CREATE INDEX IF NOT EXISTS idx_claims_turn ON claims(turn_id);

-- Search results actually cited or returned in a turn.
CREATE TABLE IF NOT EXISTS sources (
  id           TEXT PRIMARY KEY,
  turn_id      TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  n            INTEGER NOT NULL,        -- citation number within the turn
  url          TEXT NOT NULL,
  title        TEXT,
  published_at TEXT,
  retrieved_at TEXT NOT NULL,
  cited        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sources_turn ON sources(turn_id);

CREATE TABLE IF NOT EXISTS search_cache (
  key         TEXT PRIMARY KEY,         -- hash(query, start_date, domains, topic)
  response    TEXT NOT NULL,            -- JSON
  created_at  TEXT NOT NULL
);

-- One row per pipeline stage per turn.
CREATE TABLE IF NOT EXISTS traces (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id  TEXT NOT NULL,
  stage    TEXT NOT NULL,               -- temporal | retrieve | llm_step | search | citations | digest
  started_ms INTEGER NOT NULL,          -- ms since turn start
  duration_ms INTEGER NOT NULL,
  detail   TEXT                         -- JSON
);
CREATE INDEX IF NOT EXISTS idx_traces_turn ON traces(turn_id);

-- ── UI features: projects, pinning, attachments, settings ──────────────────
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_meta (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  pinned          INTEGER NOT NULL DEFAULT 0,
  project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL
);

-- Text files attached by the user. conversation_id is NULL until the first turn is sent.
CREATE TABLE IF NOT EXISTS attachments (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  mime            TEXT,
  size            INTEGER NOT NULL,
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_conv ON attachments(conversation_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Older answers kept when the user regenerates a response (newest lives in messages.content).
CREATE TABLE IF NOT EXISTS message_versions (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  content    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_msg ON message_versions(message_id, idx);

-- Thumbs up/down (+ reason) per turn.
CREATE TABLE IF NOT EXISTS feedback (
  turn_id    TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('up','down')),
  reason     TEXT,
  created_at TEXT NOT NULL
);
