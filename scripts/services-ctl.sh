#!/usr/bin/env bash
# Ensures PostgreSQL and Redis are running for local development.
#
# The Docker Compose stack owns these in a normal setup; this script covers the case
# where they run directly on the host (CI sandboxes, constrained environments, and
# anybody following Path B of docs/installation.md).
#
# Three host shapes have to work, and they disagree about who owns the cluster:
#
#   Debian/Ubuntu   the cluster is managed by pg_ctlcluster and owned by a 'postgres'
#                   OS account, reached with sudo (or su when already root).
#   Other Linux     a plain pg_ctl against PGDATA, same 'postgres' account.
#   macOS/Homebrew  `brew services` runs the cluster and the installing user IS a
#                   superuser, so there is no 'postgres' account to switch to and a
#                   direct connection is the only thing that works.
#
# This used to assume Debian and root throughout: pg_ctlcluster, a Linux PGDATA path,
# and `su postgres`. That works in the project's container and nowhere else — not on
# macOS, which has no postgres account, and not on an ordinary Linux workstation, where
# a non-root user running `su` is asked for a password nobody has.
set -euo pipefail

ensure_postgres() {
  if pg_isready -q 2>/dev/null; then echo "postgres: already running"; return 0; fi

  if command -v brew >/dev/null 2>&1 && brew list --versions postgresql@16 >/dev/null 2>&1; then
    brew services start postgresql@16 >/dev/null 2>&1 || true
  elif command -v pg_ctlcluster >/dev/null 2>&1; then
    pg_ctlcluster 16 main start 2>/dev/null || true
  elif command -v pg_ctl >/dev/null 2>&1; then
    pg_ctl -D "${PGDATA:-/var/lib/postgresql/data}" -l /tmp/postgres.log start || true
  fi

  for _ in $(seq 1 30); do pg_isready -q 2>/dev/null && { echo "postgres: started"; return 0; }; sleep 1; done
  echo "postgres: failed to start" >&2
  echo "  Start it yourself and re-run: brew services start postgresql@16 (macOS)," >&2
  echo "  sudo pg_ctlcluster 16 main start (Debian/Ubuntu)." >&2
  return 1
}

ensure_redis() {
  if redis-cli ping >/dev/null 2>&1; then echo "redis: already running"; return 0; fi
  redis-server --daemonize yes --port "${REDIS_PORT:-6379}" >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do redis-cli ping >/dev/null 2>&1 && { echo "redis: started"; return 0; }; sleep 1; done
  echo "redis: failed to start" >&2; return 1
}

# How this host lets us act as a PostgreSQL superuser. Decided once, by trying rather
# than by guessing the operating system: a Linux box where the current user happens to
# be a superuser should take the direct path too.
PG_ADMIN_MODE=""
resolve_pg_admin() {
  if psql -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
    PG_ADMIN_MODE=direct
  elif id postgres >/dev/null 2>&1 && [ "$(id -u)" -eq 0 ]; then
    PG_ADMIN_MODE=su
  elif id postgres >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1 \
       && sudo -n true 2>/dev/null; then
    PG_ADMIN_MODE=sudo
  else
    echo "database: cannot reach PostgreSQL as a superuser." >&2
    echo "  Tried: a direct connection as '$(id -un)', and the 'postgres' account." >&2
    echo "  Create the role and database yourself, then re-run:" >&2
    echo "    psql -d postgres -c \"CREATE ROLE qanxt LOGIN PASSWORD 'qanxt' CREATEDB;\"" >&2
    echo "    createdb -O qanxt qanxt" >&2
    return 1
  fi
}

# Runs one SQL statement as a superuser. The statement goes through a file rather than
# an argument because the su form would otherwise need its quoting escaped twice, and a
# CREATE ROLE containing a quoted password is exactly where that goes wrong.
pg_admin_sql() {
  local sql="$1" file status
  file="$(mktemp)"
  printf '%s\n' "$sql" > "$file"
  chmod 644 "$file"   # the postgres account has to be able to read it
  status=0
  case "$PG_ADMIN_MODE" in
    direct) psql -d postgres -tAf "$file" || status=$? ;;
    su)     su postgres -c "psql -d postgres -tAf '$file'" || status=$? ;;
    sudo)   sudo -u postgres psql -d postgres -tAf "$file" || status=$? ;;
    *)      status=1 ;;
  esac
  rm -f "$file"
  return $status
}

ensure_database() {
  resolve_pg_admin || return 1

  if ! pg_admin_sql "SELECT 1 FROM pg_roles WHERE rolname='qanxt'" 2>/dev/null | grep -q 1; then
    pg_admin_sql "CREATE ROLE qanxt LOGIN PASSWORD 'qanxt' CREATEDB;" >/dev/null
    echo "database: created role 'qanxt'"
  fi
  if ! pg_admin_sql "SELECT 1 FROM pg_database WHERE datname='qanxt'" 2>/dev/null | grep -q 1; then
    pg_admin_sql "CREATE DATABASE qanxt OWNER qanxt;" >/dev/null
    echo "database: created database 'qanxt'"
  fi
}

ensure_postgres
ensure_redis
[[ "${1:-}" == "--with-database" ]] && ensure_database
echo "services ready"
