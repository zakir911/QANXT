#!/usr/bin/env bash
# What CI runs: build everything, then run every suite that does not need a browser.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

section "Installing dependencies"
pnpm install --frozen-lockfile

section "Type-checking the TypeScript packages"
pnpm -r typecheck

section "Building"
pnpm -r build
dotnet build apps/api/Aira.sln

section "Testing"
bash scripts/test.sh

printf '\n\033[32mVerification complete.\033[0m\n'
