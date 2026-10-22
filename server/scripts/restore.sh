#!/usr/bin/env bash
# Restore a dump made by scripts/backup.sh into a database.
#
#   scripts/restore.sh backups/linkpulse-20261022T030000Z.dump postgres://user:pass@host:5432/dbname
#
# The target is always given on the command line, never taken from .env, so a restore cannot hit the live
# database by accident. Restore into a NEW, empty database first, check it (see docs/OPERATIONS.md), then
# point the server at it. If the target already has LinkPulse tables, re-run with --replace to drop and
# recreate them; that destroys what is there.
# On Supabase use the Session pooler or Direct string for the target (not the Transaction pooler).
set -euo pipefail

replace=0
args=()
for a in "$@"; do [[ "$a" == "--replace" ]] && replace=1 || args+=("$a"); done
[[ ${#args[@]} -eq 2 ]] || { echo "Usage: restore.sh [--replace] <dump file> <target database URL>" >&2; exit 2; }
file="${args[0]}"; target="${args[1]}"
[[ -f "$file" ]] || { echo "No such file: $file" >&2; exit 1; }
if [[ "$target" == *":6543/"* ]]; then
  echo "Refusing: port 6543 is Supabase's Transaction pooler. Use the Session pooler (5432) or Direct string." >&2
  exit 1
fi
command -v pg_restore >/dev/null || { echo "pg_restore not found. Install the PostgreSQL client tools." >&2; exit 1; }
pg_restore --list "$file" >/dev/null || { echo "Not a readable dump: $file" >&2; exit 1; }

existing="$(psql "$target" -Atqc "select count(*) from information_schema.tables where table_schema='public'")"
if [[ "$existing" != "0" && $replace -eq 0 ]]; then
  echo "The target already has $existing table(s) in the public schema. Restore into an empty database, or pass --replace to overwrite them." >&2
  exit 1
fi

flags=(--no-owner --no-acl --exit-on-error --single-transaction --schema=public)
[[ $replace -eq 1 ]] && flags+=(--clean --if-exists)
pg_restore "${flags[@]}" --dbname="$target" "$file"
echo "Restored $file"
echo "Next: check the data (docs/OPERATIONS.md), then run 'npm run migrate' to apply any newer migrations."
