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
  max_clicks    INTEGER CHECK (max_clicks > 0), -- v4: NULL = unlimited, 1 = one-time
  used_clicks   INTEGER NOT NULL DEFAULT 0,     -- v4: visits that have consumed the limit
  expires_at    TIMESTAMPTZ,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Existing databases: safe to re-run
ALTER TABLE links ADD COLUMN IF NOT EXISTS max_clicks  INTEGER CHECK (max_clicks > 0);
ALTER TABLE links ADD COLUMN IF NOT EXISTS used_clicks INTEGER NOT NULL DEFAULT 0;

-- v4 replaced one_time/used_at with max_clicks/used_clicks. Carry existing one-time links
-- over (a used one keeps its "used" state), then drop the old columns. Runs only once.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'links' AND column_name = 'one_time') THEN
    UPDATE links
       SET max_clicks  = 1,
           used_clicks = CASE WHEN used_at IS NOT NULL THEN 1 ELSE 0 END
     WHERE one_time;
    ALTER TABLE links DROP COLUMN one_time;
    ALTER TABLE links DROP COLUMN used_at;
  END IF;
END $$;

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
  ip_hash     TEXT,
  source      TEXT                    -- v4: how the visit was tagged, e.g. 'qr' (NULL = untagged)
);
ALTER TABLE clicks ADD COLUMN IF NOT EXISTS source TEXT;
CREATE INDEX IF NOT EXISTS idx_clicks_link_time ON clicks(link_id, clicked_at);
