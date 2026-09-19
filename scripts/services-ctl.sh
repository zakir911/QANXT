#!/usr/bin/env bash
# Ensures PostgreSQL and Redis are running for local development.
#
# The Docker Compose stack owns these in a normal setup; this script covers the case
# where they run directly on the host (CI sandboxes, constrained environments).
set -euo pipefail

ensure_postgres() {
  if pg_isready -q 2>/dev/null; then echo "postgres: already running"; return 0; fi
  if command -v pg_ctlcluster >/dev/null 2>&1; then
    pg_ctlcluster 16 main start 2>/dev/null || true
  elif command -v pg_ctl >/dev/null 2>&1; then
    pg_ctl -D "${PGDATA:-/var/lib/postgresql/data}" -l /tmp/postgres.log start || true
  fi
  for _ in $(seq 1 30); do pg_isready -q 2>/dev/null && { echo "postgres: started"; return 0; }; sleep 1; done
  echo "postgres: failed to start" >&2; return 1
}

ensure_redis() {
  if redis-cli ping >/dev/null 2>&1; then echo "redis: already running"; return 0; fi
  redis-server --daemonize yes --port "${REDIS_PORT:-6379}" >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do redis-cli ping >/dev/null 2>&1 && { echo "redis: started"; return 0; }; sleep 1; done
  echo "redis: failed to start" >&2; return 1
}

ensure_database() {
  if ! su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='aira'\"" 2>/dev/null | grep -q 1; then
    su postgres -c "psql -c \"CREATE ROLE aira LOGIN PASSWORD 'aira' CREATEDB;\"" >/dev/null
    echo "database: created role 'aira'"
  fi
  if ! su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='aira'\"" 2>/dev/null | grep -q 1; then
    su postgres -c "createdb -O aira aira" >/dev/null
    echo "database: created database 'aira'"
  fi
}

ensure_postgres
ensure_redis
[[ "${1:-}" == "--with-database" ]] && ensure_database
echo "services ready"
