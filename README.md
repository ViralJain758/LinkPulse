# LinkPulse

A self-hosted URL shortener with built-in click analytics. Create short links, protect them with a password, limit them to a number of visits, share them as QR codes, and watch the clicks come in on a live dashboard.

> Stack: Node.js (Express) · PostgreSQL · React (Vite) · Recharts

## Features

- **Short links** with random or custom slugs, optional expiry, pause/resume, edit (destination, expiry, limit) and delete
- **Password-protected links**: visitors must enter a password first (bcrypt-hashed, brute-force limited)
- **Click limits**: "expire after N clicks" (1 = one-time link), safe against link-preview bots and simultaneous visitors
- **QR codes** for every link, downloadable as PNG or SVG; scans are tracked as their own "QR code" source
- **Click analytics**: totals, unique visitors, time series, sources (referrers), devices, browsers, OS, countries
- **Privacy-minded**: raw IPs are never stored (keyed hash only); referrers are stored as hostnames only; bots and link-preview fetchers are not counted
- **Fast redirects**: recently used links are served from a small in-memory cache, and clicks are buffered in memory and written in batches after the redirect is sent
- **Dashboard** with per-link and overall views, refreshing every 30 seconds

## Quick start

Requirements: **Node.js 20.6+** and **PostgreSQL 13+** (or Docker for the database).

```bash
git clone <your-repo-url> linkpulse && cd linkpulse

# 1. Database (either use your own Postgres, or:)
docker compose up -d db          # Postgres on localhost:5432, schema applied automatically

# 2. Server
cd server
npm install
cp .env.example .env             # set JWT_SECRET and DATABASE_URL
# if you did not use docker compose: psql "$DATABASE_URL" -f db/schema.sql
npm run dev                      # http://localhost:4000

# 3. Client (new terminal)
cd client
npm install
npm run dev                      # http://localhost:5173
```

Open http://localhost:5173, register an account, and create your first link.

Generate a strong `JWT_SECRET` with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## Project layout

```
linkpulse/
├── server/            Express API + redirect service
│   ├── db/schema.sql  Database schema (idempotent)
│   ├── src/
│   │   ├── routes/    auth, links, stats, redirect
│   │   ├── services/  slug, slug cache, URL validation, click parsing/logging, rate limiting
│   │   └── middleware/
│   └── test/          Unit tests (`npm test`)
├── client/            React dashboard (Vite)
├── docs/              API reference, architecture, deployment
└── docker-compose.yml Local Postgres
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

Custom domains, webhooks, CSV export, a shared cache for multi-instance setups, broader test coverage (route and database tests). See [CHANGELOG.md](CHANGELOG.md) for what has shipped.

## License

[MIT](LICENSE)
