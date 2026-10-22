#!/usr/bin/env bash
# Dump the LinkPulse database to a compressed file you can restore with scripts/restore.sh.
#
#   scripts/backup.sh                    writes backups/linkpulse-YYYYMMDDTHHMMSSZ.dump
#   BACKUP_KEEP_DAYS=14 scripts/backup.sh   also deletes dumps in that folder older than 14 days
#
# Connection: BACKUP_DATABASE_URL, else MIGRATE_DATABASE_URL, else DATABASE_URL (from the environment or
# server/.env). On Supabase use the Session pooler or Direct string, NOT the Transaction pooler: pg_dump
# needs a session-level connection. Needs pg_dump 15 or newer on the PATH (16+ for a Supabase 17 database).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${BACKUP_DATABASE_URL:-}${MIGRATE_DATABASE_URL:-}${DATABASE_URL:-}" && -f "$root/.env" ]]; then
  set -a; . "$root/.env"; set +a
fi
url="${BACKUP_DATABASE_URL:-${MIGRATE_DATABASE_URL:-${DATABASE_URL:-}}}"
[[ -n "$url" ]] || { echo "No database URL: set BACKUP_DATABASE_URL, MIGRATE_DATABASE_URL or DATABASE_URL" >&2; exit 1; }
if [[ "$url" == *":6543/"* ]]; then
  echo "Refusing: port 6543 is Supabase's Transaction pooler, which pg_dump cannot use. Use the Session pooler (5432) or Direct string." >&2
  exit 1
fi
command -v pg_dump >/dev/null || { echo "pg_dump not found. Install the PostgreSQL client tools." >&2; exit 1; }

dir="${BACKUP_DIR:-$root/backups}"
mkdir -p "$dir"
chmod 700 "$dir"
out="$dir/linkpulse-$(date -u +%Y%m%dT%H%M%SZ).dump"
tmp="$out.partial"
trap 'rm -f "$tmp"' EXIT

# Only the public schema: that is all of LinkPulse's data. Supabase's own schemas (auth, storage, ...) are
# managed by Supabase and must not be dumped into, or restored over, another project.
# --no-owner/--no-acl: roles differ between Postgres servers, so ownership is not carried over.
umask 077
pg_dump "$url" --schema=public --format=custom --compress=6 --no-owner --no-acl --file="$tmp"

# A dump that cannot be listed is not a backup
pg_restore --list "$tmp" >/dev/null
mv "$tmp" "$out"
trap - EXIT
echo "Backup written: $out ($(du -h "$out" | cut -f1))"

if [[ -n "${BACKUP_KEEP_DAYS:-}" ]]; then
  find "$dir" -maxdepth 1 -name 'linkpulse-*.dump' -mtime "+$BACKUP_KEEP_DAYS" -print -delete
fi
