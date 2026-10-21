# API reference

Base URL: `http://localhost:4000` (your `BASE_URL`). JSON in and out unless noted. Authenticated endpoints need `Authorization: Bearer <token>`. Errors look like `{ "error": "message" }`.

Link and user ids are returned as strings (Postgres `BIGINT`).

## Auth

### `POST /api/auth/register`
Body: `{ "email", "password" }` (password min 8 chars).
`201` → `{ "user": { "id", "email" }, "token" }`. `409` if the email exists.

### `POST /api/auth/login`
Body: `{ "email", "password" }`. `200` → `{ "user", "token" }`. `401` on bad credentials.

## Links (auth required)

Link object:

```json
{
  "id": "1",
  "slug": "spring-sale",
  "shortUrl": "http://localhost:4000/spring-sale",
  "targetUrl": "https://example.com/page",
  "expiresAt": null,
  "isActive": true,
  "hasPassword": false,
  "maxClicks": null,
  "usedClicks": 0,
  "tags": ["launch", "email"],
  "folderId": "3",
  "folderName": "Campaigns",
  "createdAt": "2026-10-20T16:35:28.542Z",
  "clickCount": 12
}
```

`clickCount` (recorded analytics clicks) is only present in the list endpoint. `usedClicks` counts visits that consumed the click limit; it is `0` for unlimited links and can be lower than `clickCount`, because visits are only counted against the limit when a limit is set. The password hash is never returned. `tags` is always an array; `folderId` and `folderName` are `null` for an unfiled link.

### `POST /api/links`
| Field | Type | Notes |
|---|---|---|
| `url` | string, required | `http`/`https`, max 2048 chars, not this service's own host |
| `slug` | string | 3-32 chars `A-Za-z0-9_-`, not reserved. Random 7-char slug if omitted |
| `expiresAt` | ISO date | must be in the future |
| `password` | string | 4-72 bytes. Visitors must enter it |
| `maxClicks` | integer 1-1,000,000 | link stops working after this many visits (`1` = one-time). Omit or `null` for unlimited |
| `tags` | array of strings | up to 10, each up to 32 characters: letters, numbers, spaces, `.` `-` `_`. Stored lowercase with single spaces; duplicates are dropped |
| `folderId` | string or number | id of one of your folders. `400` if it does not exist or is not yours |

`201` → link. `400` validation, `409` slug taken.

### `GET /api/links`
Your links, newest first, with `clickCount`. Optional filters, combined with AND:

| Query | Meaning |
|---|---|
| `folder` | a folder id, or `none` for links in no folder |
| `tag` | links that have this tag (one tag; case-insensitive) |
| `q` | case-insensitive text found in the slug, the destination URL or a tag |

`400` for a malformed `folder`, or a `tag`/`q` given more than once.

### `POST /api/links/bulk`
Creates many links from a CSV. Send the CSV as the request body with `Content-Type: text/csv` (max 1 MB and 500 data rows).

| Query | Meaning |
|---|---|
| `dryRun=true` | validate and report, create nothing |
| `folder=Name` | folder for rows whose `folder` cell is empty (created if missing) |
| `tags=a,b` | tags added to every row |

The first row is a header. Header names are matched ignoring case, spaces and punctuation, and the delimiter (comma, semicolon or tab) is detected. Only `url` is required:

| Column | Also accepted | Notes |
|---|---|---|
| `url` | `target`, `destination` | same rules as `POST /api/links` |
| `slug` | `alias` | random if empty |
| `tags` | `tag`, `labels` | separate with `\|` (or `,` / `;` inside quotes) |
| `folder` | | folder **name**, matched ignoring case; created if it does not exist |
| `expires_at` | `expires`, `expiry` | ISO 8601, in the future, e.g. `2027-12-31T23:59:00Z` |
| `password` | | 4-72 bytes |
| `max_clicks` | `click_limit`, `limit` | whole number 1-1,000,000 |

Unknown columns are ignored and listed in `ignoredColumns`.

Rows are independent: valid rows are created, invalid ones are reported and skipped. Rows that have a password take longer, because each is hashed with bcrypt. A slug that appears twice in the file is accepted for its first row only.

`200` →

```json
{
  "dryRun": false,
  "total": 3,
  "valid": 2,
  "created": 2,
  "failed": 1,
  "ignoredColumns": ["Notes"],
  "newFolders": ["Campaigns"],
  "results": [
    { "row": 2, "url": "https://example.com/a", "status": "created", "link": { "id": "41", "slug": "spring-sale", "...": "..." } },
    { "row": 3, "url": "https://example.com/b", "status": "created", "link": { "...": "..." } },
    { "row": 4, "url": "nope", "status": "error", "error": "url is not valid" }
  ]
}
```

`row` is the record number in the file, counting the header as row 1 and blank lines, so it matches a spreadsheet. With `dryRun=true`, valid rows have `status: "ok"`, `created` is `0` and `newFolders` lists the folders that a real run would create. Slugs already taken are detected in a dry run too, but a slug can still be lost to a concurrent request between the check and the import, in which case that row fails with the same message.

`400` for a file-level problem (empty body, no `url` column, more than 500 rows, an unclosed quote, a limit on folders) with nothing created, `413` when the body is over 1 MB.

