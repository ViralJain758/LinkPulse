# LinkPulse server

Express API and redirect service. See the [root README](../README.md) for the overall project, [docs/API.md](../docs/API.md) for endpoints and [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) for internals.

## Run

```bash
npm install
cp .env.example .env                    # set JWT_SECRET and DATABASE_URL
psql "$DATABASE_URL" -f db/schema.sql   # idempotent; re-run after upgrades
npm run dev                             # watch mode, port 4000
npm start                               # production
npm test                                # unit tests (node:test, no database needed)
```

Requires Node 20.6+ (uses `--env-file`). Configuration is documented in [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md).

## Layout

| Path | Role |
|---|---|
| `src/index.js` | App wiring, error handler, graceful shutdown (flushes buffered clicks) |
| `src/routes/auth.js` | Register / login |
| `src/routes/links.js` | Link CRUD (passwords, click limits, expiry) |
| `src/routes/stats.js` | Analytics queries |
| `src/routes/redirect.js` | Public `GET/POST /:slug`, password and click-limit handling, QR source tag (must stay last) |
| `src/services/` | `slug`, `slugCache`, `validateUrl`, `clickParser`, `clickLogger`, `referrerLabels`, `rateLimit` |
| `test/` | Unit tests, run with `npm test` |
| `db/schema.sql` | Schema |

## Quick manual test

```bash
UA="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1"
curl -i -A "$UA" -H "Referer: https://t.co/x" localhost:4000/<slug>
curl "localhost:4000/api/stats/overview?range=7d" -H "Authorization: Bearer <TOKEN>"
```

## Behaviour notes

- Bots and link-preview fetchers (WhatsApp, Telegram, Slack, curl...) and `HEAD` requests are not counted and never use up a click-limited link's visits.
- Clicks are batched every second; a hard crash can lose about a second of clicks.
- The redirect caches link lookups in memory (`SLUG_CACHE_TTL_SECONDS`, default 60; `0` turns it off). Editing or deleting a link through the API takes effect immediately on that server. Changes made any other way, such as SQL run by hand, show up after the TTL or a restart. Click-limited links and unknown slugs are never cached. Details in [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md#slug-cache).
- Country needs a CDN header (Cloudflare, Vercel, CloudFront); otherwise it is empty.

## Known limits

- Bots are detected by a user-agent regex, not a maintained list
- The slug cache is per process: with several instances, an edit or delete reaches the others only after `SLUG_CACHE_TTL_SECONDS` (60 by default)
- The password rate limiter is per process
- Hourly buckets in a DST-change zone can merge or skip one hour on the transition day
