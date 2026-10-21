-- Run after `npm run migrate`:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f test/sql/auth_smoke.sql
-- Exercises the session and one-time-token statements used by services/sessions.js and
-- services/authTokens.js. Any failed assertion raises an exception and fails the run.
BEGIN;

DO $$
DECLARE
  uid BIGINT; sid UUID; n INT;
BEGIN
  INSERT INTO users (email, password_hash) VALUES ('smoke@example.com', 'x') RETURNING id INTO uid;
  INSERT INTO sessions (user_id, refresh_hash, expires_at)
    VALUES (uid, 'h1', now() + make_interval(days => 30)) RETURNING id INTO sid;

  -- rotation: the first use of h1 succeeds, a second use finds nothing to rotate
  UPDATE sessions SET prev_refresh_hash = refresh_hash, refresh_hash = 'h2', rotated_at = now(),
         expires_at = now() + make_interval(days => 30)
   WHERE refresh_hash = 'h1' AND revoked_at IS NULL AND expires_at > now();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'first rotation should match 1 row, got %', n; END IF;

  UPDATE sessions SET refresh_hash = 'h3' WHERE refresh_hash = 'h1' AND revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'replayed token must not rotate, matched %', n; END IF;

  -- the replayed token is recognised as the previous one
  SELECT count(*) INTO n FROM sessions WHERE prev_refresh_hash = 'h1' AND rotated_at IS NOT NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'previous token not found'; END IF;

  -- requireAuth lookup: live, then revoked
  SELECT count(*) INTO n FROM sessions s JOIN users u ON u.id = s.user_id
   WHERE s.id = sid AND s.user_id = uid AND s.revoked_at IS NULL AND s.expires_at > now();
  IF n <> 1 THEN RAISE EXCEPTION 'live session not found'; END IF;

  UPDATE sessions SET revoked_at = now()
   WHERE user_id = uid AND revoked_at IS NULL AND (NULL::uuid IS NULL OR id <> NULL::uuid);
  SELECT count(*) INTO n FROM sessions WHERE id = sid AND revoked_at IS NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'revoked session still live'; END IF;

  -- one-time tokens: single use, kind enforced, expiry enforced
  INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at)
    VALUES (uid, 'reset_password', 't1', now() + interval '1 hour'),
           (uid, 'reset_password', 't2', now() - interval '1 minute');
  UPDATE auth_tokens SET used_at = now()
   WHERE token_hash = 't1' AND kind = 'reset_password' AND used_at IS NULL AND expires_at > now();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'token should be spendable once'; END IF;
  UPDATE auth_tokens SET used_at = now()
   WHERE token_hash = 't1' AND kind = 'reset_password' AND used_at IS NULL AND expires_at > now();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'token spent twice'; END IF;
  UPDATE auth_tokens SET used_at = now()
   WHERE token_hash = 't2' AND kind = 'reset_password' AND used_at IS NULL AND expires_at > now();
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'expired token accepted'; END IF;
END $$;

ROLLBACK;
