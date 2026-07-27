-- 002: the user system. Accounts, roles, login, and the payment-shaped ledger.
-- Roles: 'admin' may publish GLOBAL assets/templates (everyone sees them);
-- 'user' owns only their own profile, assets, and videos.
-- Money is NOT built yet — the ledger just makes sure it can be, without a
-- schema rework: every future credit purchase/spend/earn is one row here.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  handle TEXT UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One-time magic-link tokens (15 min, single use).
CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Browser sessions (HttpOnly cookie holds the token).
CREATE TABLE IF NOT EXISTS web_sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Credit ledger: the only money table there will ever need to be.
-- kind: purchase | spend_unlock | earn_sale | payout | adjust
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  delta INTEGER NOT NULL,               -- credits, signed
  kind TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',         -- what it points at (video slug, stripe id…)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, created_at);

-- A creator page can now belong to an account.
ALTER TABLE creators ADD COLUMN user_id INTEGER REFERENCES users(id);
