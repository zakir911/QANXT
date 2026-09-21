# Current state assessment

Written by inspecting the repository at commit `130d82b` on branch
`claude/blissful-pasteur-qtbzbs`, and by running the test suites against a live stack on the
same machine. Numbers here were counted or executed, not estimated.

This is the input to the Test Lab and Golden Verification phase: it records what exists,
what is half-built, what is absent, and where new verification work should attach.

---

## 1. Architecture as built

```
apps/api            .NET 8 / ASP.NET Core        Domain → Application → Infrastructure → Api
apps/browser-worker Node 22 + Playwright 1.56    discovery crawler + deterministic executor + healer
apps/web-console    React 18 + Vite + Tailwind   operator console (16 pages)
apps/browser-extension Chrome MV3                journey recorder
packages/cli        Node                         CI entry point, JUnit output, exit codes
packages/shared-types                            cross-language enum/contract parity
samples/demo-bank   Node, server-rendered        the only target application today
infrastructure/     Docker, compose, CI files
verification/       independent verification pass (47 checks)
```

Control plane and data plane are separated as designed: the API never drives a browser, and
the worker never touches the database. They meet at a Redis Streams queue (consumer group,
`XAUTOCLAIM` reclaim) and at a job-scoped worker token (`kind=worker`, `job`, `wscope`).

| Counted | |
| --- | --- |
| C# source | 34,435 lines |
| TypeScript / JavaScript source | 18,403 lines |
| HTTP endpoints | 73 |
| Domain entities | 32 |
| Database tables | 44 (2 migrations: `InitialSchema`, `AddAgentRuns`) |
| Permissions in the RBAC catalogue | 33 |
| Console pages | 16 |

## 2. What currently works

Each item below is backed either by the independent verification pass in `verification/`
(check IDs resolve in `verification/final-report/EVIDENCE-INDEX.md`) or by a suite that was
executed for this assessment.

| Capability | Evidence |
| --- | --- |
| Authentication, refresh-token rotation with reuse detection, security-stamp revocation | SEC-001…003, integration tests |
| Multi-tenancy (EF global filters + write-time guard + `EnterSystemContext`) | SEC-010…013 |
| RBAC across 7 roles and 33 permissions, allow **and** deny per permission | RBAC-001, SEC-020 |
| SSRF/target-URL policy, path traversal, injection handling, secure headers | SEC-030…060 |
| Discovery: bounded crawl → pages, elements, API endpoints, knowledge graph | Runs execute; **completeness never measured** |
| AI orchestration with strict JSON-schema validation and a local deterministic provider | Unit tests; providers: OpenAI, Anthropic, Gemini, Local |
| Test generation from the discovered model and from a natural-language requirement | Generated tests execute |
| Deterministic execution on Chromium, Firefox and WebKit | EXEC-001 |
| Evidence: screenshots, traces, video, HAR, console, network, artifact store | Artifacts stored content-addressed |
| Failure analysis: deterministic classifier + AI narrative | TRUST suite |
| Self-healing, positive and negative, with `Never`/`Suggest`/`Auto` policies | HEAL-001…008 |
| Quality gates, CLI exit codes, JUnit output | CLI-001, CLI-002 |
| Browser extension recorder | EXT-001…007 (independent, plus five mutation controls) |
| Stranded-execution reaper, rate limiting partitioned per tenant | BUG-0004, BUG-0005 fixes |

## 3. Baseline, executed for this assessment

Run on 2026-09-21 against a live stack (PostgreSQL 16, Redis 7, API, worker, demo bank).

| Suite | Result |
| --- | --- |
| `Aira.UnitTests` | 163 passed, 0 failed |
| `Aira.IntegrationTests` | 52 passed, 0 failed |
| `@aira/shared-types` | 12 passed |
| `@aira/web-console` | 19 passed |
| `@aira/cli` | 30 passed |
| `@aira/browser-extension` | 20 passed |
| `@aira/browser-worker` | 81 passed |
| Independent verification (`verification/tests`) | 47 checks, 47 passed |

Total: **377 product tests (215 .NET, 162 Node) + 47 independent checks, all green** at the
start of this phase. This is the regression baseline the rest of the phase is measured against.

## 4. What is partially implemented

| Area | State |
| --- | --- |
| **Discovery quality** | Crawls run and populate the graph, but there is no expected-versus-actual comparison anywhere, so precision and recall are unknown. This is the single largest measurement gap. |
| **AI generation quality** | Generation produces runnable tests. Whether they are the *right* tests is unassessed. |
| **Quality gates** | Engine, endpoint and UI exist; verified by the product's own e2e check, not independently. |
| **Autonomous agent** | Runs a bounded plan/propose loop; covered by integration tests only. |
| **Docker deployment** | API and worker images build and run here; console and demo-bank images cannot be built in this environment (Docker Hub is blocked by egress policy). |
| **Performance** | Latencies observed incidentally; no designed measurement, no baseline. |
| **Recovery** | The stranded-execution reaper covers the worker case. Killing the API, Redis or the database mid-run is untested. |

## 5. What is missing

- **A controlled test lab.** `samples/demo-bank` is one server-rendered application with 12
  boolean scenario switches. There is no React SPA, no e-commerce flow, no form-heavy
  application, no deliberately hostile dynamic DOM, no HTTP-status failure matrix, and no
  application built specifically to exercise locator healing.
- **Ground truth.** Nothing in the repository states what an application *should* contain,
  so no discovery result can be scored.
- **A golden test suite.** `verification/tests` holds 47 checks written to break the
  platform; it is not organised by capability, has no severity or evidence contract per
  test, and does not cover discovery accuracy, generation quality or AI failure modes.
- **Per-test evidence directories.** Evidence is written per suite, not per test ID, and is
  overwritten on each run.
