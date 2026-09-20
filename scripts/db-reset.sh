#!/usr/bin/env bash
# Drops the local database, recreates it and re-applies every migration.
#
# Destructive by design, so it asks first unless AIRA_ASSUME_YES is set. It refuses to run
# against anything that does not look like a local database, because the only thing worse
# than losing a dev database is losing someone else's.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

set -a; [[ -f .env ]] && . .env; set +a

url="${DATABASE_URL:-Host=localhost;Port=5432;Database=aira;Username=aira;Password=aira}"
host="$(sed -n 's/.*Host=\([^;]*\).*/\1/p' <<<"$url")"
name="$(sed -n 's/.*Database=\([^;]*\).*/\1/p' <<<"$url")"
user="$(sed -n 's/.*Username=\([^;]*\).*/\1/p' <<<"$url")"
pass="$(sed -n 's/.*Password=\([^;]*\).*/\1/p' <<<"$url")"

case "$host" in
  localhost|127.0.0.1|::1|"") ;;
  *)
    echo "Refusing to reset '$name' on '$host': this script is for local databases only." >&2
    exit 1
    ;;
esac

if [[ "${AIRA_ASSUME_YES:-}" != "1" ]]; then
  read -r -p "This deletes everything in '$name' on '$host'. Type the database name to confirm: " reply
  [[ "$reply" == "$name" ]] || { echo "Cancelled."; exit 1; }
fi

export PGPASSWORD="$pass"
psql -h "$host" -U "$user" -d postgres -c "DROP DATABASE IF EXISTS \"$name\" WITH (FORCE)"
psql -h "$host" -U "$user" -d postgres -c "CREATE DATABASE \"$name\""

bash "$ROOT/scripts/migrate.sh"
echo "Database '$name' reset."
