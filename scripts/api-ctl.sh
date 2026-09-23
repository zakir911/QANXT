#!/usr/bin/env bash
# Starts or stops the control-plane API for local development and verification.
# Keeps a pid file so stopping never relies on pattern-matching process names.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE="${ROOT}/.aira-api.pid"
LOGFILE="${LOGFILE:-/tmp/aira-api.log}"

start() {
  if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "API already running (pid $(cat "$PIDFILE"))"; return 0
  fi
  set -a; [[ -f "${ROOT}/.env" ]] && . "${ROOT}/.env"; set +a
  export ASPNETCORE_ENVIRONMENT="${ASPNETCORE_ENVIRONMENT:-Development}"
  export ASPNETCORE_URLS="${API_URL:-http://localhost:5080}"
  export DOTNET_NOLOGO=1
  # Fault injection for the model provider, so the AI-failure golden suite can arm a
  # simulated timeout, malformed reply or schema violation and watch what the platform does.
  # This script starts a local development API only; it is off in every shipped
  # configuration, and the switch refuses to arm when it is off. Override by exporting
  # Ai__FaultInjection__Enabled=false before calling this.
  export Ai__FaultInjection__Enabled="${Ai__FaultInjection__Enabled:-true}"
  nohup dotnet run --project "${ROOT}/apps/api/src/Aira.Api" --no-launch-profile > "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  echo "API starting (pid $(cat "$PIDFILE")), logs: $LOGFILE"
}

stop() {
  if [[ -f "$PIDFILE" ]]; then
    local pid; pid="$(cat "$PIDFILE")"
    # dotnet run spawns the app as a child; stop the whole group.
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
    sleep 2
    pkill -KILL -P "$pid" 2>/dev/null || true
    kill -KILL "$pid" 2>/dev/null || true
    rm -f "$PIDFILE"
    echo "API stopped"
  else
    echo "No pid file; API not started by this script"
  fi
}

wait_ready() {
  local url="${API_URL:-http://localhost:5080}/health"
  for _ in $(seq 1 60); do
    if curl -fsS "$url" >/dev/null 2>&1; then echo "API ready"; return 0; fi
    sleep 1
  done
  echo "API did not become ready in 60s; last log lines:" >&2
  tail -20 "$LOGFILE" >&2
  return 1
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  wait) wait_ready ;;
  *) echo "usage: $0 {start|stop|restart|wait}" >&2; exit 2 ;;
esac
