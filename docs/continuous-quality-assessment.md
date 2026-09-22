# Continuous quality: what exists before this phase

Written by inspecting the repository, not from memory. The point is to establish what can be
reused so this phase extends AIRA rather than growing a second platform beside it.

Build inspected: `2d03a43`.

## 1. What is already there

| Area | State | Where |
| --- | --- | --- |
| Control plane | ASP.NET Core 8, 18 controllers, 44 entities, EF Core + PostgreSQL, tenant-filtered | `apps/api` |
| Browser worker | Node 22 + Playwright 1.56: crawler, deterministic executor, locator healer, evidence collector | `apps/browser-worker/src` |
| Queue | Redis Streams, job-scoped worker tokens | `apps/browser-worker/src/queue` |
| Console | React 18 + Vite, 17 pages including a Verification Center | `apps/web-console` |
| Discovery | Crawls an application into pages, elements, transitions **and API endpoints observed while driving the UI** | `apps/browser-worker/src/discovery` |
| Test generation | Requirement → plan → cases, schema-validated, provider-labelled | `apps/api/.../Testing/TestGenerationService.cs` |
| Execution | Deterministic action runner, 9 assertion types, retries, evidence | `apps/browser-worker/src/execution` |
| Failure analysis | Deterministic classifier first, local/AI analyser second, 12 categories | `apps/api/.../Diagnosis` |
| Self-healing | Scored candidates, `Never`/`Suggest`/`Auto` policy, audit trail, approve/reject/revert | `apps/api/.../Diagnosis/HealingService.cs` |
| Quality gates | Rule rows per project, 9 metrics, operator + threshold, evaluated per run | `apps/api/.../Quality` |
| Agent | Bounded autonomous pass: explore, score, generate, execute, propose | `apps/api/.../Agent` |
| CLI | 5 commands, 6 exit codes, JUnit/JSON/HTML reports | `packages/cli` |
| Test lab | Six real applications with fault injection and hand-written ground truth | `test-lab` |
| Golden suite | 130 tests across 10 suites, hashed evidence, certification | `verification/golden-tests` |

## 2. What this phase can reuse directly

These are the load-bearing reuse points. Building past them rather than beside them is the
difference between extending AIRA and forking it.

| To build | Reuse |
| --- | --- |
| API testing | `ApiEndpoint` already carries method, URL template, sample request/response, content types, `RequiresAuthentication`, observed count and average duration — populated by discovery from real traffic. |
| UI/API correlation | `NetworkEvent` has a `TestActionId` column and the worker has always reported an action order, so the link *looked* available. **Correction, found by executing it:** nothing ever wrote that column — every stored event was orphaned ([BUG-0020](../verification/bugs/BUG-0020/bug.md)). Reuse here meant fixing the write, not reading an existing join. Fixed; the join is now populated and returned. |
| Contract testing | `ApiEndpoint.ResponseSampleJson` is a real observed response, which is the natural baseline for a contract. |
| Quality gate PASS/FAIL/REVIEW | `QualityGateRule` rows, `QualityGateOperator` and the evaluator's per-rule explanation already exist; they need a third outcome and a severity, not a rewrite. |
| Change impact | The knowledge graph (`ApplicationPage`, `ApplicationElement`, `PageTransition`, `ApiEndpoint`) is the dependency graph a change-impact engine needs. |
| Regression selection | `TestCase` already carries priority and risk; executions carry history. Selection needs a scorer over data that is already stored. |
| Evidence for API tests | `ArtifactService` and the hashed evidence tree are storage-agnostic. |
| Exit codes | `packages/cli/src/exit-codes.ts` is already a single table with a `CliError` that carries its code. |
| CI artifacts | `packages/cli/src/report-gather.ts` already writes JUnit, JSON and HTML. |
| Audit | `AuditAction` + `_audit.LogAsync` are already called from every mutating service. |

## 3. What does not exist

Stated plainly, because these are the gaps this phase is judged against.

| Missing | Notes |
| --- | --- |
| **API testing of any kind** | Nothing can send a request and assert on the response. `ApiEndpoint` is an inventory, not a test target. |
| **API contract testing** | No schema comparison, no breaking-change classification. |
| **UI/API correlation in diagnosis** | The events now carry the step they belong to (BUG-0020), but no analyser consults the link yet, so a wrong balance cannot yet be attributed to the API rather than the rendering. |
| **Change impact analysis** | No notion of a commit, a changed file, or what a change reaches. |
| **Smart regression selection** | A run executes the tests it is given. There is no selection, no scoring, no explanation of why a test was chosen. |
| **Environments as first-class** | An application has one base URL. There is no Development/QA/Staging/UAT/Production distinction and so no production safeguard. |
| **Test data abstraction** | Secrets resolve through `${secret:…}`; there is no `{{TEST_USER}}` layer, no generated data, no cleanup. |
| **Scheduled regression** | No scheduler. |
| **Accessibility, visual regression** | Neither exists. |
| **Notifications** | No provider interface, no delivery. |
| **PR reporting** | The CLI writes files; nothing posts a summary. |
| **Release-level reporting and comparison** | Reports are per run. |
| **Flaky detection** | A `Flaky` status exists in the enum and a flakiness score is computed per test, but there is no repeat-execution policy that decides it. |
| **CI integrations for *using* AIRA** | `.github/workflows/aira-tests.yml` tests AIRA itself. `infrastructure/ci/azure-pipelines.yml` likewise. There is no GitLab or Jenkins definition, and no example of a pipeline that deploys an application and asks AIRA to validate it. |
| **Nine exit codes** | Six exist. `ConfigurationError`, `SecurityPolicyViolation`, `HumanReviewRequired` and a distinct `AiraInternalError` do not, and `QualityGateFailed` currently doubles as "tests failed". |

## 4. Technical debt this phase must not make worse

- **Two places already encode the same failure knowledge** (`DeterministicFailureClassifier`
  and `LocalFailureAnalyser`). BUG-0012 and BUG-0015 were both caused by them drifting. Any
  new category or signal must be added to both, or better, to one.
- **`MaxElementsPerPage = 30`** truncates the generation context. BUG-0016 showed the cut
  matters; a change-impact engine reading the same graph should not inherit the cap silently.
- **The CLI's `QualityGateFailed` is overloaded.** Splitting it is a breaking change for
  anything already keying off exit 1, and this phase should say so rather than pretend not.
- **No migration squashing.** Each schema change adds a migration; the phase will add
  several and they must each be reversible.

## 5. Order of work

Chosen so that each step is executable and verifiable before the next depends on it:

1. Exit codes — cheap, and everything downstream reports through them.
2. Quality gate rule engine — PASS/FAIL/REVIEW, severity, self-healing policy.
3. API testing engine — the largest genuinely new capability.
4. Contract testing — builds on 3.
5. UI/API correlation — needs 3 to have something to correlate with.
6. Change impact and regression selection.
7. CLI surface for all of it.
8. CI definitions, artifacts, and a local CI simulation that runs without credentials.
9. Golden verification for everything above.
10. `verify-continuous-quality`, reports, traceability.

## 6. What this assessment does not claim

It does not claim the gaps above are the complete set — it is an inspection, not a proof. It
also does not estimate. The brief asks for a great deal; what gets built will be reported as
built, what gets executed as executed, and what does neither will be named.
