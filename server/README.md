# LinkPulse server

Express API and redirect service. See the [root README](../README.md) for the overall project, [docs/API.md](../docs/API.md) for endpoints and [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) for internals.

## Run

```bash
npm install
cp .env.example .env                    # set JWT_SECRET and DATABASE_URL
psql "$DATABASE_URL" -f db/schema.sql   # idempotent; re-run after upgrades
npm run dev                             # watch mode, port 4000
npm start                               # production
```

Requires Node 20.6+ (uses `--env-file`). Configuration is documented in [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md).

## Layout

| Path | Role |
|---|---|
| `src/index.js` | App wiring, error handler, graceful shutdown (flushes buffered clicks) |
| `src/routes/auth.js` | Register / login |
| `src/routes/links.js` | Link CRUD (passwords, one-time, expiry) |
| `src/routes/stats.js` | Analytics queries |
| `src/routes/redirect.js` | Public `GET/POST /:slug`, password and one-time handling (must stay last) |
| `src/services/` | `slug`, `validateUrl`, `clickParser`, `clickLogger`, `referrerLabels`, `rateLimit` |
| `db/schema.sql` | Schema |

## Quick manual test

```bash
UA="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1"
curl -i -A "$UA" -H "Referer: https://t.co/x" localhost:4000/<slug>
curl "localhost:4000/api/stats/overview?range=7d" -H "Authorization: Bearer <TOKEN>"
```

## Behaviour notes

- Bots and link-preview fetchers (WhatsApp, Telegram, Slack, curl...) and `HEAD` requests are not counted and never consume one-time links.
- Clicks are batched every second; a hard crash can lose about a second of clicks.
- Country needs a CDN header (Cloudflare, Vercel, CloudFront); otherwise it is empty.

## Known limits

- Bots are detected by a user-agent regex, not a maintained list
- The redirect queries Postgres on every request (an in-memory slug cache is a possible next step)
- The password rate limiter is per process
- Hourly buckets in a DST-change zone can merge or skip one hour on the transition day
