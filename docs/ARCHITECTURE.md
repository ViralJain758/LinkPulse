# Architecture

```
Browser ──► React dashboard (Vite) ──/api──► Express ──► PostgreSQL
Visitor ──► GET /:slug ───────────────────► Express ──► slug cache ──miss──► PostgreSQL (links)
                                               └─► in-memory click buffer ─► batch INSERT (clicks)
```

One Express process serves the JSON API under `/api`, a health check, and the public redirect on `/:slug`. The redirect router is registered **last** because it matches any single path segment; reserved slugs (`api`, `login`, `health`, ...) cannot be claimed.

## Data model (`server/db/schema.sql`)

- `users(id, email, password_hash)`
- `links(id, user_id, slug UNIQUE, target_url, password_hash, max_clicks, used_clicks, expires_at, is_active, folder_id, tags TEXT[], created_at)`
- `folders(id, user_id, name, created_at)` with a unique index on `(user_id, lower(name))`
- `domains(id, user_id, host, verification_token, verified_at, created_at)`; `links.domain_id` (NULL = default domain). Slugs are unique per domain through two partial unique indexes: `(slug) WHERE domain_id IS NULL` and `(domain_id, slug) WHERE domain_id IS NOT NULL`. `host` is unique per user, and unique overall among **verified** domains, so several users can claim a host but only the first to prove control keeps it
- `clicks(id, link_id, clicked_at, referrer, device_type, browser, os, country, ip_hash, source)` indexed on `(link_id, clicked_at)`

Deleting a user or link cascades to their links/clicks. Deleting a folder sets `links.folder_id` to `NULL` (the links stay). `links.tags` is a Postgres array with a GIN index, so a tag filter is `tags @> ARRAY[...]`; there is no separate tags table, so a tag exists exactly as long as some link has it.

## Redirect flow

0. Work out the namespace from the request's `Host` (`req.hostname`): the service's own host, or any host that is not a verified custom domain, is the default domain (`domain_id` NULL); a verified custom domain selects that domain's links. This lookup is cached in memory for the same TTL as the slug cache, including "not a custom domain" answers (`services/domainLookup.js`).
1. Look up the slug in that namespace (in-memory cache first, then Postgres). Missing/paused → 404; expired → 410; click limit reached → 410.
2. Password link: show a form. Nothing is consumed or logged until the right password arrives by `POST`.
3. Click-limited link (`max_clicks` set; 1 = one-time): claim a visit with
   `UPDATE links SET used_clicks = used_clicks + 1 WHERE id=$1 AND max_clicks IS NOT NULL AND used_clicks < max_clicks AND is_active AND (expires_at IS NULL OR expires_at > now())`.
   Concurrent requests serialize on the row lock and each re-checks `used_clicks < max_clicks`, so exactly `max_clicks - used_clicks` of them see `rowCount = 1`; the rest get 410. `HEAD` requests and bot user agents never claim a visit, so chat apps that unfurl a pasted link don't use it up. Unlimited links skip this write entirely.
4. Respond with `302` (`303` after the password POST). Never `301`: cached redirects would bypass expiry, pausing, one-time use and analytics.
5. After responding, push the click into the in-memory buffer.

## Slug cache

`services/slugCache.js` keeps recent link rows in a bounded LRU `Map` (default 1,000 entries, 60 s TTL; `SLUG_CACHE_TTL_SECONDS=0` turns it off).

- Keys are `domainId:slug` (`slugKey()`), because a slug is only unique within a domain. Cached rows therefore never leak between domains.
- Only **unlimited** links are cached. A click-limited link changes on every visit (`used_clicks`), so it always reads Postgres.
- Unknown slugs are never cached, so a new link works immediately and slug scans can't fill the cache.
- `PATCH` and `DELETE` call `invalidate(slugKey(domain_id, slug))`. A global epoch counter makes a lookup that started before an invalidation drop its result instead of caching a pre-edit row.
- `expires_at` and `is_active` are checked on every request against the cached row, so expiry still takes effect on time.
- It is per process, like the password limiter. With several instances, only the one that handled the `PATCH`/`DELETE` is cleared; the others serve the old row until the TTL ends. Lower the TTL, or disable the cache, if that delay is not acceptable.
- Only the API invalidates it. A link changed by hand in SQL, or removed by deleting its user (which cascades to their links), is picked up after the TTL or a restart.
- The cached row includes the link's password hash, held in the server's memory like any other row it reads.

When you add code that changes a link's slug, destination, active state, expiry, password or limit, call `invalidate(slugKey(link.domain_id, link.slug))` after the write. Verifying or removing a domain clears this process's host cache, and removing one also clears the whole slug cache. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## Custom domains

Ownership is proven with DNS, not by trusting the request: `POST /api/domains` stores a random token, and `POST /api/domains/:id/verify` looks for a TXT record `_linkpulse.<host>` equal to `linkpulse-verify=<token>` (`services/domainDns.js`, resolver injectable for tests). Only after that does `verified_at` get set and the host start serving links. Verification is a one-time check; nothing re-checks DNS later.

