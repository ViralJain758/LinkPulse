# LinkPulse server

Express API and redirect service. See the [root README](../README.md) for the overall project, [docs/API.md](../docs/API.md) for endpoints and [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) for internals.

## Run

```bash
npm install
cp .env.example .env                    # set JWT_SECRET and DATABASE_URL (Supabase pooler string)
# apply db/schema.sql once: paste it into the Supabase SQL Editor, or run
# psql "$DATABASE_URL" -f db/schema.sql  # idempotent; re-run after upgrades
npm run dev                             # watch mode, port 4000
npm start                               # production
npm test                                # unit tests (node:test, no database needed)
```

Requires Node 20.6+ (uses `--env-file`). Configuration is documented in [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md).

For a separate Vercel server deployment, set the Vercel project **Root Directory** to `server`.
The server project uses `server/vercel.json`; do not use the repository-root Vercel config.

## Layout

| Path | Role |
|---|---|
| `src/index.js` | App wiring, error handler, graceful shutdown (flushes buffered clicks) |
| `src/routes/auth.js` | Register / login |
| `src/routes/links.js` | Link CRUD (passwords, click limits, expiry, tags, folder, routing rules), list filters, `POST /bulk` CSV import |
| `src/routes/folders.js` | Folder CRUD |
| `src/routes/tags.js` | Tag list with counts |
| `src/routes/domains.js` | Custom domains: add, verify (DNS TXT), remove, and the public `allowed` check for on-demand TLS |
| `src/routes/stats.js` | Analytics queries |
| `src/routes/redirect.js` | Public `GET/POST /:slug`, password and click-limit handling, QR source tag (must stay last) |
| `src/services/` | `slug`, `slugCache`, `validateUrl`, `linkFields` (shared validation), `routing` (device/country rules: validation and matching), `csv`, `bulkImport`, `domainDns` (host validation, TXT/CNAME checks), `domainLookup` (Host → domain, cached), `clickParser`, `clickLogger`, `referrerLabels`, `rateLimit` |
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
- Country is read from CDN headers when available (Cloudflare, Vercel, CloudFront). The bundled offline lookup is used as a fallback; if a serverless deployment omits its data file, the server still starts and country remains Unknown unless a CDN header is present.
- Device routing reads the User-Agent: iPadOS 13+ Safari reports a Mac, so those iPads are not sent to an `ios` rule. Bots get the main destination.

- Bulk import creates links one at a time and keeps going past bad rows; it is capped at 500 rows and 1 MB per request. Rows with passwords are slower (bcrypt).
- Folders and tags do not affect redirects, so they take effect immediately everywhere.
- Custom domains: the redirect picks the link namespace from the `Host` header, so the proxy must preserve it. Try it locally with `curl -H 'Host: go.example.com' localhost:4000/<slug>` once a domain with that host is verified in the database. Verification does real DNS lookups, so it only succeeds for a domain you control.

## Known limits

- Bots are detected by a user-agent regex, not a maintained list
- The slug cache is per process: with several instances, an edit or delete reaches the others only after `SLUG_CACHE_TTL_SECONDS` (60 by default)
- Rate limits are fixed windows kept in Postgres: a burst across a window boundary can briefly reach twice the limit
- Hourly buckets in a DST-change zone can merge or skip one hour on the transition day
