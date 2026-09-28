#!/usr/bin/env bash
# Independent verification: starts the stack, runs every verification suite, regenerates the
# evidence index, and fails if any check fails.
#
# Distinct from scripts/test.sh, which runs the product's own tests. This runs the suites in
# verification/tests, which exercise the product from outside through its HTTP API and a real
# browser, and which were written to try to break it.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

section "Starting the stack"
bash scripts/services-ctl.sh --with-database
bash scripts/api-ctl.sh start && bash scripts/api-ctl.sh wait
bash scripts/demo-bank-ctl.sh start
bash scripts/worker-ctl.sh start

section "Building the CLI (CLI-001 and CLI-002 execute it)"
pnpm --filter @qa-nxt/cli... build >/dev/null

section "Building the browser extension (the EXT checks load it into Chromium)"
pnpm --filter @qa-nxt/browser-extension build >/dev/null

section "Product test suites (regression baseline)"
bash scripts/test.sh

section "Independent verification suites"
cd verification/tests
failed=()
for suite in sec.mjs heal.mjs trust.mjs ops.mjs exec-flake.mjs conc-reverify.mjs ext.mjs; do
  printf '\n\033[1m-- %s\033[0m\n' "$suite"
  node "$suite" || failed+=("$suite")
done

section "Evidence index"
node report.mjs

if [[ ${#failed[@]} -gt 0 ]]; then
  printf '\n\033[31mVerification FAILED in: %s\033[0m\n' "${failed[*]}"
  exit 1
fi

printf '\n\033[32mVerification complete. See verification/final-report/.\033[0m\n'
