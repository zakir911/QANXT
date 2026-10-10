#!/usr/bin/env bash
# Runs the whole local stack and waits, stopping everything cleanly on Ctrl-C.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "No .env found. Run 'make setup' first." >&2
  exit 1
fi

stop_all() {
  echo
  echo "Stopping…"
  bash scripts/console-ctl.sh stop   >/dev/null 2>&1 || true
  bash scripts/worker-ctl.sh stop    >/dev/null 2>&1 || true
  bash scripts/demo-bank-ctl.sh stop >/dev/null 2>&1 || true
  bash scripts/api-ctl.sh stop       >/dev/null 2>&1 || true
  echo "Stopped. PostgreSQL and Redis are left running; stop them with:"
  echo "  bash scripts/services-ctl.sh stop"
}
trap stop_all EXIT INT TERM

# The workspace libraries are build output and `dist/` is gitignored, so a `git pull` that
# changes packages/shared-types leaves every consumer compiling against the previous
# version. That surfaces as the worker failing tsc with "Property X does not exist on type
# Y" for a property that plainly does exist in the source — which sends the reader looking
# for the bug in the wrong file.
#
# `pnpm install` only links the package and does not build it, and `make setup` is the only
# thing that ever did. Nobody runs setup after a pull. Doing it here costs a second or two
# when nothing changed and removes a whole class of confusing failure.
echo "Building the workspace libraries…"
if ! pnpm --filter "./packages/**" build; then
  echo "The workspace libraries did not build. Everything downstream compiles against" >&2
  echo "their previous output, so fix this before reading any error the worker reports." >&2
  exit 1
fi

bash scripts/services-ctl.sh --with-database
bash scripts/api-ctl.sh start
bash scripts/api-ctl.sh wait
bash scripts/demo-bank-ctl.sh start
bash scripts/worker-ctl.sh start
bash scripts/console-ctl.sh start

cat <<'READY'

  Console    http://localhost:5173
  API docs   http://localhost:5080/swagger
  API health http://localhost:5080/health
  Demo bank  http://localhost:4200

  The API serves no page at http://localhost:5080/ — it is an API, and / is a 404.
  Use the two links above.

  Logs: /tmp/qanxt-api.log, /tmp/qanxt-worker.log, /tmp/qanxt-console.log, /tmp/qanxt-demo-bank.log

  Ctrl-C to stop.
READY

# Wait for a signal rather than spinning.
while true; do sleep 3600 & wait $!; done
