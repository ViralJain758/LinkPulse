# Changelog

## Unreleased

- **Folders:** group links into folders (one per link, flat, per user). New endpoints `GET/POST /api/folders` and `PATCH/DELETE /api/folders/:id`. Names are unique per user ignoring case, up to 50 characters, at most 200 folders per user. Deleting a folder keeps its links, which become unfiled.
- **Tags:** links carry up to 10 free-form tags (stored lowercase, up to 32 characters). `POST`/`PATCH /api/links` accept `tags` (array; `PATCH` replaces them) and `folderId` (`null` removes the link from its folder). `GET /api/tags` lists your tags with counts.
- **Filtering and search:** `GET /api/links` accepts `folder` (id or `none`), `tag` and `q` (matches slug, destination or tag). The Links page has a folder filter, tag chips and a search box.
- **Bulk create from CSV:** `POST /api/links/bulk` (`Content-Type: text/csv`) creates up to 500 links per request. Columns: `url` (required), `slug`, `tags`, `folder`, `expires_at`, `password`, `max_clicks`; header names are matched loosely and comma, semicolon or tab delimiters are detected. Valid rows are created, invalid ones are reported by row number. `?dryRun=true` validates without creating, `?folder=` and `?tags=` add defaults. The dashboard has an **Import CSV** dialog with a preview and a downloadable results file that includes the new short URLs.
- **Schema:** adds the `folders` table and `links.folder_id` and `links.tags` (with indexes). Re-run `server/db/schema.sql`; existing links are untouched and start with no tags and no folder.
- **API:** link objects now include `tags`, `folderId` and `folderName`. Malformed JSON and oversized request bodies now return `400`/`413` with a message instead of `500`.
- **Tests:** unit tests for the CSV reader, the bulk import mapping and the link field validators.
- **Docs:** repository links point to https://github.com/ViralJain758/LinkPulse.
