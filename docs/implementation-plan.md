# AIRA — Implementation Plan

> **AIRA — "Your AI Quality Engineer."**
> Product name is configuration (`PRODUCT_NAME`), never hard-coded into logic.

This plan is the contract for the build. Each phase has a definition of done, an
explicit verification step, and a commit. A phase is not "done" because code exists —
it is done when the listed commands were executed in this environment and passed.

## 0. Principles

1. **No fake implementations.** No hardcoded test results, dashboard numbers, discovery
   output, AI responses or healing results. Where an external dependency is absent
   (e.g. no LLM API key), a clearly-labelled deterministic local provider is used and
   the UI states that it is the local provider.
2. **The AI plans; the engine executes.** The LLM never controls a browser or a shell.
3. **Deterministic first, AI second.** Spend tokens only where deterministic logic cannot decide.
4. **Everything the AI concludes must cite evidence** stored in the system.
5. **Secure by default.** Tenant isolation, masking, allowlists, RBAC, audit are not optional extras.
6. **Small, cohesive files.** No 3000-line god classes; no abstraction without a second implementation in sight.

## 1. Target topology

```
apps/
  api/                 .NET 8 control plane (ASP.NET Core, EF Core, PostgreSQL)
    src/Aira.Domain            entities, value objects, enums, domain rules
    src/Aira.Application       use cases, DTOs, abstractions (ports)
    src/Aira.Infrastructure    EF Core, Redis, storage, LLM providers, security
    src/Aira.Api               HTTP surface, auth, OpenAPI, SignalR hub
    tests/Aira.UnitTests
    tests/Aira.IntegrationTests
  browser-worker/      Node 22 + TypeScript + Playwright execution plane
  web-console/         React 18 + TypeScript + Vite + Tailwind
  browser-extension/   Chrome MV3 recorder
packages/
  shared-types/        TS contracts shared by worker, console, extension, CLI
  cli/                 `aira` CLI for CI/CD
samples/
  demo-bank/           local demo banking application (defect + locator mutation switches)
infrastructure/
  docker/ kubernetes/ ci/
docs/
tests/e2e/
```

## 2. Phases

### Phase 1 — Core platform shell
Domain model and EF Core schema for all 30+ tables; migrations; JWT auth with refresh
tokens; RBAC (7 roles, permission matrix); organization/workspace/project multi-tenancy
with global query filters; React console shell with routing, auth, layout; Node worker
skeleton with Redis Streams consumer and a real Playwright smoke action; `/health`,
`/ready`, `/live`; structured logging with correlation IDs; docker-compose + Makefile.

**Done when:** `dotnet build`, `dotnet test`, migrations applied to live PostgreSQL,
console builds, worker consumes a queued job and drives Chromium, health endpoints return 200.

### Phase 2 — Discovery + knowledge graph
Bounded crawler (allowlist, depth, page/action/time budgets, URL normalization, dedup,
loop detection, SSRF guards); login strategies (form, storage-state, none); DOM +
accessibility tree + element extraction; network/API capture; console error capture;
screenshots; persistence into `ApplicationPages`/`ApplicationElements`/`ApiEndpoints`;
knowledge-graph query API; console screens for running discovery and browsing the map.

**Done when:** discovery run against `samples/demo-bank` produces real pages, elements,
API endpoints and screenshots, visible in the console.

### Phase 3 — AI orchestration, generation, execution
`ILlmProvider` + OpenAI/Anthropic/Gemini adapters + `DeterministicLocalProvider`;
prompt assembly with untrusted-data envelopes; JSON-schema validation of every response;
AI request/response accounting (tokens, latency, cost); test plan → test case → test step
generation; strict `BrowserAction` schema; Playwright execution engine (PASS/FAIL/SKIPPED/
BLOCKED/HEALED/FLAKY); parallelism, retries, timeouts, isolated contexts.

**Done when:** tests generated from the discovered demo bank execute in Chromium and report real results.

### Phase 4 — Evidence + failure analysis
`IArtifactStore` (filesystem now, S3-compatible next); screenshots before/after, DOM
snapshot, a11y tree, HAR, console, trace, video; masking of secrets/PII at capture;
deterministic failure classifier; AI root-cause analysis citing artifacts; failure API + UI.

**Done when:** a deliberately broken demo-bank flow produces classified failures with linked evidence.

### Phase 5 — Self-healing
Locator candidate model (role, accessible name, text, label, placeholder, test id, stable
attributes, hierarchy, neighbours, position, history); candidate generation from live DOM;
deterministic similarity scoring; optional AI adjudication; confidence thresholds;
policies auto/suggest/never; healing events; approval workflow; outcome validation.

**Done when:** flipping the demo bank's locator mutation switch causes a failing test to be
healed with a recorded proposal, confidence and evidence, and to pass after approval.

### Phase 6 — Browser extension
MV3 recorder: navigation, clicks, inputs, selects, checkboxes, key presses, assertions;
element inspector; robust selector generation; annotation; export/push journey to platform;
backend journey import → test generation.

**Done when:** a recorded journey JSON imports and generates an executable test.

### Phase 7 — CLI, CI/CD, gates, reporting
`aira` CLI (`login`, `run`, `status`, `report`, `discover`); JUnit XML, JSON, HTML reports;
exit codes; quality gate rule engine; GitHub Actions workflow and Azure DevOps pipeline templates.

**Done when:** CLI drives a real run against a local API and emits a JUnit file that a CI system can consume.

### Phase 8 — Demo app + platform test suites
Demo banking app (login, dashboard, accounts, transactions, statements, payments, profile)
with toggleable defects and locator mutations; unit, integration, API, frontend, extension,
engine and E2E test suites.

### Phase 9 — Autonomous agent + quality intelligence
Bounded agent loop (explore → model → prioritize → generate → execute → investigate →
propose), risk scoring, flakiness and regression intelligence, dashboard analytics, AI insights
with evidence links.

## 3. Cross-cutting requirements tracked across every phase

- Security: RBAC on every endpoint, tenant filters, validation, rate limiting, secure headers, SSRF guards, audit logging.
- Observability: correlation/request/execution/test/project/tenant IDs on every log line; health endpoints; OpenTelemetry-ready.
- AI safety: no secret egress, no autonomous destruction of tests, no silent expectation rewrites, no failure suppression.
- Cost: cache, deterministic-first, per-project model configuration, full accounting.

## 4. Roadmap beyond this build

API testing (the captured `ApiEndpoint` graph already feeds it), accessibility auditing
(the a11y tree is already captured), visual regression (screenshot store already exists),
performance and security suites, mobile, contract testing, RabbitMQ/Kafka transports,
S3/Azure Blob artifact stores, SSO/SCIM.
