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
| `SAFE_BROWSING_API_KEY` | no | off | Google Safe Browsing API key. When set, destination URLs are checked when a link is created or edited and listed phishing/malware sites are refused. Create a key in Google Cloud with the Safe Browsing API enabled |
| `SAFE_BROWSING_TIMEOUT_MS` | no | `3000` | How long to wait for Google before treating the check as failed |
| `SAFE_BROWSING_FAIL_CLOSED` | no | `false` | `false`: links are saved if Safe Browsing can't be reached (the error is logged). `true`: they are refused with `503` until it works again |
| `CUSTOM_DOMAIN_TARGET` | no | host of `BASE_URL` | What users are told to point their custom domain at: a host name for a CNAME, or an IP address. Set it when the public host differs from `BASE_URL`, for example a dedicated `cname.sho.rt` |

Node 20.6+ is required (`--env-file`).

## Database

```bash
psql "$DATABASE_URL" -f server/db/schema.sql
```

The script is idempotent and is also how you upgrade (v4 replaces `links.one_time`/`used_at` with `max_clicks`/`used_clicks`, migrating existing one-time links, and adds `clicks.source`; v6 adds the `domains` table and `links.domain_id`, and makes slugs unique per domain instead of globally (existing links stay on the default domain); v5 adds the `folders` table and `links.folder_id`/`links.tags`, with existing links left unfiled and untagged). Run it after pulling new versions, **before or together with** starting the new server: the old server does not know the new columns, and the new one does not know the old ones.

## Production checklist

1. **Build the dashboard:** `cd client && npm ci && npm run build` → `client/dist`.
2. **Serve it** from the same origin as the API (nginx/Caddy serving `dist/` and proxying `/api` and short-link paths to Node), or host it separately and set `CLIENT_ORIGIN`; in that case change `api.js` to use the API's full URL.
3. **Run the server:** `cd server && npm ci --omit=dev && npm start`. Keep it alive with systemd, pm2 or a container.
4. **HTTPS** via your reverse proxy or platform.
5. **`TRUST_PROXY`**: set it to match the proxy setup. Without it every visitor has the proxy's IP, unique visitors collapse to 1 and the password rate limiter blocks everyone together.
6. **Countries:** the server reads a CDN header when there is one (`CF-IPCountry`, `X-Vercel-IP-Country`, `CloudFront-Viewer-Country`) and otherwise looks the visitor's IP up in a bundled offline country database (`geoip-country`; the IP is not stored). Behind a proxy, set `TRUST_PROXY=1` so the real visitor IP is used; without it every visit shows the proxy's address and the country is Unknown. Clicks recorded before this change keep an empty country (their IPs were never stored). The database is updated by upgrading the package.
7. **Several instances:** the slug cache and the password limiter are per process. After a `PATCH` or `DELETE`, other instances can serve the old link for up to `SLUG_CACHE_TTL_SECONDS`. Lower it, or set it to `0`, if links must change everywhere at once.
8. **Manual database edits:** the cache only learns about changes made through the API. After editing `links` rows with SQL, wait for the TTL or restart the server.
9. **Short domain routing:** the proxy must send `/:slug` and `POST /:slug` to Node. If the dashboard shares the domain, see the example below.

## Custom domains

Users add domains in the dashboard; each one needs a DNS TXT record (ownership) and a CNAME (routing), and your proxy has to do three things for those hosts:

1. send **every path** to the Node server, including `/`, which on a custom domain has nothing to show (the dashboard is served only on your main host);
2. pass the original `Host` header (the server picks the domain from it; with `TRUST_PROXY` set it also honours `X-Forwarded-Host`);
3. have a TLS certificate for each domain.

The server cannot do step 3 itself. Point `CUSTOM_DOMAIN_TARGET` (or `BASE_URL`'s host) at your server, then use a proxy that issues certificates on demand. **Caddy** does this and can ask LinkPulse which hosts are allowed, so only domains a user has verified ever get a certificate:

```caddyfile
{
	on_demand_tls {
		ask http://127.0.0.1:4000/api/domains/allowed
	}
}

# Your main host: dashboard + API + default-domain links
sho.rt {
	@dashboard path / /assets/*
	handle @dashboard {
		root * /var/www/linkpulse/client/dist
		file_server
	}
	handle {
		reverse_proxy 127.0.0.1:4000
	}
}

# Any other host: only short links. Certificates are issued on demand, after the `ask` check
https:// {
	tls {
		on_demand
	}
	handle /api/* {
		respond 404
	}
	handle {
		reverse_proxy 127.0.0.1:4000
	}
}
```

This is a starting point; adapt paths and addresses to your setup, and test it with one domain before relying on it. Set `TRUST_PROXY=1`. The `/api/*` rule keeps the dashboard API off customers' domains.

With **nginx** you can add one `server` block per domain with its own certificate (certbot), or a catch-all `server` that proxies everything to Node, but nginx has no built-in on-demand certificates. Whatever the proxy, keep the `Host` header: `proxy_set_header Host $host;`.

Notes:

- DNS: a bare domain (`example.com`) cannot have a CNAME, so customers should use a subdomain, or an ALIAS/ANAME or A record. The dashboard shows the exact records.
- Verification only proves who controls the DNS when the domain is added. Nothing re-checks it, so remove a domain in the dashboard if you stop wanting it served.
- With several instances, each caches which hosts are custom domains for up to `SLUG_CACHE_TTL_SECONDS` (60), so a newly verified domain may take that long to start working everywhere.
- Short URLs use the scheme of `BASE_URL`; in production make that `https://`.

## Request size limits

`POST /api/links/bulk` accepts a CSV body of up to 1 MB (about 500 rows). If you proxy the API through nginx, the default `client_max_body_size` of 1 MB is just enough; raise it only if you also raise the limit in `routes/links.js`. A body over the limit gets `413` with a JSON error.

## Example nginx (single domain, no custom domains)

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
