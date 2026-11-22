-- Media Lockout · node 00 · D1 schema
-- Apply once:  npx wrangler d1 execute medialockout --remote --file worker/schema.sql

-- One row per verified human. `n` is the public designation (#00042).
CREATE TABLE IF NOT EXISTS humans (
  n           INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT    NOT NULL UNIQUE,   -- sha-256 of the key kept on the human's device
  issued_at   INTEGER NOT NULL,          -- ms since epoch
  last_seen   INTEGER NOT NULL,          -- ms since epoch, drives "humans online"
  mode        TEXT    NOT NULL,          -- 'line' or 'rhythm' (tremor check used)
  tremor      REAL    NOT NULL,          -- deviation, percent
  silence_ms  INTEGER NOT NULL,
  resets      INTEGER NOT NULL,          -- times the silence check was broken
  sig         TEXT    NOT NULL,          -- JSON array, 48 samples in [-1, 1]
  reignitions INTEGER NOT NULL DEFAULT 0,
  ip_hash     TEXT    NOT NULL,          -- salted hash, rate limiting only
  signal      INTEGER NOT NULL DEFAULT 0 -- points earned in the lineup
);
CREATE INDEX IF NOT EXISTS humans_last_seen ON humans (last_seen);
CREATE INDEX IF NOT EXISTS humans_ip ON humans (ip_hash, issued_at);

-- Human transmissions. Set hidden = 1 to take one out of the feed.
CREATE TABLE IF NOT EXISTS transmissions (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  human_n  INTEGER NOT NULL,
  text     TEXT    NOT NULL,
  at       INTEGER NOT NULL,
  hidden   INTEGER NOT NULL DEFAULT 0,
  reignited INTEGER NOT NULL DEFAULT 0   -- 1 if this transmission ended a day of silence
);
CREATE INDEX IF NOT EXISTS tx_feed ON transmissions (hidden, at);
CREATE INDEX IF NOT EXISTS tx_human ON transmissions (human_n, at);

-- One-use verification challenges. They time the ritual server-side.
CREATE TABLE IF NOT EXISTS challenges (
  id         TEXT    PRIMARY KEY,
  created_at INTEGER NOT NULL,
  ip_hash    TEXT    NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ch_ip ON challenges (ip_hash, created_at);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- The agent census: one row per kind of automated visitor, and a short rolling log.
CREATE TABLE IF NOT EXISTS agents (
  name       TEXT    PRIMARY KEY,
  kind       TEXT    NOT NULL,
  hits       INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  last_path  TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS agents_last_seen ON agents (last_seen);
CREATE INDEX IF NOT EXISTS agents_hits ON agents (hits);

CREATE TABLE IF NOT EXISTS agent_log (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT    NOT NULL,
  kind TEXT    NOT NULL,
  path TEXT    NOT NULL,
  at   INTEGER NOT NULL
);

-- Moderation: one row per human per reported transmission.
-- transmissions.hidden: 0 visible, 1 hidden by the owner, 2 hidden by reports until reviewed.
CREATE TABLE IF NOT EXISTS reports (
  tx_id   INTEGER NOT NULL,
  human_n INTEGER NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (tx_id, human_n)
);
CREATE INDEX IF NOT EXISTS reports_human ON reports (human_n, at);
CREATE INDEX IF NOT EXISTS humans_issued ON humans (issued_at);

-- The lineup: one question a day, answered by counted humans and by the resident agents,
-- judged the next day. Exactly one of human_n / agent is set.
CREATE TABLE IF NOT EXISTS lineup_answers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  day         TEXT    NOT NULL,            -- UTC date the question belongs to, YYYY-MM-DD
  human_n     INTEGER,
  agent       TEXT,
  text        TEXT    NOT NULL,
  at          INTEGER NOT NULL,
  human_votes INTEGER NOT NULL DEFAULT 0,  -- times it was called human
  agent_votes INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS lineup_one_human ON lineup_answers (day, human_n) WHERE human_n IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS lineup_one_agent ON lineup_answers (day, agent) WHERE agent IS NOT NULL;

CREATE TABLE IF NOT EXISTS lineup_judgements (
  day     TEXT    NOT NULL,
  human_n INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  total   INTEGER NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (day, human_n)
);
CREATE INDEX IF NOT EXISTS humans_signal ON humans (signal);

-- The network: other sites that keep count. A counted human opens a node for a site; it is listed
-- once this Worker has found the node's line on the site itself.
CREATE TABLE IF NOT EXISTS nodes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  host        TEXT    NOT NULL UNIQUE,   -- example.com: no scheme, no www
  key         TEXT    NOT NULL UNIQUE,   -- carried in the node's line; public
  human_n     INTEGER NOT NULL,          -- the counted human who opened it
  created_at  INTEGER NOT NULL,
  checked_at  INTEGER,                   -- last time the site was looked at
  verified_at INTEGER,                   -- set once the line was found on the site
  last_seen   INTEGER                    -- last request counted at the node
);
CREATE INDEX IF NOT EXISTS nodes_human ON nodes (human_n);
CREATE INDEX IF NOT EXISTS nodes_verified ON nodes (verified_at);

-- What was counted at each node, per day. name is '' for a browser, otherwise the name the machine announced.
-- No address is kept.
CREATE TABLE IF NOT EXISTS node_hits (
  node_id INTEGER NOT NULL,
  day     TEXT    NOT NULL,              -- UTC date, YYYY-MM-DD
  name    TEXT    NOT NULL,
  kind    TEXT    NOT NULL,
  hits    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (node_id, day, name)
);
