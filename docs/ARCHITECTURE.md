# Architecture

```
Browser ──► React dashboard (Vite) ──/api──► Express ──► PostgreSQL
Visitor ──► GET /:slug ───────────────────► Express ──► PostgreSQL (links)
                                               └─► in-memory click buffer ─► batch INSERT (clicks)
```

One Express process serves the JSON API under `/api`, a health check, and the public redirect on `/:slug`. The redirect router is registered **last** because it matches any single path segment; reserved slugs (`api`, `login`, `health`, ...) cannot be claimed.

## Data model (`server/db/schema.sql`)

- `users(id, email, password_hash)`
- `links(id, user_id, slug UNIQUE, target_url, password_hash, max_clicks, used_clicks, expires_at, is_active, created_at)`
- `clicks(id, link_id, clicked_at, referrer, device_type, browser, os, country, ip_hash, source)` indexed on `(link_id, clicked_at)`

Deleting a user or link cascades to their links/clicks.

## Redirect flow

1. Look up the slug. Missing/paused → 404; expired → 410; click limit reached → 410.
2. Password link: show a form. Nothing is consumed or logged until the right password arrives by `POST`.
3. Click-limited link (`max_clicks` set; 1 = one-time): claim a visit with
   `UPDATE links SET used_clicks = used_clicks + 1 WHERE id=$1 AND max_clicks IS NOT NULL AND used_clicks < max_clicks AND is_active AND (expires_at IS NULL OR expires_at > now())`.
   Concurrent requests serialize on the row lock and each re-checks `used_clicks < max_clicks`, so exactly `max_clicks - used_clicks` of them see `rowCount = 1`; the rest get 410. `HEAD` requests and bot user agents never claim a visit, so chat apps that unfurl a pasted link don't use it up. Unlimited links skip this write entirely.
4. Respond with `302` (`303` after the password POST). Never `301`: cached redirects would bypass expiry, pausing, one-time use and analytics.
5. After responding, push the click into the in-memory buffer.

## Click logging

`clickLogger` buffers clicks and flushes every second (or at 500 rows) with one multi-row `INSERT`. If a batch fails (for example a link deleted mid-flight violates the foreign key), rows are retried individually so one bad row cannot drop the batch. The buffer is capped at 10,000 rows, and is flushed on `SIGTERM`/`SIGINT`. Trade-off: a hard crash can lose about a second of clicks.

Each click records the referrer **hostname** only, a `source` tag (`qr` when the URL was `/slug?s=qr`, the only value accepted; it is what QR codes encode, and the password form carries it through), parsed user agent (device/browser/OS), country from a CDN header when present, and `HMAC-SHA256(ip, IP_HASH_SECRET)` truncated to 32 hex chars for unique-visitor counts.

## Stats

`computeStats` runs seven queries in parallel for a given scope (one link, or all of a user's links). Bucket boundaries are computed in the viewer's time zone and converted back to `timestamptz` so the clicks index is used. `generate_series` zero-fills empty buckets. Sources are computed from `(referrer, source)` pairs: `source = 'qr'` becomes "QR code", otherwise the referrer host is mapped to a friendly name. `range` values are interpolated into SQL only from a fixed whitelist.

## Password brute-force limiter

`services/rateLimit.js`: a `Map` keyed by `ip|slug`, 5 failures per 15 minutes, capped at 50,000 keys. Per-process memory; replace with Redis/Postgres when running multiple instances.

## Client

Vite + React, no router: `App.jsx` switches between Overview, Links and Link detail. `api.js` wraps `fetch` with the stored JWT and signs the user out on any 401. `useFetch` loads data, refetches on dependency changes and polls every 30 seconds. QR codes are generated client-side (`qrcode` package).

## Design decisions worth knowing

- JWT in `localStorage`: simple, but exposed to XSS. Consider httpOnly cookies if you add untrusted content to the dashboard.
- Server-rendered HTML for gate/error pages so they work without the dashboard and from any device.
- No ORM: plain SQL through `pg`.
