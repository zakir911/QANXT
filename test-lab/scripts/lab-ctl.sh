#!/usr/bin/env bash
# Starts, stops and inspects the test lab.
#
# Every application is a plain Node process bound to the loopback interface. They are kept
# out of Docker on purpose: the lab has to be startable by one command on a developer's
# machine, and a verification run should not depend on an image registry being reachable.
set -uo pipefail
LAB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$LAB/.." && pwd)"
RUN="${TMPDIR:-/tmp}/aira-test-lab"
mkdir -p "$RUN"

# name | directory | port
APPS=(
  "banking-app|banking-app|4300"
  "ecommerce-app|ecommerce-app|4310"
  "forms-app|forms-app|4320"
  "dynamic-app|dynamic-app|4330"
  "failure-app|failure-app|4340"
  "self-healing-app|self-healing-app|4350"
)

pid_file() { echo "$RUN/$1.pid"; }
log_file() { echo "$RUN/$1.log"; }

running() {
  local pid_path; pid_path="$(pid_file "$1")"
  [[ -f "$pid_path" ]] && kill -0 "$(cat "$pid_path")" 2>/dev/null
}

start_one() {
  local name="$1" dir="$2" port="$3"
  [[ -f "$LAB/$dir/server.js" ]] || { echo "skip $name (not built yet)"; return 0; }
  if running "$name"; then echo "$name already running on $port"; return 0; fi

  # An orphan holding the port is worse than a port that is simply busy: it answers
  # /health, so a naive readiness probe reports success while every request goes to code
  # from an earlier build. Clear it before starting, or the whole verification run is
  # measuring something that is no longer in the repository.
  if curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
    echo "$name: something is already serving port $port; stopping it first"
    pkill -f "$LAB/$dir/server.js" 2>/dev/null
    sleep 0.5
  fi

  ( cd "$ROOT" && node "$LAB/$dir/server.js" >"$(log_file "$name")" 2>&1 & echo $! >"$(pid_file "$name")" )
  local pid; pid="$(cat "$(pid_file "$name")")"

  for _ in $(seq 1 50); do
    # The process we launched has to be the one that is alive. Probing the port alone
    # cannot tell "my server started" from "someone else's server is still there".
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "$name FAILED to start (process exited); see $(log_file "$name")"
      tail -5 "$(log_file "$name")"
      rm -f "$(pid_file "$name")"
      return 1
    fi
    if curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
      echo "$name ready on http://127.0.0.1:$port (pid $pid)"
      return 0
    fi
    sleep 0.2
  done
  echo "$name FAILED to answer /health; see $(log_file "$name")"
  tail -5 "$(log_file "$name")"
  return 1
}

stop_one() {
  local name="$1" dir="$2" pid_path; pid_path="$(pid_file "$name")"
  local stopped=0
  if [[ -f "$pid_path" ]]; then
    kill "$(cat "$pid_path")" 2>/dev/null && stopped=1
    rm -f "$pid_path"
  fi
  # Also by path: a pid file can be lost or overwritten, and an orphan that keeps serving
  # the port is exactly how a verification run ends up measuring stale code.
  if [[ -n "$dir" ]] && pkill -f "$LAB/$dir/server.js" 2>/dev/null; then stopped=1; fi
  [[ $stopped -eq 1 ]] && echo "$name stopped"
  return 0
}

case "${1:-status}" in
  start)
    # The bank is a built React application; refusing to start without the bundle is
    # clearer than serving a blank page and failing every test that follows.
    if [[ ! -f "$LAB/banking-app/dist/index.html" ]]; then
      echo "Building the banking application…"
      (cd "$ROOT" && pnpm --filter @aira/test-lab build >/dev/null) || exit 1
    fi
    failed=0
    for entry in "${APPS[@]}"; do
      IFS='|' read -r name dir port <<<"$entry"
      start_one "$name" "$dir" "$port" || failed=1
    done
    exit $failed
    ;;
  stop)
    for entry in "${APPS[@]}"; do IFS='|' read -r name dir _ <<<"$entry"; stop_one "$name" "$dir"; done
    ;;
  restart) "$0" stop; "$0" start ;;
  reset)
    for entry in "${APPS[@]}"; do
      IFS='|' read -r name _ port <<<"$entry"
      curl -fsS -X POST "http://127.0.0.1:$port/__reset" >/dev/null 2>&1 && echo "$name reset"
    done
    ;;
  status)
    for entry in "${APPS[@]}"; do
      IFS='|' read -r name dir port <<<"$entry"
      if curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
        active=$(curl -fsS "http://127.0.0.1:$port/health" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const f=JSON.parse(s).faults??{};const on=Object.entries(f).filter(([,v])=>v).map(([k])=>k);console.log(on.length?on.join(","):"none")})')
        printf '%-18s up    http://127.0.0.1:%s   faults: %s\n' "$name" "$port" "$active"
      else
        printf '%-18s down  http://127.0.0.1:%s\n' "$name" "$port"
      fi
    done
    ;;
  logs)
    tail -n "${3:-40}" "$(log_file "${2:-banking-app}")"
    ;;
  *)
    echo "usage: lab-ctl.sh {start|stop|restart|reset|status|logs <app> [lines]}"
    exit 2
    ;;
esac
