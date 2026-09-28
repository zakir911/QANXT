#!/usr/bin/env bash
# Runs every test suite that does not need a browser or a running stack.
#
# The browser-driven end-to-end checks live in tests/e2e and are run separately, because
# they need the whole system up; this is the suite someone runs while working.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

failed=()

section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

section "Node test suites"
if ! pnpm -r test; then failed+=("node"); fi

section ".NET test suites"
# The integration tests need PostgreSQL; they say so clearly if it is not there.
if ! docker ps >/dev/null 2>&1 && ! pg_isready -h "${PGHOST:-localhost}" >/dev/null 2>&1; then
  echo "note: PostgreSQL does not appear to be running."
  echo "      Start it with: bash scripts/services-ctl.sh --with-database"
fi
if ! dotnet test apps/api/QaNxt.sln; then failed+=("dotnet"); fi

if [[ ${#failed[@]} -gt 0 ]]; then
  printf '\n\033[31mFailed suites: %s\033[0m\n' "${failed[*]}"
  exit 1
fi

printf '\n\033[32mAll test suites passed.\033[0m\n'
