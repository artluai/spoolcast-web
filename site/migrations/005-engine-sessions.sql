-- 005: signed-in ownership for private engine projects.
--
-- The browser talks to the hosted engine only through the Pages proxy. This
-- table is the authorization boundary between a web account and a private
-- engine session; the shared Railway bearer token stays server-side.

CREATE TABLE IF NOT EXISTS engine_sessions (
  session_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_engine_sessions_user
ON engine_sessions(user_id, created_at);

-- These are the two active projects mirrored to the hosted engine. Ralph
-- assigned all existing videos/projects to the normal-user test account.
INSERT OR IGNORE INTO engine_sessions (session_id, user_id)
SELECT 'spoolcast-dev-log-12', id FROM users WHERE email = 'contenttest732@gmail.com';

INSERT OR IGNORE INTO engine_sessions (session_id, user_id)
SELECT 'asyllum-mary-jane-01', id FROM users WHERE email = 'contenttest732@gmail.com';
