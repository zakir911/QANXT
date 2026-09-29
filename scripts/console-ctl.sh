#!/usr/bin/env bash
# Starts or stops the web console's dev server.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE="${ROOT}/.qanxt-console.pid"
LOGFILE="${LOGFILE:-/tmp/qanxt-console.log}"

case "${1:-start}" in
  start)
    if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "Console already running (pid $(cat "$PIDFILE"))"; exit 0
    fi
    set -a; [[ -f "${ROOT}/.env" ]] && . "${ROOT}/.env"; set +a
    # Vite's own binary rather than npx. `npx vite` leaves an `npm exec` wrapper between
    # this script and the dev server: $! then records the wrapper rather than vite, the
    # wrapper stays a child of this script, and a caller that pipes our output — as
    # `console-ctl.sh start | tail -1` does — waits for a pipe the wrapper never closes.
    # The console starts either way; the command that started it is what hangs.
    # The dev server goes into its own session so it holds nothing of this script's.
    ( cd "${ROOT}/apps/web-console" \
      && setsid --fork node_modules/.bin/vite --host 127.0.0.1 --port 5173 \
           < /dev/null > "$LOGFILE" 2>&1 )
    # --fork matters. Plain `setsid cmd &` execs in place, so the dev server stays this
    # script's own child; the script then sits in wait() and never exits, and a caller that
    # pipes our output waits for a pipe we never close. With --fork the intermediate exits
    # immediately and the server is reparented away from us, so $! is no longer ours to
    # read — the pid comes from the process itself.
    # --fork means the server appears a moment after setsid returns, so poll briefly
    # rather than reading once. Reading once wrote an empty pid file, which start reports
    # as "(pid )" and which leaves stop with nothing to kill.
    pid=""
    for _ in $(seq 1 50); do
      pid="$(pgrep -n -f 'vite/bin/vite\.js --host 127\.0\.0\.1 --port 5173' || true)"
      [ -n "$pid" ] && break
      sleep 0.1
    done
    [ -n "$pid" ] || { echo "Console did not start; see $LOGFILE" >&2; exit 1; }
    printf '%s\n' "$pid" > "$PIDFILE"
    echo "Console starting (pid $(cat "$PIDFILE")) on http://127.0.0.1:5173"
    ;;
  stop)
    [[ -f "$PIDFILE" ]] && { kill -TERM "$(cat "$PIDFILE")" 2>/dev/null || true; rm -f "$PIDFILE"; echo "Console stopped"; } || echo "Not running"
    ;;
  *) echo "usage: $0 {start|stop}" >&2; exit 2 ;;
esac
