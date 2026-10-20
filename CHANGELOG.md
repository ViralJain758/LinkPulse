# Changelog

## Unreleased

- **QR scan tracking:** the dashboard's QR codes now encode `/slug?s=qr`, and those visits show up as "QR code" in Sources. QR codes downloaded before this change keep working but count as direct visits.
- **Edit links in the dashboard:** change the destination, expiry and click limit from the Links page.
- **Click limits:** one-time links are generalised to "expire after N clicks" (`maxClicks`, `1` = one-time).
- **Schema:** `links.one_time`/`used_at` are replaced by `max_clicks`/`used_clicks` (existing one-time links are migrated), and `clicks` gains `source`. Re-run `server/db/schema.sql`.
- **API:** links return `maxClicks` and `usedClicks` instead of `oneTime` and `usedAt`; `oneTime` is still accepted on input. `PATCH` accepts `maxClicks` and `resetClicks`.
