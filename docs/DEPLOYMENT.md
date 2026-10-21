# Configuration and deployment

## Environment variables (`server/.env`)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | | Postgres connection string. Supabase: **Connect > Transaction pooler** (port 6543) |
| `DATABASE_SSL` | no | `auto` | TLS to the database: `auto` (on for Supabase hosts, off otherwise), `require` (encrypted, certificate not checked), `verify` (checked against `DATABASE_SSL_CA`), `false` |
| `DATABASE_SSL_CA` | with `verify` | | Path to the CA certificate file downloaded from the Supabase dashboard (Database settings) |
| `DATABASE_POOL_MAX` | no | `10` | Most connections one server process holds open |
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
| `SAFE_BROWSING_RECHECK_ON_REDIRECT` | no | `true` | `true`: the destination is checked again on each visit (cached 5 minutes) and a "Link blocked" page is shown, with status `403`, if it has been flagged since the link was saved. Needs `SAFE_BROWSING_API_KEY`. Always fails open: if Google can't be reached the visit is redirected |
| `SAFE_BROWSING_REDIRECT_TIMEOUT_MS` | no | `1500` | How long a visit waits for Google before redirecting anyway. After a failed lookup, visit-time checks pause for 30 s |
| `SAFE_BROWSING_FAIL_CLOSED` | no | `false` | `false`: links are saved if Safe Browsing can't be reached (the error is logged). `true`: they are refused with `503` until it works again |
| `ACCESS_TOKEN_TTL_MINUTES` | no | `15` | Lifetime of an access token. A revoked session stops working immediately regardless; this only bounds how often clients refresh |
| `REFRESH_TOKEN_TTL_DAYS` | no | `30` | A session ends after this many days without a refresh (each refresh extends it) |
| `REQUIRE_EMAIL_VERIFICATION` | no | `false` | `true`: sign-in is refused until the emailed link is opened. The server refuses to start without SMTP settings. Existing accounts are unverified, see the note below |
| `AUTH_FROM_EMAIL` | no | `NOTIFICATION_FROM_EMAIL` | Sender of verification and password-reset emails (uses the `SMTP_*` settings). Links point at `CLIENT_ORIGIN`, which must be the dashboard's public URL |
| `RATE_LIMIT_REGISTER_PER_IP` | no | `5` | Accounts one IP can create per hour. Each signup sends an email, so keep it low. `0` disables |
| `RATE_LIMIT_LOGIN_PER_IP` | no | `30` | Login attempts per IP per 15 minutes, on top of the 5-failures-per-IP-and-email lock. `0` disables |
| `RATE_LIMIT_LINKS_PER_USER` | no | `500` | Links one user can create per hour; a CSV import counts one per row, so keep it at or above the import size you want to allow (max 500 rows). `0` disables |
| `CUSTOM_DOMAIN_TARGET` | no | host of `BASE_URL` | What users are told to point their custom domain at: a host name for a CNAME, or an IP address. Set it when the public host differs from `BASE_URL`, for example a dedicated `cname.sho.rt` |

Node 20.6+ is required (`--env-file`).

**Upgrading to shared rate limits (v9).** Run `server/db/schema.sql` (adds the `rate_limits` table) before or with the new server: without it, login, registration, link creation and the password page fail with a database error. Counters are not carried over, so every limit starts fresh. Expired rows are purged every 10 minutes.

**Upgrading to the session-based auth (v8).** Run `server/db/schema.sql` together with the new server. **Everyone is signed out once**: old 7-day tokens carry no session and are refused, which is how they become revocable. Without SMTP, reset and confirmation links are printed to the server console (never in `NODE_ENV=production`), so set up SMTP before relying on password reset. To turn on `REQUIRE_EMAIL_VERIFICATION` without locking out existing users, mark them confirmed first: `UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;`.

## Database

LinkPulse's database is [Supabase](https://supabase.com) Postgres. The server talks to it with an ordinary Postgres connection (`pg`); it does not use the Supabase API, the `anon`/`service_role` keys or Supabase Auth (accounts and sessions are LinkPulse's own).

**Set up (new project, no data to migrate):**

