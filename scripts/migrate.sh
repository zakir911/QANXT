#!/usr/bin/env bash
# Applies EF Core migrations to the configured database.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

set -a; [[ -f .env ]] && . .env; set +a

if ! dotnet tool list --global 2>/dev/null | grep -q dotnet-ef; then
  echo "Installing the EF Core tools…"
  dotnet tool install --global dotnet-ef >/dev/null
  export PATH="$PATH:$HOME/.dotnet/tools"
fi
export PATH="$PATH:$HOME/.dotnet/tools"

dotnet ef database update \
  --project apps/api/src/Aira.Infrastructure \
  --startup-project apps/api/src/Aira.Api

echo "Migrations applied."
