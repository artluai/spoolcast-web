-- 006: owned show/season registry and idempotent episode fan-out reservations.
--
-- Fan-out is deliberately two-phase. Pages first reserves every child session
-- in one D1 batch, then the engine creates only that immutable manifest. A
-- stable creation_key lets retries reconcile the same ids after either side
-- fails between those two steps.

CREATE TABLE IF NOT EXISTS engine_shows (
  show_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (show_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_engine_shows_user
ON engine_shows(user_id, created_at);

CREATE TABLE IF NOT EXISTS engine_seasons (
  season_id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL REFERENCES engine_shows(show_id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (show_id, season_id)
);

CREATE INDEX IF NOT EXISTS idx_engine_seasons_show
ON engine_seasons(show_id, created_at);

CREATE TABLE IF NOT EXISTS engine_session_creations (
  user_id INTEGER NOT NULL REFERENCES users(id),
  creation_key TEXT NOT NULL,
  show_id TEXT NOT NULL REFERENCES engine_shows(show_id),
  season_id TEXT NOT NULL REFERENCES engine_seasons(season_id),
  manifest_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  provisioning_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (provisioning_state IN ('pending', 'active', 'released')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, creation_key),
  UNIQUE (user_id, creation_key, show_id, season_id, manifest_hash),
  FOREIGN KEY (show_id, user_id)
    REFERENCES engine_shows(show_id, user_id),
  FOREIGN KEY (show_id, season_id)
    REFERENCES engine_seasons(show_id, season_id)
);

CREATE INDEX IF NOT EXISTS idx_engine_session_creations_owner
ON engine_session_creations(user_id, show_id, season_id, created_at);

CREATE INDEX IF NOT EXISTS idx_engine_session_creations_key
ON engine_session_creations(creation_key);

-- Rebuild instead of ALTER so D1 itself enforces the complete owner, parent,
-- and reservation relationship. Existing single-session rows copy across as
-- active standalone sessions.
ALTER TABLE engine_sessions RENAME TO engine_sessions_legacy;

CREATE TABLE engine_sessions (
  session_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  show_id TEXT,
  season_id TEXT,
  provisioning_state TEXT NOT NULL DEFAULT 'active'
    CHECK (provisioning_state IN ('pending', 'active')),
  creation_key TEXT,
  episode_number INTEGER,
  manifest_hash TEXT,
  FOREIGN KEY (show_id, user_id)
    REFERENCES engine_shows(show_id, user_id),
  FOREIGN KEY (show_id, season_id)
    REFERENCES engine_seasons(show_id, season_id),
  FOREIGN KEY (user_id, creation_key, show_id, season_id, manifest_hash)
    REFERENCES engine_session_creations(
      user_id, creation_key, show_id, season_id, manifest_hash
    )
);

INSERT INTO engine_sessions (session_id, user_id, created_at)
SELECT session_id, user_id, created_at
  FROM engine_sessions_legacy;

DROP TABLE engine_sessions_legacy;

CREATE INDEX IF NOT EXISTS idx_engine_sessions_user
ON engine_sessions(user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_engine_sessions_creation
ON engine_sessions(creation_key, provisioning_state);

CREATE INDEX IF NOT EXISTS idx_engine_sessions_show_season
ON engine_sessions(show_id, season_id, episode_number);
