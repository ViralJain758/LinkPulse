# LinkPulse dashboard

React + Vite client for the LinkPulse server.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # outputs dist/
```

Start the server first (port 4000). `client/.env` stores the server URL in `VITE_API_URL`; copy `.env.example` when setting up another environment. Leave `VITE_API_URL` empty when the dashboard is served from the same origin. The Vite dev server proxies `/api` to `http://localhost:4000`; set `VITE_API_TARGET` if you use the proxy fallback instead. A separate client origin must be included in the server's `CLIENT_ORIGIN`.

## Screens

- **Overview**: clicks, unique visitors, busiest bucket, top source, clicks over time, top links, and breakdowns by source, device, browser, OS and country
- **Links**: create (custom slug, expiry, password, click limit, tags, folder, custom domain), filter by domain, **Domains** (add a domain, copy the DNS records, check them), search and filter by folder or tag, **Import CSV** (preview, then create; download a results file with the new short URLs), **Manage folders**, copy, QR code (PNG/SVG, tracked as a "QR code" source), edit destination/expiry/click limit/tags/folder, add/change password, pause/resume, reset the visit count of limited links, delete
- **Link detail**: the same analytics for one link. Click a link row to open it

Range (24h/7d/30d/90d) uses your browser's time zone. Stats refresh every 30 seconds.

## Content-Security-Policy

`npm run build` writes a CSP `<meta>` tag into `dist/index.html` (from `csp.js`; the API origin comes from `VITE_API_URL`). Serve `dist/` with the headers in `vercel.json`, `public/_headers`, or the nginx/Caddy snippets in [docs/SECURITY-HEADERS.md](../docs/SECURITY-HEADERS.md). `npm test` checks the policy and keeps the header files in sync. If a new feature loads something from a new host, the browser console shows a `Refused to ...` message; allow that host in `csp.js`.

## Deploying

Serve `dist/` from the same origin as the API (or proxy `/api`), or change `api.js` to use a full API URL and set `CLIENT_ORIGIN` on the server. See [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md).
