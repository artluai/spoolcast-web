-- 003: global templates — admin-published cloud assets, the character-library
-- pattern applied to templates: files in the spoolcast-assets R2 bucket
-- (templates/<slug>/…), one metadata row here. Published through
-- POST /api/admin/templates/publish (admin role, the first admin-gated write);
-- the public roster is GET /api/site/templates. The engine keeps reading
-- template FILES locally per docs/architecture-engine-vs-site.md — this table
-- is the site side's ownership/visibility record, never an engine dependency.

CREATE TABLE IF NOT EXISTS global_templates (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,            -- template id ("ad", "explainer")
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT '',      -- e.g. video-first
  contract TEXT NOT NULL DEFAULT '',    -- engine contract id
  version INTEGER NOT NULL DEFAULT 1,   -- bumped on every republish
  r2_prefix TEXT NOT NULL,              -- templates/<slug>
  files TEXT NOT NULL DEFAULT '[]',     -- JSON list of R2 keys under the prefix
  poster_key TEXT NOT NULL DEFAULT '',  -- picker art (replaces TEMPLATE_ART later)
  preview_key TEXT NOT NULL DEFAULT '',
  live INTEGER NOT NULL DEFAULT 1,      -- 0 = unpublished (kept, not listed)
  published_by INTEGER REFERENCES users(id),
  published_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed the existing operator account. Future databases don't need this row:
-- sign-in promotes any address listed in the ADMIN_EMAILS env var.
UPDATE users SET role = 'admin' WHERE email = 'bitbrandsagency@gmail.com';
