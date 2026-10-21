-- Run once:  psql "$DATABASE_URL" -f db/schema.sql

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS links (
  id                BIGSERIAL PRIMARY KEY,
  user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug              TEXT NOT NULL,              -- v6: unique per domain (see the indexes below)
  target_url        TEXT NOT NULL,
  password_hash     TEXT,                       -- v3: protected links
  max_clicks        INTEGER CHECK (max_clicks > 0), -- v4: NULL = unlimited, 1 = one-time
  used_clicks       INTEGER NOT NULL DEFAULT 0,     -- v4: visits that have consumed the limit
  webhook_url       TEXT,
  notification_email TEXT,
  notify_on_clicks  INTEGER[] NOT NULL DEFAULT '{}',
  expires_at        TIMESTAMPTZ,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Existing databases: safe to re-run
ALTER TABLE links ADD COLUMN IF NOT EXISTS max_clicks  INTEGER CHECK (max_clicks > 0);
ALTER TABLE links ADD COLUMN IF NOT EXISTS used_clicks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE links ADD COLUMN IF NOT EXISTS webhook_url TEXT;
ALTER TABLE links ADD COLUMN IF NOT EXISTS notification_email TEXT;
ALTER TABLE links ADD COLUMN IF NOT EXISTS notify_on_clicks INTEGER[] NOT NULL DEFAULT '{}';

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

-- v5: organise many links. A link has at most one folder (flat, per user) and any number of tags.
CREATE TABLE IF NOT EXISTS folders (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Folder names are unique per user, ignoring case ("Launch" and "launch" are the same folder)
CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_user_name ON folders(user_id, lower(name));

-- Deleting a folder keeps its links; they just become unfiled
ALTER TABLE links ADD COLUMN IF NOT EXISTS folder_id BIGINT REFERENCES folders(id) ON DELETE SET NULL;
ALTER TABLE links ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_links_folder ON links(user_id, folder_id);
CREATE INDEX IF NOT EXISTS idx_links_tags ON links USING GIN (tags);

-- v6: custom domains. A user adds a host (go.example.com), proves they control it with a DNS TXT
-- record, and then links can live on it. Only verified domains serve anything.
CREATE TABLE IF NOT EXISTS domains (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host               TEXT NOT NULL CHECK (host = lower(host) AND char_length(host) <= 253),
  verification_token TEXT NOT NULL,
  verified_at        TIMESTAMPTZ,                -- NULL = not verified, serves nothing
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_domains_user_host ON domains(user_id, host);
-- Several users may claim a host, but only the first to prove control can verify it
CREATE UNIQUE INDEX IF NOT EXISTS idx_domains_verified_host ON domains(host) WHERE verified_at IS NOT NULL;

-- domain_id NULL = the service's own domain (BASE_URL). Deleting a domain deletes its links.
ALTER TABLE links ADD COLUMN IF NOT EXISTS domain_id BIGINT REFERENCES domains(id) ON DELETE CASCADE;
-- A slug is unique per domain, so two users can both have /sale on their own domains.
-- The new indexes come first so slugs are never unprotected; then the old global constraint goes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_links_slug_default ON links(slug) WHERE domain_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_links_slug_domain ON links(domain_id, slug) WHERE domain_id IS NOT NULL;
ALTER TABLE links DROP CONSTRAINT IF EXISTS links_slug_key;

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

-- v7: device/country routing. A list of rules [{ "device": "ios"|"android"|null, "country": "DE"|null,
-- "url": "..." }]; the first rule that matches a visitor replaces target_url for that visit.
-- Deploy this together with the server: the redirect now selects this column.
ALTER TABLE links ADD COLUMN IF NOT EXISTS routes JSONB NOT NULL DEFAULT '[]'::jsonb;

-- v8: auth. Sessions make logins revocable; auth_tokens carry one-time email-verification and
-- password-reset links. Only SHA-256 hashes of refresh/email tokens are stored.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;  -- NULL = not verified yet

-- One row per login. The access token (a short-lived JWT) carries this id as `sid` and is only
-- accepted while the row is live. The refresh token is rotated on every use; the previous one is
-- remembered so that replaying it (a stolen token) revokes the whole session.
CREATE TABLE IF NOT EXISTS sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash      TEXT NOT NULL,
  prev_refresh_hash TEXT,
  rotated_at        TIMESTAMPTZ,
  user_agent        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  revoked_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_refresh ON sessions(refresh_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_prev ON sessions(prev_refresh_hash) WHERE prev_refresh_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('verify_email', 'reset_password')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id, kind);

-- v9: shared rate limiting. One row per limiter key (e.g. "register|203.0.113.7"), so every server
-- instance sees the same counts. Windows are fixed; expired rows are overwritten on the next hit and
-- purged periodically. UNLOGGED: losing the counters in a crash only resets the limits, and skipping
-- the WAL makes the per-request writes cheaper.
CREATE UNLOGGED TABLE IF NOT EXISTS rate_limits (
  key      TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_reset ON rate_limits(reset_at);
