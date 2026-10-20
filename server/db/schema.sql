-- Run once:  psql "$DATABASE_URL" -f db/schema.sql

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS links (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug          TEXT NOT NULL UNIQUE,
  target_url    TEXT NOT NULL,
  password_hash TEXT,                       -- v3: protected links
  one_time      BOOLEAN NOT NULL DEFAULT false, -- v3: one-time links
  used_at       TIMESTAMPTZ,                    -- v3: set when a one-time link is consumed
  expires_at    TIMESTAMPTZ,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Existing databases created before v3: safe to re-run
ALTER TABLE links ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_links_user ON links(user_id, created_at DESC);

-- Created now, used from v2 (click logging)
CREATE TABLE IF NOT EXISTS clicks (
  id          BIGSERIAL PRIMARY KEY,
  link_id     BIGINT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  clicked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  referrer    TEXT,
  device_type TEXT,
  browser     TEXT,
  os          TEXT,
  country     TEXT,
  ip_hash     TEXT
);
CREATE INDEX IF NOT EXISTS idx_clicks_link_time ON clicks(link_id, clicked_at);
