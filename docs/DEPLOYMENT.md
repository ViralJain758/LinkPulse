# Configuration and deployment

## Environment variables (`server/.env`)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | | Postgres connection string |
| `JWT_SECRET` | yes | | Signs login tokens. Use a long random value |
| `PORT` | no | `4000` | HTTP port |
| `BASE_URL` | no | `http://localhost:4000` | Public URL of the shortener. Used to build short links and block links to itself |
| `CLIENT_ORIGIN` | no | `http://localhost:5173` | Allowed CORS origin for the dashboard |
| `TRUST_PROXY` | no | off | Express `trust proxy`: `1` behind one proxy/CDN, a hop count, or `loopback`/CIDR list |
| `IP_HASH_SECRET` | no | `JWT_SECRET` | Key for hashing visitor IPs. Changing it resets unique-visitor continuity |
| `SLUG_CACHE_TTL_SECONDS` | no | `60` | How long the redirect caches a link lookup. `0` disables the cache. With several instances this is how long an edit/delete can take to reach the others |
| `SLUG_CACHE_MAX` | no | `1000` | Maximum cached links per process (least recently used are dropped first) |

Node 20.6+ is required (`--env-file`).

## Database

```bash
psql "$DATABASE_URL" -f server/db/schema.sql
```

The script is idempotent and is also how you upgrade (v4 replaces `links.one_time`/`used_at` with `max_clicks`/`used_clicks`, migrating existing one-time links, and adds `clicks.source`). Run it after pulling new versions, **before or together with** starting the new server: the old server does not know the new columns, and the new one does not know the old ones.

## Production checklist

1. **Build the dashboard:** `cd client && npm ci && npm run build` → `client/dist`.
2. **Serve it** from the same origin as the API (nginx/Caddy serving `dist/` and proxying `/api` and short-link paths to Node), or host it separately and set `CLIENT_ORIGIN`; in that case change `api.js` to use the API's full URL.
3. **Run the server:** `cd server && npm ci --omit=dev && npm start`. Keep it alive with systemd, pm2 or a container.
4. **HTTPS** via your reverse proxy or platform.
5. **`TRUST_PROXY`**: set it to match the proxy setup. Without it every visitor has the proxy's IP, unique visitors collapse to 1 and the password rate limiter blocks everyone together.
6. **Countries:** the server only reads CDN headers (`CF-IPCountry`, `X-Vercel-IP-Country`, `CloudFront-Viewer-Country`). Without a CDN the country column stays empty.
7. **Several instances:** the slug cache and the password limiter are per process. After a `PATCH` or `DELETE`, other instances can serve the old link for up to `SLUG_CACHE_TTL_SECONDS`. Lower it, or set it to `0`, if links must change everywhere at once.
8. **Manual database edits:** the cache only learns about changes made through the API. After editing `links` rows with SQL, wait for the TTL or restart the server.
9. **Short domain routing:** the proxy must send `/:slug` and `POST /:slug` to Node. If the dashboard shares the domain, see the example below.

## Example nginx (single domain)

```nginx
server {
  listen 443 ssl;
  server_name sho.rt;

  location /api/ { proxy_pass http://127.0.0.1:4000; proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header Host $host; }
  location = /health { proxy_pass http://127.0.0.1:4000; }
  # Dashboard: the app shell at / and its built assets (no client-side routes)
  location = / { root /var/www/linkpulse/client/dist; try_files /index.html =404; }
  location /assets/ { root /var/www/linkpulse/client/dist; }
  # Everything else is a short link
  location / { proxy_pass http://127.0.0.1:4000; proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header Host $host; }
}
```

The dashboard lives at `/` and `/assets/`; every other single-segment path is a short link (`assets` is a reserved slug). Set `TRUST_PROXY=1`.

## Backups and maintenance

Back up Postgres (`pg_dump`). The `clicks` table grows with traffic; consider pruning or partitioning by month if you pass tens of millions of rows.
