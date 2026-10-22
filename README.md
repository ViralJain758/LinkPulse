# LinkPulse

**Live demo:** https://linkpulse-vj.vercel.app

[![CI](https://github.com/ViralJain758/LinkPulse/actions/workflows/ci.yml/badge.svg)](https://github.com/ViralJain758/LinkPulse/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A self-hosted URL shortener with built-in click analytics. Create short links, protect them with a password, limit them to a number of visits, share them as QR codes, and watch the clicks come in on a live dashboard.

> Stack: Node.js (Express) · Supabase (PostgreSQL) · React (Vite) · Recharts

## Features

- **Short links** with random or custom slugs, optional expiry, pause/resume, edit (destination, expiry, limit, tags, folder) and delete
- **Custom domains**: every user can serve links from their own domain (`go.acme.com/sale`), verified with a DNS record. Slugs are unique per domain, so two users can both have `/sale`
- **Folders and tags** to keep many links organised: one folder per link, up to 10 tags, and a Links page you can filter by folder or tag and search by slug, URL or tag
- **Bulk create from CSV**: import up to 500 links at once, with a preview that flags problem rows before anything is created, and a results file with every new short URL
- **Password-protected links**: visitors must enter a password first (bcrypt-hashed, brute-force limited)
- **Click limits**: "expire after N clicks" (1 = one-time link), safe against link-preview bots and simultaneous visitors
- **QR codes** for every link, downloadable as PNG or SVG; scans are tracked as their own "QR code" source
- **Click analytics**: totals, unique visitors, time series, sources (referrers), devices, browsers, OS, countries
- **Privacy-minded**: raw IPs are never stored (keyed hash only); referrers are stored as hostnames only; bots and link-preview fetchers are not counted
- **Fast redirects**: recently used links are served from a small in-memory cache, and clicks are buffered in memory and written in batches after the redirect is sent
- **Abuse reports and takedowns**: anyone can report a link at `/report` (every password and error page links to it); admins review reports in the dashboard's Admin tab, take down a link or suspend an account with a reason, and every action is logged. See [Moderation](docs/DEPLOYMENT.md#abuse-reports-and-takedowns).
- **Dashboard** with per-link and overall views, refreshing every 30 seconds

## Quick start

Requirements: **Node.js 20.6+** and a [Supabase](https://supabase.com) project (the free plan is enough to start). Docker is only needed if you want an offline local Postgres instead.

```bash
git clone https://github.com/ViralJain758/LinkPulse.git && cd LinkPulse

# 1. Database: create a Supabase project, put its Session pooler string in server/.env as DATABASE_URL, then run: cd server && npm install && npm run migrate
#    (Offline instead? `docker compose up -d db` starts a local Postgres with the schema applied.)

# 2. Server
cd server
npm install
cp .env.example .env             # set JWT_SECRET and DATABASE_URL (Supabase: Connect > Transaction pooler)
npm run dev                      # http://localhost:4000

# 3. Client (new terminal)
cd client
npm install
npm run dev                      # http://localhost:5173
```

Open http://localhost:5173, register an account, and create your first link.

Upgrading from an earlier version? Run `npm run migrate` in `server/` before starting the new server. Databases that were set up from the old `schema.sql` are picked up automatically (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#database-migrations)).

## Custom domains

Under **Domains** on the Links page, add a host such as `go.example.com`. LinkPulse shows two DNS records to create at your DNS provider: a **TXT** record that proves you own the domain, and a **CNAME** to the service so visitors reach it. After **Check DNS** succeeds, pick the domain when you create a link (or in a CSV import) and its short URL becomes `https://go.example.com/<slug>`. Links on a domain are separate from the default domain: `/sale` can exist on both, and a domain serves only its own links.

For this to work in production, your reverse proxy must pass every path for those hosts to the server **with the original `Host` header**, and have a certificate for each domain. The deployment guide has a Caddy setup that issues certificates automatically, only for domains that have been verified: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#custom-domains). To try it locally without DNS, mark a row in `domains` as verified by hand (`UPDATE domains SET verified_at = now() WHERE host = 'go.example.com'`) and send the host with `curl -H 'Host: go.example.com' localhost:4000/<slug>`.

## Organising links: folders, tags and CSV import

- **Folders** are flat and per user; a link is in one folder or none. Create and rename them under **Manage folders**. Deleting a folder keeps its links (they become unfiled).
- **Tags** are free-form labels (lowercase, up to 10 per link, 32 characters each). Click a tag chip to filter; the search box also matches tags.
- **Import CSV** takes a file with a header row. Only `url` is required:

  ```csv
  url,slug,tags,folder,expires_at,password,max_clicks
  https://example.com/spring-sale,spring-sale,launch|email,Campaigns,,,
  https://example.com/docs,,docs,,2027-12-31T23:59:00Z,,
  ```

  Separate several tags with `|` (or `,` / `;` inside quotes). A folder that does not exist yet is created. An optional `domain` column puts a row on one of your verified custom domains. The dialog checks the file first and lists problem rows (bad URL, taken slug, duplicate slug in the file...); only valid rows are created. Details and the HTTP endpoint are in [docs/API.md](docs/API.md#bulk-create-from-csv).

Generate a strong `JWT_SECRET` with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## Project layout

```
linkpulse/
├── server/            Express API + redirect service
│   ├── migrations/    Database migrations (node-pg-migrate, SQL)
│   ├── src/
│   │   ├── routes/    auth, links (incl. bulk import), folders, tags, domains, stats, redirect
│   │   ├── services/  slug, slug cache, URL validation, link field validation, CSV import, custom domain DNS/lookup, click parsing/logging, rate limiting
│   │   └── middleware/
│   └── test/          Unit tests (`npm test`)
├── client/            React dashboard (Vite)
├── docs/              API reference, architecture, deployment
└── docker-compose.yml Optional offline Postgres
```

## Documentation

| Doc | What is in it |
|---|---|
| [docs/API.md](docs/API.md) | Every HTTP endpoint with request/response examples |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How redirects, the slug cache, click logging, password and one-time links work |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Configuration reference and production setup |
| [server/README.md](server/README.md) | Server-specific notes |
| [client/README.md](client/README.md) | Dashboard-specific notes |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Dev workflow and conventions |
| [SECURITY.md](SECURITY.md) | Security model and reporting vulnerabilities |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## Roadmap

Webhooks, CSV export of links and stats, selecting several links to move or tag them at once, per-folder and per-tag analytics, a shared cache for multi-instance setups, broader test coverage (route and database tests). See [CHANGELOG.md](CHANGELOG.md) for what has shipped.

## Contributing

Issues and pull requests are welcome at [github.com/ViralJain758/LinkPulse](https://github.com/ViralJain758/LinkPulse). See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
