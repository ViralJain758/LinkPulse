# Operations

Running LinkPulse in production: health checks, logs, error tracking, backups, and the Docker image.
Configuration variables are in [DEPLOYMENT.md](DEPLOYMENT.md).

## Health checks

| Endpoint | Checks | Use it for |
|---|---|---|
| `GET /health` | Runs `select 1` through the server's own connection pool (3 s limit) | Load balancer / uptime monitor / Docker `HEALTHCHECK`: "can this instance serve traffic?" |
| `GET /health/live` | Nothing but that the process answers | "Should this process be restarted?" Database trouble should not restart every instance at once |

`/health` returns `200 {"status":"ok","db":"ok","dbLatencyMs":4,"uptimeSeconds":812}` or `503 {"status":"unavailable","db":"down"}`. The body never says why; the reason is in the log as `health check failed` with the database error. Both are sent with `Cache-Control: no-store`. Successful probes are logged at `debug`, failed ones at `error`.

Point an external monitor (UptimeRobot, Better Stack, ...) at `https://<your host>/health`, and alert on two consecutive failures.

`/health` is public and makes one cheap query per call. If that matters, restrict it at the proxy or rely on the monitor's interval.

## Logs

Every line is one JSON object in production (`NODE_ENV=production`), a readable line otherwise. Override with `LOG_FORMAT=json|text` and `LOG_LEVEL=debug|info|warn|error|silent` (default `info`).

```json
{"time":"2026-10-22T09:15:02.114Z","level":"info","msg":"request","requestId":"3f0c...","method":"POST","path":"/api/links","status":201,"ms":38}
{"time":"2026-10-22T09:15:09.870Z","level":"error","msg":"unhandled error","requestId":"a91e...","method":"GET","path":"/api/stats/overview","err":{"type":"Error","message":"...","code":"57014","stack":"..."}}
```

**Request ids.** Each request gets an id, returned in the `X-Request-Id` response header and attached to every log line written while it runs. A caller or proxy may supply its own (`X-Request-Id`, 8-64 characters of letters, digits, `.`, `_`, `-`); anything else is replaced. An internal error answers `500 {"error":"Internal server error","requestId":"..."}`, so a user can quote the id and you can find the exact lines:

```bash
docker compose logs server | grep a91e1c2e        # or in your log service: requestId:"a91e1c2e..."
```

To have nginx pass its own id through: `proxy_set_header X-Request-Id $request_id;`

**What is never logged.** Query strings (they carry reset and confirmation tokens), request bodies, headers, IP addresses, and the recipient of an email. Keep it that way: do not add them as log fields. In development, emails that cannot be sent are printed to the console with their links; in production they are not.

Background work (click buffer, retention, rate-limit purge, alerts, emails) logs without a request id.

## Error tracking

Off unless `SENTRY_DSN` is set. It speaks Sentry's envelope API directly (no SDK, no extra dependency), so it works with Sentry and with self-hosted compatible servers such as GlitchTip.

| Variable | Default | |
|---|---|---|
| `SENTRY_DSN` | empty (off) | Project DSN, `https://<key>@<host>/<project id>` |
| `SENTRY_ENVIRONMENT` | `NODE_ENV` | Shown as the environment in Sentry |
| `RELEASE` | none | Build identifier. The Docker image takes it as a build argument (below) |

Reported: unhandled errors in request handlers (the ones that become a `500`), unhandled promise rejections, and uncaught exceptions. Each event has the error type, message and stack, the `request_id` tag, and the request method and path.

Not reported: expected errors (validation `400`, `401`, `404`, rate limits), headers, cookies, bodies, query strings, IPs, user identity. Error *messages* are sent as written, so avoid putting personal data into messages you throw.

Safety limits: at most 30 events per minute per process (a failing database will not become thousands of events), and a 2 s timeout. If Sentry is unreachable the server logs a warning and carries on. On Vercel the report finishes before the response is sent, since the function may be frozen afterwards. An uncaught exception is reported and the process exits (the container is restarted by `restart: unless-stopped`).

Check it works: set the DSN, then trigger an error you can safely cause, such as stopping the database while calling an endpoint that needs it. Expect a `unhandled error` log line and an event with the same request id in Sentry.

To use the official `@sentry/node` SDK instead (performance traces, breadcrumbs), call `Sentry.captureException` inside `captureException` in `server/src/services/errorTracking.js`; nothing else needs to change.

## Backups

What needs backing up: **the Postgres database**. The server keeps no files and no other state. (The in-memory click buffer, up to a few seconds of clicks, is flushed on a clean shutdown.) Secrets live in your environment, not the database; keep `JWT_SECRET` and `IP_HASH_SECRET` somewhere safe: without the same `IP_HASH_SECRET` unique-visitor counts restart from zero, and a changed `JWT_SECRET` signs everyone out.

### Supabase

Supabase has its own project backups, and what is included depends on your plan (check the Database > Backups page of your project). Treat that as the first layer and take your own dump as the second, so you hold a copy outside Supabase and can restore into any Postgres.

### Your own dumps

```bash
cd server
BACKUP_KEEP_DAYS=14 scripts/backup.sh          # writes backups/linkpulse-<UTC timestamp>.dump
```

