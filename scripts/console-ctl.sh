#!/usr/bin/env bash
# Starts or stops the web console's dev server.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE="${ROOT}/.aira-console.pid"
LOGFILE="${LOGFILE:-/tmp/aira-console.log}"

case "${1:-start}" in
  start)
    if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "Console already running (pid $(cat "$PIDFILE"))"; exit 0
    fi
    set -a; [[ -f "${ROOT}/.env" ]] && . "${ROOT}/.env"; set +a
    ( cd "${ROOT}/apps/web-console" && nohup npx vite --host 127.0.0.1 --port 5173 > "$LOGFILE" 2>&1 & echo $! > "$PIDFILE" )
    echo "Console starting (pid $(cat "$PIDFILE")) on http://127.0.0.1:5173"
    ;;
  stop)
    [[ -f "$PIDFILE" ]] && { kill -TERM "$(cat "$PIDFILE")" 2>/dev/null || true; rm -f "$PIDFILE"; echo "Console stopped"; } || echo "Not running"
    ;;
  *) echo "usage: $0 {start|stop}" >&2; exit 2 ;;
esac
