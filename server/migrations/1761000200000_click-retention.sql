-- Up Migration
-- Click retention. Raw rows in `clicks` are kept for CLICK_RETENTION_DAYS (see services/clickRetention.js);
-- older ones are folded into this table, one row per link per UTC day, and then deleted. That keeps the
-- lifetime click total and the per-day history of every link while the raw table stops growing.
-- Referrer, device and country breakdowns are only kept for the raw window (the dashboard shows at most 90 days).
CREATE TABLE click_rollups (
  link_id BIGINT  NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  day     DATE    NOT NULL,
  clicks  INTEGER NOT NULL CHECK (clicks > 0),
  PRIMARY KEY (link_id, day)
);
ALTER TABLE click_rollups ENABLE ROW LEVEL SECURITY; -- same stance as every table: Supabase's REST API sees nothing

-- The retention job finds old rows by time alone, which idx_clicks_link_time (link_id first) cannot serve.
-- BRIN: a few kilobytes even for hundreds of millions of rows, ideal because clicks arrive in time order.
CREATE INDEX idx_clicks_time_brin ON clicks USING BRIN (clicked_at);

-- Down Migration
DROP INDEX idx_clicks_time_brin;
-- Rolled-up history is lost on the way down (the raw rows it came from are already gone)
DROP TABLE click_rollups;
