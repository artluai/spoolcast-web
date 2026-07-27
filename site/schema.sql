-- Viewer-site schema (D1: spoolcast-site).
-- Display layer only: creators, series, videos with a public flag.
-- The money layer (users, credits, unlocks) comes later as separate tables.

CREATE TABLE IF NOT EXISTS creators (
  id INTEGER PRIMARY KEY,
  handle TEXT UNIQUE NOT NULL,          -- /u/<handle>
  name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS series (
  id INTEGER PRIMARY KEY,
  creator_id INTEGER NOT NULL REFERENCES creators(id),
  slug TEXT UNIQUE NOT NULL,            -- /watch/s/<slug>
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cover_url TEXT NOT NULL DEFAULT '',
  public INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY,
  creator_id INTEGER NOT NULL REFERENCES creators(id),
  series_id INTEGER REFERENCES series(id),
  episode INTEGER,                      -- ordering inside a series
  slug TEXT UNIQUE NOT NULL,            -- /watch/v/<slug>
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  r2_key TEXT NOT NULL,                 -- object key in spoolcast-videos
  poster_key TEXT NOT NULL DEFAULT '',  -- optional poster image key
  duration_s REAL,
  width INTEGER,
  height INTEGER,
  public INTEGER NOT NULL DEFAULT 0,
  published_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_videos_series ON videos(series_id, episode);
CREATE INDEX IF NOT EXISTS idx_videos_public ON videos(public, published_at);
