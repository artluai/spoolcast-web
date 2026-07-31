-- 004: operator-only product settings.
-- The render location is intentionally a single global admin choice for now:
-- local preserves the existing Mac flow; cloud routes only final rendering to
-- the authenticated render-worker service.

CREATE TABLE IF NOT EXISTS admin_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO admin_settings (key, value)
VALUES ('render_location', 'local');
