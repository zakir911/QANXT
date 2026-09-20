# AIRA — Your AI Quality Engineer

An AI-powered autonomous web application testing platform: it learns an application, plans
tests for it, runs them in real browsers, collects evidence, explains failures, heals broken
locators under policy, and reports quality intelligence to people and to CI/CD.

> The product name is configuration (`PRODUCT_NAME`), not a constant in the code.

```
Application URL + credentials → Discovery → Knowledge Graph → AI Test Planning →
Test Generation → Browser Execution → Evidence → Assertions → Failure Analysis →
Root Cause → Self-Healing → Defect Proposals → Quality Intelligence → Dashboard / CI-CD
```

## Repository layout

| Path | What it is |
|---|---|
| `apps/api` | .NET 8 control plane (ASP.NET Core, EF Core, PostgreSQL) |
| `apps/browser-worker` | Node 22 + Playwright execution plane |
| `apps/web-console` | React + TypeScript + Vite console |
| `apps/browser-extension` | Chrome MV3 journey recorder |
| `packages/shared-types` | Cross-language contracts |
| `packages/cli` | `aira` CLI for pipelines |
| `samples/demo-bank` | Local demo banking application used to exercise the platform |
| `infrastructure/` | Docker, Kubernetes, CI templates |
| `docs/` | Architecture, ADRs, plan, operations |

## Getting started

With Docker:

```bash
cp .env.example .env      # then fill in JWT_SECRET, ENCRYPTION_KEY and WORKER_TOKEN
make docker-up            # build and start the whole platform
```

Or natively, if you have .NET 8, Node 22, pnpm and PostgreSQL:

```bash
cp .env.example .env
make setup                # install dependencies, create and migrate the database
make dev                  # run the full local stack
```

Either way the console is on <http://localhost:5173>.

See `docs/setup.md` for step-by-step instructions and `docs/implementation-plan.md` for the
build plan and its phases.

## Documentation

- [Architecture](docs/architecture.md) · [Assessment](docs/architecture-assessment.md) · [ADRs](docs/adr)
- [Implementation plan](docs/implementation-plan.md)
- [Verification status](docs/verification-status.md) — what has actually been executed, and what has not
- [Running from a pipeline](docs/ci-cd.md) — the `aira` CLI, exit codes, reports and quality gates
- [Deploying with Docker](docs/deployment.md) — one compose file for the whole platform
- [The autonomous agent](docs/agent.md) — the bounded loop, risk scoring, regression intelligence, and what the agent is not allowed to do

## Principles

1. The AI plans; a deterministic engine executes. The model never drives a browser or a shell.
2. Deterministic logic first, AI second — tokens are spent only where rules cannot decide.
3. Every AI conclusion cites evidence stored in the system.
4. Content from a tested application is untrusted data, never instruction.
5. Nothing is claimed to work that has not been run.
