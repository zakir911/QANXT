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

# The workspace libraries have to exist as built output before anything that imports
# them will typecheck. `@qa-nxt/shared-types` resolves to ./dist/index.d.ts, dist/ is
# gitignored, and `pnpm install` only links the package — it does not build it. On a
# fresh clone that left `make dev` failing at the browser worker's tsc with 97 errors,
# every one of them cascading from "Cannot find module '@qa-nxt/shared-types'".
#
# Only packages/, not the apps: each app builds itself when it starts, and security-engine
# ships its source directly, so pnpm skips it for having no build script.
echo "Building the workspace libraries…"
pnpm --filter "./packages/**" build

# pnpm install brings in the Playwright client, not the browser it drives: the binaries are
# a separate download. Without this, setup finished successfully and the first discovery run
# died with "Executable doesn't exist at …" — the failure a user hit on a fresh macOS clone,
# with nothing in setup to prevent it and (until this branch) nothing surfacing the reason.
#
# Called directly rather than through `pnpm --filter … exec`, which returns exit status 0
# whether the download succeeded, failed on every mirror, or matched no package at all.
# A step that cannot fail is not a step.
echo "Downloading the browser the worker drives…"
if [[ -n "${PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:-}" ]]; then
  echo "  Skipped: PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set."
elif [[ ! -x apps/browser-worker/node_modules/.bin/playwright ]]; then
  echo "  Skipped: Playwright is not installed in apps/browser-worker." >&2
else
  if ( cd apps/browser-worker && ./node_modules/.bin/playwright install chromium ); then
    echo "  Chromium is installed."
  else
    # Not fatal. Everything else setup does is still worth having, and the rest of the
    # platform works without a browser — but say plainly what will not work, rather than
    # printing "Setup complete" over a worker that cannot run a single crawl.
    cat >&2 <<'BROWSER'

  The browser download failed. Setup is otherwise complete, but discovery and test
  execution need it and will fail until it succeeds. Retry with:

      cd apps/browser-worker && ./node_modules/.bin/playwright install chromium

  On Linux you may also need its system libraries:

      cd apps/browser-worker && sudo ./node_modules/.bin/playwright install-deps chromium

BROWSER
  fi
fi

echo "Restoring .NET dependencies…"
dotnet restore apps/api/QaNxt.sln

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
