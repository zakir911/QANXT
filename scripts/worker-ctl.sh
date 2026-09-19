#!/usr/bin/env bash
# Starts or stops a browser worker for local development and verification.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE="${ROOT}/.aira-worker.pid"
LOGFILE="${LOGFILE:-/tmp/aira-worker.log}"

start() {
  if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "Worker already running (pid $(cat "$PIDFILE"))"; return 0
  fi
  set -a; [[ -f "${ROOT}/.env" ]] && . "${ROOT}/.env"; set +a
  ( cd "${ROOT}/apps/browser-worker" && npx tsc -p tsconfig.json )
  nohup node "${ROOT}/apps/browser-worker/dist/index.js" > "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  echo "Worker starting (pid $(cat "$PIDFILE")), logs: $LOGFILE"
}

stop() {
  if [[ -f "$PIDFILE" ]]; then
    local pid; pid="$(cat "$PIDFILE")"
    kill -TERM "$pid" 2>/dev/null || true
    sleep 3
    kill -KILL "$pid" 2>/dev/null || true
    rm -f "$PIDFILE"
    echo "Worker stopped"
  else
    echo "No pid file; worker not started by this script"
  fi
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  *) echo "usage: $0 {start|stop|restart}" >&2; exit 2 ;;
esac
