# QA NXT — Your AI Quality Engineer

An AI-powered autonomous web application testing platform: it learns an application, plans
tests for it, runs them in real browsers, collects evidence, explains failures, heals broken
locators under policy, security tests what it has been authorized to test, and reports quality
intelligence to people and to CI/CD.

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
| `packages/cli` | `qanxt` CLI for pipelines |
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

- **[Installing QA NXT](docs/installation.md)** — Windows, macOS and Linux, step by step, with screenshots
- **[User manual](docs/user-manual.md)** — how to use the product, screen by screen, with screenshots
- [Architecture](docs/architecture.md) · [Assessment](docs/architecture-assessment.md) · [ADRs](docs/adr)
- [Implementation plan](docs/implementation-plan.md)
- [Verification status](docs/verification-status.md) — what has actually been executed, and what has not
- [Running from a pipeline](docs/ci-cd.md) — pipeline configuration for GitHub Actions, GitLab, Jenkins and Azure DevOps
- [CLI reference](docs/cli.md) — every command, every flag, and what each of the nine exit codes means
- [Quality gates](docs/quality-gates.md) — the metrics a rule can measure, and why an unmeasured rule is never satisfied
- [Environments](docs/environments.md) — staging, production, and the authorization boundary a run cannot cross
- [API testing](docs/api-testing.md) · [Contract testing](docs/contract-testing.md) · [Regression selection](docs/regression-selection.md) · [Failure diagnosis](docs/failure-diagnosis.md)
- [Change impact analysis](docs/change-impact.md) — what a diff reaches, and why a test was selected
- [Scheduled regression](docs/scheduling.md) — the tests that run when nobody commits
- [Notifications](docs/notifications.md) — telling somebody, and being able to show that you did
- [Test data](docs/test-data.md) — seeded values, and why a credential is never a literal
- [Release quality](docs/release-quality.md) — what changed between runs, and whether to ship
- [Accessibility](docs/accessibility.md) — axe-core as a step, and what a clean result does not mean
- [Visual regression](docs/visual-regression.md) — baselines, masking, and why a difference asks rather than fails
- [Setup](docs/setup.md) — from a clone to a working platform, and what to do when it is not
- [Troubleshooting](docs/troubleshooting.md) — the failures that come up in practice, and how to tell them apart
- [Observability](docs/observability.md) — correlation ids, logs, health, the audit trail and what is not instrumented
- [Deploying with Docker](docs/deployment.md) — one compose file for the whole platform
- [The database](docs/database.md) — schema, tenant isolation, migrations
- [Security testing](docs/security/) — the authorization a scan cannot run without, the checks, the finding model, the gate, and what is untested rather than clean
- [The autonomous agent](docs/agent.md) — the bounded loop, risk scoring, regression intelligence, and what the agent is not allowed to do
- [The test lab and golden suite](docs/test-lab-plan.md) — six applications built to break, and the tests that prove the product against them

## Proving it works

```bash
./scripts/verify-product                # infrastructure → lab → golden suite → reports → certification
./scripts/verify-continuous-quality     # the same, for the continuous-quality claim, ending in a traceability matrix
./scripts/run-golden-tests --all
./scripts/run-product-demo              # the whole product in sixteen steps, recorded
./scripts/run-continuous-quality-demo   # one release cycle end to end: change, gate, notify, ship
```

`test-lab/` holds six real applications with hand-written ground truth and switchable
faults, plus a notification sink that records what QA NXT sends; `verification/golden-tests/` holds 239 tests across twenty-two suites that drive the
product against them from the outside. The reports land in `verification/reports/`, the evidence — hashed — in
`verification/evidence/`, and the console renders the last run at **Verification**.

The headline number is the false-healing rate, and it is never folded into a success rate.

## Principles

1. The AI plans; a deterministic engine executes. The model never drives a browser or a shell.
2. Deterministic logic first, AI second — tokens are spent only where rules cannot decide.
3. Every AI conclusion cites evidence stored in the system.
4. Content from a tested application is untrusted data, never instruction.
5. Nothing is claimed to work that has not been run.