```bash
curl -X POST "localhost:4000/api/links/bulk?dryRun=true&folder=Imports" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: text/csv' --data-binary @links.csv
```

## Folders and tags (auth required)

Folder object: `{ "id": "3", "name": "Campaigns", "createdAt": "...", "linkCount": 12 }` (`linkCount` is included in all folder responses).

### `GET /api/folders`
Your folders sorted by name, with `linkCount`.

### `POST /api/folders`
Body: `{ "name" }` (1-50 characters, unique per user ignoring case, max 200 folders per user). `201` → folder. `400` validation, `409` name in use.

### `PATCH /api/folders/:id`
Body: `{ "name" }`. `200` → folder. `404` if not yours, `409` name in use.

### `DELETE /api/folders/:id`
`204`. The folder's links are kept and become unfiled.

### `GET /api/tags`
`[{ "name": "launch", "linkCount": 12 }]`, most used first. Tags exist only on links; there is nothing to create or delete here. To rename or remove a tag, `PATCH` the links.


### `PATCH /api/links/:id`
Any of: `isActive` (bool), `tags` (array; replaces all tags, `[]` clears them), `folderId` (id, or `null` to take the link out of its folder), `url`, `expiresAt` (date, or `null` to clear), `password` (string to set, `null`/`""` to remove), `maxClicks` (integer, or `null` to remove the limit), `resetClicks` (`true` zeroes `usedClicks`, which re-arms an exhausted link).
Changing `maxClicks` keeps `usedClicks`: raising 5 to 10 after 5 visits leaves 5 more. Removing the limit also zeroes `usedClicks`. `404` if not yours.

`oneTime` (the pre-0.4 field) is still accepted on input: `true` means `maxClicks: 1` and re-arms the link, `false` removes the limit. It is no longer returned; read `maxClicks` and `usedClicks` instead.

### `DELETE /api/links/:id`
`204`. Deletes the link and its clicks.

**When changes reach visitors.** The redirect caches link lookups in memory (see [ARCHITECTURE.md](ARCHITECTURE.md#slug-cache)). A successful `PATCH` or `DELETE` clears the cached entry on the server that handled it, so pausing, re-pointing, changing the password or deleting a link applies to the next visit. When several server instances run, each has its own cache and the others keep serving the previous version for up to `SLUG_CACHE_TTL_SECONDS` (60 by default; `0` disables the cache). `expiresAt` is always enforced on time, even for a cached link.

## Stats (auth required)

Query params: `range` = `24h` (hourly buckets), `7d`, `30d`, `90d` (daily; default `7d`); `tz` = IANA zone (default `UTC`).

### `GET /api/stats/links/:id`
### `GET /api/stats/overview`
Response (overview adds `totalLinks` and `topLinks`; link stats add `link`):

```json
{
  "range": "7d",
  "timeZone": "Asia/Kolkata",
  "totalClicks": 120,
  "uniqueVisitors": 87,
  "timeseries": [{ "bucket": "2026-10-14T00:00:00", "clicks": 4 }],
  "referrers": [{ "name": "Twitter / X", "clicks": 30 }],
  "devices": [{ "name": "mobile", "clicks": 70 }],
  "browsers": [{ "name": "Chrome", "clicks": 60 }],
  "operatingSystems": [{ "name": "Android", "clicks": 50 }],
  "countries": [{ "name": "IN", "clicks": 90 }]
}
```

`timeseries` is zero-filled. `referrers` is grouped under friendly names; empty referrer means direct, and visits that came through a QR code (`?s=qr`, see below) are grouped as `QR code` regardless of referrer. `countries` needs a CDN header (see DEPLOYMENT.md).

## Public redirect

### `GET /:slug`
| Situation | Response |
|---|---|
| Plain link | `302` to the target, click logged |
| Unknown or paused | `404` HTML page |
| Expired | `410` HTML page |
| Click limit reached (including a used one-time link) | `410` HTML page |
| Link with a click limit, normal browser | one visit atomically consumed, then `302` |
| Link with a click limit, bot/preview or `HEAD` | `200` neutral page, **not** consumed |
| Password link | `200` password form (nothing consumed or logged) |

Lookups of links without a click limit may be served from the in-memory slug cache, so a response can reflect a `PATCH`/`DELETE` made on another server instance only after the TTL (see above). Click-limited links always read the database. Redirect responses are never cached by browsers or proxies (`302` with `Cache-Control: no-store`).

`?s=qr` marks the visit as a QR scan. The dashboard's QR codes encode `/<slug>?s=qr`; any other value of `s` is ignored. The tag is kept through the password form.

### `POST /:slug`
Password form submit, `application/x-www-form-urlencoded` with field `password`.
`303` to the target on success (and consumes one visit of a click-limited link); `401` page on a wrong password; `429` page after 5 wrong attempts (`Retry-After: 900`).

## Other

`GET /health` → `{ "status": "ok" }`.

## Examples

```bash
TOKEN=$(curl -s -X POST localhost:4000/api/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"password1"}' | jq -r .token)

curl -X POST localhost:4000/api/links -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","slug":"demo","password":"hunter22","maxClicks":3}'

curl -i -X POST -d password=hunter22 localhost:4000/demo     # 303 -> https://example.com
```