LinkPulse does not terminate TLS or manage DNS. It only has to be reached with the right `Host` header and a certificate for it. The public `GET /api/domains/allowed` endpoint lets a proxy such as Caddy ask whether a host is verified before issuing a certificate for it (see [DEPLOYMENT.md](DEPLOYMENT.md#custom-domains)).

Other places that know about domains:

- A link's `domain_id` is set at creation and never changed, because it is part of the short URL and the slug's uniqueness scope. Deleting a domain deletes its links (`ON DELETE CASCADE`); the API refuses that unless `deleteLinks=true`.
- A link may not point at a verified custom domain (`findServiceHosts`), the same rule as pointing at the service's own host, so a link cannot redirect back into the service.
- The password form posts to a relative URL and the rate-limit key includes the domain, so both stay on the host the visitor used.
- Like the slug cache, the host cache is per process: after a domain is verified, another instance can take up to `SLUG_CACHE_TTL_SECONDS` to notice.

## Folders, tags and filtering

Folders and tags are organisation only: the redirect never reads them, so changing them does not need a slug-cache `invalidate` (the `PATCH` handler clears the entry anyway, which is harmless). Field validation (`services/linkFields.js`) is shared by the single-link routes and the bulk import. `GET /api/links` builds its `WHERE` clause from fixed SQL fragments with parameters for every value; `q` uses `position(needle in lower(column))` rather than `LIKE`, so `%` and `_` in a search need no escaping.

## Bulk import

`POST /api/links/bulk` takes the CSV as a `text/csv` body (Express `text()` parser, 1 MB limit). `services/csv.js` is a small RFC 4180 reader; `services/bulkImport.js` maps header names to fields and validates each row with the same functions as `POST /api/links`. The handler then:

1. validates every row and flags a slug repeated inside the file (the first row wins);
2. checks the remaining custom slugs against the database in one query;
3. works out which folders are new and refuses the import if it would pass the per-user folder limit;
4. with `dryRun=true`, stops and reports; otherwise creates the missing folders (`ON CONFLICT (user_id, lower(name)) DO NOTHING`, then re-reads them, so a concurrent request creating the same folder is fine) and inserts the links one by one.

Rows are inserted sequentially and independently, not in one transaction: a failure on one row (a slug taken by a concurrent request, say) does not undo the others, and the response says which rows failed. The cap of 500 rows keeps the request short; rows with passwords are the slow part (bcrypt). New slugs need no cache invalidation, because unknown slugs are never cached.

## Click logging

`clickLogger` buffers clicks and flushes every second (or at 500 rows) with one multi-row `INSERT`. If a batch fails (for example a link deleted mid-flight violates the foreign key), rows are retried individually so one bad row cannot drop the batch. The buffer is capped at 10,000 rows, and is flushed on `SIGTERM`/`SIGINT`. Trade-off: a hard crash can lose about a second of clicks.

Each click records the referrer **hostname** only, a `source` tag (`qr` when the URL was `/slug?s=qr`, the only value accepted; it is what QR codes encode, and the password form carries it through), parsed user agent (device/browser/OS), country from a CDN header when present, and `HMAC-SHA256(ip, IP_HASH_SECRET)` truncated to 32 hex chars for unique-visitor counts.

## Stats

`computeStats` runs seven queries in parallel for a given scope (one link, or all of a user's links). Bucket boundaries are computed in the viewer's time zone and converted back to `timestamptz` so the clicks index is used. `generate_series` zero-fills empty buckets. Sources are computed from `(referrer, source)` pairs: `source = 'qr'` becomes "QR code", otherwise the referrer host is mapped to a friendly name. `range` values are interpolated into SQL only from a fixed whitelist.

## Password brute-force limiter

`services/rateLimit.js`: a `Map` keyed by `ip|slug`, 5 failures per 15 minutes, capped at 50,000 keys. Per-process memory; replace with Redis/Postgres when running multiple instances.

## Client

Vite + React, no router: `App.jsx` switches between Overview, Links and Link detail. The Links page filters through the API (`folder`, `tag`, `q`) and polls like the stats pages; the CSV import dialog first calls the bulk endpoint with `dryRun=true` to show what would happen, then repeats the call to create the links. `api.js` wraps `fetch` with the stored JWT and signs the user out on any 401. `useFetch` loads data, refetches on dependency changes and polls every 30 seconds. QR codes are generated client-side (`qrcode` package).

## Design decisions worth knowing

- JWT in `localStorage`: simple, but exposed to XSS. Consider httpOnly cookies if you add untrusted content to the dashboard.
- Server-rendered HTML for gate/error pages so they work without the dashboard and from any device.
- No ORM: plain SQL through `pg`.
- Slug cache in process memory rather than Redis: no new infrastructure and no network hop on the hot path. The cost is the per-instance staleness window described above. A shared cache is the next step if you scale out.