- **Metrics.** No precision/recall, no healing success rate, and — most importantly — no
  false-healing rate.
- **CI/CD execution.** Pipelines have never run on a real runner.
- **Kubernetes manifests.** `infrastructure/kubernetes` is an empty directory.
- **Manual test authoring.** `POST /api/v1/testcases` returns 405 (BUG-0002).

## 6. Existing technical debt

| Debt | Why it matters here |
| --- | --- |
| No manual test-authoring endpoint (BUG-0002) | Golden tests that need a precise stored locator must import a recorded journey instead. Workable, but it couples test setup to the import path. |
| Evidence paths are suite-scoped | The golden suite needs `/verification/evidence/<TEST-ID>/` and must not overwrite earlier runs. New code, not a change to the existing store. |
| Demo-bank scenario switches are global | Two suites running concurrently against the demo bank can contaminate each other. The lab's fault engine must be explicit about this. |
| `verification/tests` has grown organically | Harness is sound (`check()` refuses to pass without a result, hashes evidence); the golden suite should reuse it rather than start again. |
| Console has no verification view | The Verification Center has to be added. |

## 7. Known bugs at the start of this phase

| ID | Severity | Status |
| --- | --- | --- |
| BUG-0001 | HIGH | Fixed — `ALLOW_PRIVATE_NETWORK_TARGETS` also unlocked the cloud metadata range |
| BUG-0002 | MEDIUM | **Open** — a test cannot be authored by hand (`POST /api/v1/testcases` → 405) |
| BUG-0003 | MEDIUM | Fixed — an imported journey could store a credential in plain text |
| BUG-0004 | HIGH | Fixed — the platform rate-limited its own worker |
| BUG-0005 | HIGH | Fixed — stranded executions were never reconciled |
| BUG-0006 | LOW | Fixed — the recorder's step de-duplication never fired |

## 8. Recommended integration points

Where the new Test Lab and Golden Suite attach to the product, using public surfaces only:

| Need | Surface |
| --- | --- |
| Register an application | `POST /api/v1/applications` (base URL is checked against the target policy; the lab must run on an allowlisted host) |
| Run discovery | `POST /api/v1/discovery/runs`, poll `GET /api/v1/discovery/runs/{id}` |
| Read what was discovered | `GET /api/v1/applications/{id}/graph`, `/pages`, `/pages/{id}/elements`, `/api-endpoints` |
| Generate tests | `POST /api/v1/testcases/generate` (takes a natural-language `Requirement`) |
| Read a generated test | `GET /api/v1/testcases/{id}` — steps, locators, assertions |
| Author an exact test | `POST /api/v1/journeys/import` (until BUG-0002 is fixed) |
| Execute | `POST /api/v1/testruns`, poll `GET /api/v1/testruns/{id}`, then `/executions` |
| Evidence | `GET /api/v1/artifacts`, `/artifacts/{id}/content`, `/executions/{id}/console`, `/network` |
| Healing decisions | `GET /api/v1/healing`, `/healing/{id}`, approve / reject / revert |
| Quality gates | `GET|POST /api/v1/quality-gates`, `GET /api/v1/testruns/{id}/quality-gate` |
| Healing policy | `PATCH /api/v1/projects/{id}` — `healingPolicy`, `healingConfidenceThreshold` |
| AI provider | `AI_PROVIDER` / `AI_API_KEY` environment; `Local` is the deterministic fallback |

The verification harness at `verification/tests/harness.mjs` already provides tenant
registration, authenticated requests, run polling, evidence saving and SHA-256 hashing. The
golden suite extends it rather than replacing it.

## 9. Rule carried into this phase

Nothing in `apps/`, `packages/` or `samples/` is rewritten to make verification easier. The
lab is additive (`/test-lab`, `/verification/golden-tests`). Where a golden test fails, the
defect is reproduced twice and recorded under `verification/bugs/` **before** anything is
changed, and a test is never edited to make it pass.

---

## 10. What the assessment got wrong

This section was added after the golden suite ran, because an assessment that is never
checked against reality is an opinion.

Section 2 listed discovery, generation, execution, failure analysis and self-healing as
**working**, on the strength of 377 passing tests and an end-to-end pass against the demo
bank. Driving the same code against applications built to be awkward found nine defects it
had not, and two of them were severe:

| What this document said | What was true |
| --- | --- |
| "Discovery crawls an application into a knowledge graph" | It could not sign in to a single-page application at all. The demo bank is server-rendered, so every check had been run against the one shape that happened to work. Against React it reported "failed, 0 pages". (BUG-0007) |
| "The recorder and the executor share one action model" | They contradicted each other: a recorded journey that signs in itself was forced through the configured sign-in first and failed at step 2. Each feature was correct alone; nothing had ever run them together. (BUG-0009) |
| "Assertions are evaluated by the engine" | Text and value assertions read the element once, so any asynchronously rendered value failed in milliseconds. (BUG-0014) |
| "Failure analysis classifies a failure into a category" | The classifier matched on error prose the engine had stopped producing, and later blamed a missing button on the session because the signed-out page had answered its own probe with 401. (BUG-0012, BUG-0015) |
| "AI test generation produces runnable tests from a requirement" | Some of them could not fail. A generated scenario closed by asserting that the control it had just clicked was still visible, with a comment in the generator admitting the assertion was a placeholder. It counted towards coverage and told a reader a behaviour was checked. (BUG-0016) |

The pattern is the same in every case: the product's own tests and its demo application
agreed with each other, and the agreement was mistaken for evidence. What the test lab adds
is an application that was not written to make the platform look good.

The bug reports are in `verification/bugs/BUG-0007` … `BUG-0016`, each with a script that
reproduces the original failure against an unfixed build.
