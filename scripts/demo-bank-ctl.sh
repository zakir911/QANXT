#!/usr/bin/env bash
# Starts or stops the demo banking application.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE="${ROOT}/.qanxt-demo-bank.pid"
LOGFILE="${LOGFILE:-/tmp/qanxt-demo-bank.log}"

case "${1:-start}" in
  start)
    if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "Demo bank already running (pid $(cat "$PIDFILE"))"; exit 0
    fi
    set -a; [[ -f "${ROOT}/.env" ]] && . "${ROOT}/.env"; set +a
    nohup node "${ROOT}/samples/demo-bank/src/server.js" > "$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
    echo "Demo bank starting (pid $(cat "$PIDFILE")) on port ${DEMO_BANK_PORT:-4200}"
    ;;
  stop)
    [[ -f "$PIDFILE" ]] && { kill -TERM "$(cat "$PIDFILE")" 2>/dev/null || true; rm -f "$PIDFILE"; echo "Demo bank stopped"; } || echo "Not running"
    ;;
  *) echo "usage: $0 {start|stop}" >&2; exit 2 ;;
esac
