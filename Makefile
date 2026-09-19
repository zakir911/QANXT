# AIRA developer commands. Cross-platform equivalents live in scripts/.
SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help setup dev test build migrate db-reset api worker console demo-bank clean docker-up docker-down lint verify

help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

setup: ## Install all dependencies and prepare the local database
	@bash scripts/setup.sh

dev: ## Run the full local stack (db, redis, api, worker, console, demo bank)
	@bash scripts/dev.sh

test: ## Run every test suite (.NET + Node)
	@bash scripts/test.sh

verify: ## Build everything and run the full test suite (what CI runs)
	@bash scripts/verify.sh

build: ## Build all applications
	@dotnet build apps/api/Aira.sln -c Release
	@pnpm -r build

migrate: ## Apply EF Core migrations to the configured database
	@bash scripts/migrate.sh

db-reset: ## Drop, recreate and re-migrate the local database (destructive)
	@bash scripts/db-reset.sh

api: ## Run the control plane API only
	@dotnet run --project apps/api/src/Aira.Api

worker: ## Run a browser worker only
	@pnpm --filter @aira/browser-worker start

console: ## Run the web console only
	@pnpm --filter @aira/web-console dev

demo-bank: ## Run the demo banking application only
	@pnpm --filter @aira/demo-bank start

lint: ## Lint all Node packages
	@pnpm -r lint

docker-up: ## Start the full stack with Docker Compose
	@docker compose -f infrastructure/docker/docker-compose.yml up --build -d

docker-down: ## Stop the Docker Compose stack
	@docker compose -f infrastructure/docker/docker-compose.yml down -v

clean: ## Remove build output
	@find . -type d \( -name bin -o -name obj -o -name dist -o -name node_modules \) -prune -exec rm -rf {} + 2>/dev/null || true
