-- Up Migration
-- Abuse reports from the public, plus admin takedown state.
-- links.disabled_at is separate from is_active: is_active is the owner's pause switch, disabled_at is a
-- takedown only an admin can lift. The same for users.disabled_at (a suspended account).

ALTER TABLE users ADD COLUMN is_admin        BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN disabled_at     TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN disabled_reason TEXT;

ALTER TABLE links ADD COLUMN disabled_at     TIMESTAMPTZ;
ALTER TABLE links ADD COLUMN disabled_reason TEXT;

CREATE TABLE abuse_reports (
  id              BIGSERIAL PRIMARY KEY,
  -- Kept (link NULL) if the owner deletes the link, so the report history survives
  link_id         BIGINT REFERENCES links(id) ON DELETE SET NULL,
  -- What was reported, as it was when reported: still readable after the link is edited or deleted
  slug            TEXT NOT NULL,
  domain_host     TEXT,
  target_url      TEXT NOT NULL,
  reason          TEXT NOT NULL CHECK (reason IN ('phishing', 'malware', 'spam', 'illegal', 'copyright', 'other')),
  details         TEXT CHECK (char_length(details) <= 2000),
  reporter_email  TEXT CHECK (char_length(reporter_email) <= 254),
  reporter_ip_hash TEXT,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  resolved_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     TIMESTAMPTZ,
  resolution_note TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_abuse_reports_status ON abuse_reports(status, created_at DESC);
CREATE INDEX idx_abuse_reports_link ON abuse_reports(link_id);

-- Audit trail of admin actions (who took what down, and why)
CREATE TABLE admin_actions (
  id          BIGSERIAL PRIMARY KEY,
  admin_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,           -- disable_link, enable_link, disable_user, enable_user, dismiss_report
  target_type TEXT NOT NULL,           -- link, user, report
  target_id   BIGINT NOT NULL,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_admin_actions_target ON admin_actions(target_type, target_id);

-- Same stance as every other table (see the baseline): Supabase's REST API must see nothing
ALTER TABLE abuse_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_actions ENABLE ROW LEVEL SECURITY;

-- Down Migration
DROP TABLE admin_actions;
DROP TABLE abuse_reports;
ALTER TABLE links DROP COLUMN disabled_reason;
ALTER TABLE links DROP COLUMN disabled_at;
ALTER TABLE users DROP COLUMN disabled_reason;
ALTER TABLE users DROP COLUMN disabled_at;
ALTER TABLE users DROP COLUMN is_admin;