- Needs `pg_dump` (PostgreSQL client tools, version at least the server's).
- Reads `BACKUP_DATABASE_URL`, else `MIGRATE_DATABASE_URL`, else `DATABASE_URL` (also from `server/.env`). **On Supabase use the Session pooler or Direct string**; the script refuses the Transaction pooler (port 6543).
- Dumps only the `public` schema (all LinkPulse data, including the `pgmigrations` table). Supabase's own schemas are not touched.
- Checks that the finished file can be read, writes it with mode 600 into a 700 folder, and removes dumps older than `BACKUP_KEEP_DAYS` if set. `backups/` is git-ignored.
- Size: the `clicks` table dominates. [Click retention](DEPLOYMENT.md#click-retention) keeps it bounded.

Run it daily from cron or any scheduler, and copy the files **off the machine** (object storage, another host). A backup on the same disk as the database is not a backup. Dumps contain password hashes, session records and hashed visitor data: encrypt them at rest (for example `age` or the storage provider's encryption) and restrict who can read them.

```cron
15 2 * * *  cd /srv/linkpulse/server && BACKUP_KEEP_DAYS=7 scripts/backup.sh && rclone copy backups remote:linkpulse-backups --max-age 2d
```

### Restore

Always restore into a **new, empty database first**, check it, and only then switch the server over. `restore.sh` takes the target on the command line (it never reads `.env`, so it cannot hit the live database by accident) and refuses a target that already has tables unless you pass `--replace`.

1. Create the target: a new, empty Supabase project (use its Session pooler or Direct string). Delete it when you are done if it was only a drill.
2. Restore:
   ```bash
   scripts/restore.sh backups/linkpulse-20261022T021500Z.dump "postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
   ```
   It runs in a single transaction: it either fully applies or leaves the target untouched.
3. Check it:
   ```bash
   psql "$TARGET" -c "select count(*) from users" -c "select count(*) from links" -c "select max(clicked_at) from clicks" -c "select name from pgmigrations order by id desc limit 1"
   ```
   The newest click time tells you how much was lost (everything after the dump).
4. Apply any migrations newer than the dump: `DATABASE_URL=$TARGET npm run migrate`.
5. Switch over: set `DATABASE_URL` (and `MIGRATE_DATABASE_URL`) to the restored database, restart the server, and confirm `GET /health` returns `200` and a known short link redirects.
6. Per-instance slug caches expire within `SLUG_CACHE_TTL_SECONDS` (default 60 s); restart instances to clear them at once.

Restoring over the live database (`--replace`) is for when it is already broken or empty. Stop the server first.

**Practise it.** An untested backup is a hope. Restore the latest dump into a scratch database once a quarter and run step 3. A restore takes seconds for megabytes and minutes for gigabytes; know yours before you need it.

### What a restore does not bring back

Clicks after the dump. Clicks already rolled up by retention stay as per-day totals (that is by design, not loss). Sessions in the dump are restored; users stay signed in unless the sessions expired in the meantime.

## Docker

`server/Dockerfile` builds a small production image: Node 22 on Alpine, production dependencies only, runs as the unprivileged `node` user, starts `node src/index.js` directly (so `docker stop` delivers SIGTERM and buffered clicks are flushed), and has a `HEALTHCHECK` against `/health`. The image holds the server only; the dashboard is a static site built from `client/`.

```bash
docker build -t linkpulse-server --build-arg RELEASE=$(git rev-parse --short HEAD) server
docker run --rm -p 4000:4000 -e DATABASE_URL=... -e JWT_SECRET=... -e BASE_URL=https://sho.rt -e TRUST_PROXY=1 linkpulse-server
```

The image has no `.env`: pass settings as environment variables (`docker run -e`, `--env-file`, or your platform's secrets). Everything in [DEPLOYMENT.md](DEPLOYMENT.md) applies.

Run migrations from the same image, before starting a new version:

```bash
docker run --rm -e DATABASE_URL=<session pooler or direct string> linkpulse-server node scripts/migrate.js up
```

### Compose

`docker-compose.yml` runs the server against your Supabase database: `migrate` applies migrations and exits, then `server` starts. There is no local database; set `DATABASE_URL` (Transaction pooler), `MIGRATE_DATABASE_URL` (Session pooler or Direct) and `JWT_SECRET` in a `.env` file next to the compose file or in your shell.

```bash
docker compose up -d --build
curl localhost:4000/health
docker compose logs -f server
```

Put TLS in front of port 4000 and set `BASE_URL`, `CLIENT_ORIGIN` and `TRUST_PROXY` for a real deployment. Backups are Supabase's plus your own dumps (see above).

## Runbook

| Symptom | Look at | Likely cause |
|---|---|---|
| `/health` is `503` | Log line `health check failed` and its `err` | Database down, wrong credentials, pool exhausted (`DATABASE_POOL_MAX`), network or TLS settings (`DATABASE_SSL`) |
| `/health/live` fails | Container status and the last log lines | Process crashed or wedged; check for `uncaught exception` |
| Users report an error | Ask for the `requestId` from the response or `X-Request-Id` header | Search logs for it; the same id is on the Sentry event |
| Clicks missing after an incident | `click batch failed` / `click dropped` log lines | Database was unreachable; buffered clicks that could not be written are dropped (logged individually) |
| Many `request` lines with `status` 5xx | Sentry issue list, grouped by message | A single failing query or dependency |
