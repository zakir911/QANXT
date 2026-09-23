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

New to the project, or installing on Windows or macOS? **[docs/installation.md](docs/installation.md)**
walks the whole thing with screenshots. `docs/setup.md` is the short version for people who
already have the toolchain, and `docs/implementation-plan.md` has the build plan.

## Documentation

- **[Installing AIRA](docs/installation.md)** — Windows, macOS and Linux, step by step, with screenshots
- **[User manual](docs/user-manual.md)** — how to use the product, screen by screen, with screenshots
- [Architecture](docs/architecture.md) · [Assessment](docs/architecture-assessment.md) · [ADRs](docs/adr)
- [Implementation plan](docs/implementation-plan.md)
- [Verification status](docs/verification-status.md) — what has actually been executed, and what has not
- [Running from a pipeline](docs/ci-cd.md) — the `aira` CLI, exit codes, reports and quality gates
- [API testing](docs/api-testing.md) · [Contract testing](docs/contract-testing.md) · [Regression selection](docs/regression-selection.md) · [Failure diagnosis](docs/failure-diagnosis.md)
- [Scheduled regression](docs/scheduling.md) — the tests that run when nobody commits
- [Notifications](docs/notifications.md) — telling somebody, and being able to show that you did
- [Test data](docs/test-data.md) — seeded values, and why a credential is never a literal
- [Release quality](docs/release-quality.md) — what changed between runs, and whether to ship
- [Accessibility](docs/accessibility.md) — axe-core as a step, and what a clean result does not mean
- [Visual regression](docs/visual-regression.md) — baselines, masking, and why a difference asks rather than fails
- [Setup](docs/setup.md) — from a clone to a working platform, and what to do when it is not
- [Deploying with Docker](docs/deployment.md) — one compose file for the whole platform
- [The database](docs/database.md) — schema, tenant isolation, migrations
- [The autonomous agent](docs/agent.md) — the bounded loop, risk scoring, regression intelligence, and what the agent is not allowed to do
- [The test lab and golden suite](docs/test-lab-plan.md) — six applications built to break, and the tests that prove the product against them

## Proving it works

```bash
./scripts/verify-product        # infrastructure → lab → golden suite → reports → certification
./scripts/run-golden-tests --all
./scripts/run-product-demo      # the whole product in sixteen steps, recorded
```

`test-lab/` holds six real applications with hand-written ground truth and switchable faults;
`verification/golden-tests/` holds 125 tests that drive the product against them from the
outside. The reports land in `verification/reports/`, the evidence — hashed — in
`verification/evidence/`, and the console renders the last run at **Verification**.

The headline number is the false-healing rate, and it is never folded into a success rate.

## Principles

1. The AI plans; a deterministic engine executes. The model never drives a browser or a shell.
2. Deterministic logic first, AI second — tokens are spent only where rules cannot decide.
3. Every AI conclusion cites evidence stored in the system.
4. Content from a tested application is untrusted data, never instruction.
5. Nothing is claimed to work that has not been run.
