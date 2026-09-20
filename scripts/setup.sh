#!/usr/bin/env bash
# Prepares a fresh clone for development: checks the tools, installs dependencies,
# starts the local services and migrates the database.
#
# Every prerequisite is checked up front and reported together, because discovering three
# missing tools one failed command at a time is a miserable first five minutes.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

missing=()
need() {
  command -v "$1" >/dev/null 2>&1 || missing+=("$1 — $2")
}

need dotnet     "the .NET 8 SDK (https://dotnet.microsoft.com/download)"
need node       "Node 22 or newer (https://nodejs.org)"
need pnpm       "pnpm 10 or newer (npm install -g pnpm, or corepack enable)"
need psql       "the PostgreSQL client (for migrations and database resets)"

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Missing prerequisites:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "Creating .env from .env.example…"
  cp .env.example .env
  # Generated rather than shipped: a secret that arrives in a repository is not a secret,
  # and a placeholder that works is a placeholder that reaches production.
  jwt="$(openssl rand -base64 48 | tr -d '\n')"
  key="$(openssl rand -base64 32 | tr -d '\n')"
  worker="$(openssl rand -base64 32 | tr -d '\n')"
  tmp="$(mktemp)"
  sed -e "s|^JWT_SECRET=.*|JWT_SECRET=${jwt}|" \
      -e "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=${key}|" \
      -e "s|^WORKER_TOKEN=.*|WORKER_TOKEN=${worker}|" .env > "$tmp"
  mv "$tmp" .env
  chmod 600 .env
  echo "Generated JWT_SECRET, ENCRYPTION_KEY and WORKER_TOKEN into .env."
else
  echo ".env already exists; leaving it alone."
fi

echo "Installing Node dependencies…"
pnpm install

echo "Restoring .NET dependencies…"
dotnet restore apps/api/Aira.sln

echo "Starting PostgreSQL and Redis…"
bash scripts/services-ctl.sh --with-database

echo "Applying migrations…"
bash scripts/migrate.sh

cat <<'DONE'

Setup complete. Next:

  make dev     run the whole stack (API, worker, console, demo bank)
  make test    run every test suite

The console is served on http://localhost:5173 and the API on http://localhost:5080.
DONE