1. Create a Supabase project and note the database password.
2. Open **SQL Editor**, paste `server/db/schema.sql` and run it. Or from a shell: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/db/schema.sql` (use the Session pooler or Direct string for this, see below).
3. Click **Connect** in the dashboard, copy the **Transaction pooler** string into `DATABASE_URL`, and put the password in it (URL-encode special characters such as `@`, `#` or `/`).

**Which connection string:**

| String | Port | Use it for |
|---|---|---|
| Transaction pooler | 6543 on `...pooler.supabase.com` | The running server. Connections are shared between clients, which suits many instances or a serverless host. LinkPulse uses no transactions across queries, no named prepared statements and no session state, so it works in this mode |
| Session pooler | 5432 on `...pooler.supabase.com` | `psql`, `pg_dump` and one-off scripts from an IPv4-only network |
| Direct | 5432 on `db.[ref].supabase.co` | Same, from an IPv6-capable network (IPv4 needs Supabase's paid add-on) |

**TLS.** Supabase only accepts encrypted connections. With `DATABASE_SSL=auto` the server turns TLS on for `*.supabase.co` and `*.supabase.com` hosts and leaves it off for others, such as the local docker database. That encrypts the connection but does not check the server's certificate. To check it, download the CA certificate from the dashboard (Database settings) and set `DATABASE_SSL=verify` and `DATABASE_SSL_CA=/path/to/certificate`.

**Row Level Security.** Supabase exposes every table in the `public` schema through its REST API to holders of the project's public `anon` key. `schema.sql` enables Row Level Security on every table with no policies, so that API returns nothing. The server is not affected because it connects as the table owner (`postgres`), which bypasses RLS. Connect with the `postgres` user from the dashboard's strings; a role without `BYPASSRLS` would see empty tables. If you do not use the REST API at all you can also turn it off in the project's API settings.

**Offline development.** `docker compose up -d db` starts a plain local Postgres with the schema applied; point `DATABASE_URL` at `postgres://postgres:postgres@localhost:5432/linkpulse` (TLS stays off there).

The script is idempotent and is also how you upgrade (v4 replaces `links.one_time`/`used_at` with `max_clicks`/`used_clicks`, migrating existing one-time links, and adds `clicks.source`; v6 adds the `domains` table and `links.domain_id`, and makes slugs unique per domain instead of globally (existing links stay on the default domain); v5 adds the `folders` table and `links.folder_id`/`links.tags`, with existing links left unfiled and untagged). Run it after pulling new versions, **before or together with** starting the new server: the old server does not know the new columns, and the new one does not know the old ones.

## Production checklist

1. **Build the dashboard:** `cd client && npm ci && npm run build` → `client/dist`.
2. **Serve it** from the same origin as the API (nginx/Caddy serving `dist/` and proxying `/api` and short-link paths to Node), or host it separately and set `CLIENT_ORIGIN`; in that case change `api.js` to use the API's full URL.
3. **Run the server:** `cd server && npm ci --omit=dev && npm start`. Keep it alive with systemd, pm2 or a container.
4. **HTTPS** via your reverse proxy or platform.
5. **`TRUST_PROXY`**: set it to match the proxy setup. Without it every visitor has the proxy's IP, unique visitors collapse to 1 and the rate limiters (which key on the client IP) treat everyone as one client and block them together.
6. **Countries:** the server reads a CDN header when there is one (`CF-IPCountry`, `X-Vercel-IP-Country`, `CloudFront-Viewer-Country`) and otherwise looks the visitor's IP up in a bundled offline country database (`geoip-country`; the IP is not stored). Behind a proxy, set `TRUST_PROXY=1` so the real visitor IP is used; without it every visit shows the proxy's address and the country is Unknown. Clicks recorded before this change keep an empty country (their IPs were never stored). The database is updated by upgrading the package.
7. **Several instances:** the slug cache is per process (rate limits are not: they live in Postgres and are shared). After a `PATCH` or `DELETE`, other instances can serve the old link for up to `SLUG_CACHE_TTL_SECONDS`. Lower it, or set it to `0`, if links must change everywhere at once.
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

Back up the database. Which automatic backups Supabase keeps depends on your plan (check the dashboard); `pg_dump` over the Session pooler or Direct string always works. The `clicks` table grows with traffic; consider pruning or partitioning by month if you pass tens of millions of rows.
