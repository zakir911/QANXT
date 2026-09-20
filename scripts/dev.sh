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

bash scripts/services-ctl.sh --with-database
bash scripts/api-ctl.sh start
bash scripts/api-ctl.sh wait
bash scripts/demo-bank-ctl.sh start
bash scripts/worker-ctl.sh start
bash scripts/console-ctl.sh start

cat <<'READY'

  Console    http://localhost:5173
  API        http://localhost:5080
  API docs   http://localhost:5080/swagger
  Demo bank  http://localhost:4200

  Logs: /tmp/aira-api.log, /tmp/aira-worker.log, /tmp/aira-console.log, /tmp/aira-demo-bank.log

  Ctrl-C to stop.
READY

# Wait for a signal rather than spinning.
while true; do sleep 3600 & wait $!; done
