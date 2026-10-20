# Changelog

## Unreleased

- **Slug cache:** the redirect keeps recently used links in a small in-memory cache instead of querying Postgres on every visit. `PATCH` and `DELETE` clear the entry immediately; entries also expire after `SLUG_CACHE_TTL_SECONDS` (default 60, `0` disables) and the cache holds at most `SLUG_CACHE_MAX` links (default 1,000). Click-limited links and unknown slugs are never cached. With multiple instances, edits reach the other instances after the TTL.
- **QR scan tracking:** the dashboard's QR codes now encode `/slug?s=qr`, and those visits show up as "QR code" in Sources. QR codes downloaded before this change keep working but count as direct visits.
- **Edit links in the dashboard:** change the destination, expiry and click limit from the Links page.
- **Click limits:** one-time links are generalised to "expire after N clicks" (`maxClicks`, `1` = one-time).
- **Schema:** `links.one_time`/`used_at` are replaced by `max_clicks`/`used_clicks` (existing one-time links are migrated), and `clicks` gains `source`. Re-run `server/db/schema.sql`.
- **API:** links return `maxClicks` and `usedClicks` instead of `oneTime` and `usedAt`; `oneTime` is still accepted on input. `PATCH` accepts `maxClicks` and `resetClicks`.
- **Tests:** `npm test` in `server/` runs unit tests for the slug cache (also run in CI).
