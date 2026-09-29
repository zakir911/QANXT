#!/usr/bin/env bash
# Starts or stops the web console's dev server.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE="${ROOT}/.qanxt-console.pid"
LOGFILE="${LOGFILE:-/tmp/qanxt-console.log}"
CONSOLE_DIR="${ROOT}/apps/web-console"

# A process's working directory, or empty when it cannot be read. /proc on Linux, lsof
# on macOS. Empty is not "no match" — callers treat an unreadable cwd as unknown and
# fall back rather than refusing to start.
console_cwd() {
  if [ -r "/proc/$1/cwd" ]; then
    readlink "/proc/$1/cwd" 2>/dev/null
  elif command -v lsof >/dev/null 2>&1; then
    lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
  fi
}

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
      && setsid --fork node_modules/.bin/vite --host 127.0.0.1 --port 5173 --strictPort \
           < /dev/null > "$LOGFILE" 2>&1 )
    # --fork matters. Plain `setsid cmd &` execs in place, so the dev server stays this
    # script's own child; the script then sits in wait() and never exits, and a caller that
    # pipes our output waits for a pipe we never close. With --fork the intermediate exits
    # immediately and the server is reparented away from us, so $! is no longer ours to
    # read — the pid comes from the process itself.
    # --fork means the server appears a moment after setsid returns, so poll briefly
    # rather than reading once. Reading once wrote an empty pid file, which start reports
    # as "(pid )" and which leaves stop with nothing to kill.
    # --strictPort because this script promises 5173. Without it vite takes the next free
    # port when 5173 is busy — which happens on a quick stop/start while the old socket is
    # still closing — and the script goes on to announce a console on 5173 that is really on
    # 5174. A start that cannot keep its promise should fail and say so.
    # The command line carries no repository, so a vite from another checkout on this
    # port matches the same pattern. Adopting it would mean stop killing somebody else's
    # dev server. Each candidate is confirmed by its working directory instead.
    pid=""
    for _ in $(seq 1 50); do
      for _c in $(pgrep -f 'vite/bin/vite\.js --host 127\.0\.0\.1 --port 5173' 2>/dev/null); do
        [ "$(console_cwd "$_c")" = "$CONSOLE_DIR" ] && { pid="$_c"; break; }
      done
      [ -n "$pid" ] && break
      sleep 0.1
    done
    [ -n "$pid" ] || { echo "Console did not start; see $LOGFILE" >&2; exit 1; }
    printf '%s\n' "$pid" > "$PIDFILE"
    # "Console on ..." rather than "starting": when the pid file was lost while the server
    # kept running, the loop below re-adopts that server and nothing was started. The port
    # and the pid are true either way; "starting" would not be.
    echo "Console on http://127.0.0.1:5173 (pid $(cat "$PIDFILE"))"
    ;;
  stop)
    if [[ -f "$PIDFILE" ]]; then
      _p="$(cat "$PIDFILE")"
      # Confirm before killing. A pid file outlives the process it names, and pids are
      # reused, so the recorded number alone is not evidence that this is still our server.
      if [ -n "$_p" ] && [ "$(console_cwd "$_p")" = "$CONSOLE_DIR" ]; then
        kill -TERM "$_p" 2>/dev/null || true
        rm -f "$PIDFILE"; echo "Console stopped"
      else
        rm -f "$PIDFILE"
        echo "Not running (stale pid file removed; pid $_p is not this repository's console)"
      fi
    else
      echo "Not running"
    fi
    ;;
  *) echo "usage: $0 {start|stop}" >&2; exit 2 ;;
esac
