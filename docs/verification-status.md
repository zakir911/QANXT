# Verification status

What has actually been executed, and what has not.

The point of this page is that "implemented" and "verified" are different claims, and a
reader deserves to know which one applies to each part. Everything marked **verified** was
run in this environment and observed to work; everything marked **unverified** may be
correct but has not been proved, and should be treated as untested until it is.

Last updated after the continuous-quality phases (CQ-3 to CQ-10).

## Verified by automated tests

| Area | How | Count |
| --- | --- | --- |
| Domain contracts, locators, action validation | `dotnet test` — unit | 150 tests |
| API over real HTTP against real PostgreSQL | `dotnet test` — integration | 52 tests |
| Cross-language enum parity (C# ↔ TypeScript) | `pnpm -r test` | 12 tests |
| Browser worker: healing, execution, discovery | `pnpm -r test` | 81 tests |
| CLI: reports, verdict mapping, argument parsing | `pnpm -r test` | 30 tests |
| Extension recorder: locators, recording state | `pnpm -r test` | 20 tests |
| Risk scoring and regression classification | `dotnet test` — unit | 30 tests |
| Web console components | `pnpm -r test` | 19 tests |

Run all of them with `make test`. The integration tests need PostgreSQL; they say so
clearly if it is not running.

## Verified by the golden test suite

Two hundred and thirty-nine tests across twenty-two suites that drive the product from
outside — its HTTP API, its worker, a real browser — against six purpose-built
applications in `test-lab/`, each with hand-written ground truth, and a notification sink
that records what the platform sends. They are the strongest
evidence on this page, because the applications can be broken on demand and the expected
answer was written down first.

Run them with `./scripts/run-golden-tests --all`; the numbers below come from the report
that run writes, not from this document.

| Suite | Tests | What it establishes |
| --- | --- | --- |
| Discovery | 15 | Page recall and precision measured against ground truth, including an application whose element ids regenerate on every render |
| AI test generation | 16 | A sentence in English becomes tests that execute unedited and fail when the application breaks |
| Browser execution | 20 | Every action and assertion type, with screenshots, traces, console and network logs |
| Assertions | 10 | Each assertion type holds when it should and fails when it should not |
| Failure detection | 12 | Eleven failure classes on identically shaped pages, plus a control where nothing is broken |
| Failure analysis | 16 | Classification accuracy; an analysis never overturns a verdict; a silent failure is still caught |
| Self-healing | 20 | Two heals that should happen, ten refusals that must happen |
| Security | 11 | Tenant isolation, credential handling, prompt injection, target policy — local applications only |
| Reliability | 7 | Ten identical runs, twenty against a genuinely unstable application, ten started at once |
| Performance baseline | 3 | Discovery, a twelve-step run and one generation, each timed several times on recorded hardware |

The continuous-quality phases added fourteen more suites, run together by
`./scripts/verify-continuous-quality`:

| Suite | Tests | What it establishes |
| --- | --- | --- |
| API testing | 14 | An endpoint is an ordinary test case: authored, executed, gated, with the exchange as evidence and a credential never inlined |
| API contracts | 14 | Baselines inferred from responses the application actually gave, and each kind of change classified as breaking, potentially breaking or not |
| UI/API correlation | 7 | A UI step that failed because its own API call returned 500 is diagnosed as that, not as a locator problem |
| Regression selection | 12 | What a diff reaches, why each test was selected, and what happens when the impact cannot be determined |
| CI integration | 7 | The four artifacts under fixed names, the exit-code contract, and the build metadata a pipeline passes |
| CI simulation | 12 | A real pipeline per scenario against `test-lab/ci-simulation`, branching on all nine exit codes |
| Scheduling | 7 | A schedule fires on its own, claims its slot exactly once under contention, and disables itself after repeated failure |
| Notifications | 8 | A failure reaches a webhook or Slack, signed, with the delivery recorded — and a green run stays quiet |
| Test data | 8 | The same seed gives the same values on a different day, and a literal credential is refused |
| Release quality | 7 | What moved between two runs, by test case rather than by position, and gating on new failures |
| Accessibility | 6 | axe-core against named WCAG rules, with violations, incomplete results and passes kept distinct |
| Visual regression | 7 | Baselines per viewport, a measured noise floor, masking, and a difference that asks rather than fails |
| Isolation, audit and observability | 20 | Every continuous-quality surface probed across a tenant boundary with the owner's control read; the audit trail's scope, permission and append-only property; one correlation id from the caller to the execution |
| AI provider failure | 9 | A real fault injected into the provider for each way it can fail, with the model request record as proof the path was taken |

The headline number is the **false-healing rate**: incorrect heals divided by healing
opportunities. It is never folded into a success rate, because a healer that repairs nine
locators and silently clicks the wrong button once is worse than one that repairs nothing.
The current report and the certification that reads from it are in `verification/reports/`.

Four tests are recorded **NOT VERIFIED** rather than passed or failed: Firefox and WebKit
execution (neither browser is installed here and the Playwright CDN is unreachable),
generation quality with a hosted model provider (none is configured), and stranded-execution
reconciliation (this deployment waits ten minutes, longer than the suite is willing to).
Each carries the platform's own error message or the setting that would enable it.

The console renders the report at **Verification**, and re-checks the quality gates in the
browser rather than trusting the file's own `overall` flag — a report claiming green while a
gate is red still renders red, and that behaviour is itself tested.

## Verified end to end, against a running stack

These drive the real system in a real browser. They live in `tests/e2e` and each one is run
with `pnpm <name>` from that directory.

| Check | What was observed |
| --- | --- |
| `console` | A person can sign in, read dashboard metrics computed from real runs, open the discovered application map, inspect a generated test, open a run and an execution, see a stored screenshot render through the authorized artifact path, review a healing proposal, ask the insights engine a question, configure a quality gate, and read an agent pass with its phases, bounds and proposals — with no console errors. |
| `recorder` | The real MV3 extension loads into Chromium, recording starts from its own popup, and a journey through the demo bank is captured with the right locator preferences and the password stored as a `${secret:...}` reference rather than a value. |
| `journey` | That recording imports, generates a test case, and the generated test executes green in a real browser with every step passing, the secret masked in stored evidence, and screenshot, video, trace and network log captured. |
| `cli` | The CLI runs a real 11-test suite; the emitted JUnit parses in a browser's XML parser with its declared counts matching its contents; breaking the demo bank's transactions API turns the build red (exit 1) with the failure carried into the XML; misuse, a rejected token and an unreachable platform each exit with their own code. |
| Cross-browser execution | The same 11-test suite was run on all three engines through the containerised worker: Chromium 141, Firefox 142.0.1 and WebKit 26.0, 11 passed on each. The recorded engine and version were checked per execution, so a silent fallback to Chromium would have shown. |
| User management | A second person can be added, sign in with the one-time password they were given, be demoted, disabled and reset — and each of those ends the session they already hold, immediately rather than when their token expires. |
| Docker images | `Dockerfile.api` and `Dockerfile.worker` build, and were run together against a real Postgres and Redis: the API migrated, served authenticated requests and returned its security headers as a non-root user, and the worker reported ready, claimed a run and executed 11 tests in Chromium **inside the container** — all 11 passed, every execution recorded against `worker-container-1`. |
| `first-run` | The path `docs/setup.md` documents was walked in a real browser: an organization registered from an empty platform, the founder landing on the dashboard as its administrator, a project created and an application registered. A setup guide nobody has followed is a guess. |
| `security` | Against production settings: a session resolves to a real user, responses carry the browser security headers and a CSP, a token in a query string does not authenticate a normal endpoint, stored evidence requires a session, and sign-in is rate limited after its configured budget without throttling the first attempt. |

Self-healing was additionally observed end to end: renaming the demo bank's filter controls
breaks a locator, the healer proposes a replacement with a confidence score, approving it
makes the test pass on re-run, and the run is reported as *healed* rather than as a clean
pass.

## Implemented but not verified

| Area | Why not, and what it would take |
| --- | --- |
| `Dockerfile.console`, `Dockerfile.demo-bank` | Written but never built. Their base images (`nginx:1.27-alpine`, `node:22-bookworm-slim`) live on Docker Hub, which this environment's egress policy denies; only `mcr.microsoft.com` is reachable, which is why the API and worker images could be built. |
| `docker compose up` as a whole | The compose file validates, and two of its four built images were built and run. The stack has never been started end to end here, because `postgres:16-alpine` and `redis:7-alpine` cannot be pulled either. |
| `.github/workflows/qanxt-tests.yml` | The YAML parses, the pnpm filter it uses was run locally, and its embedded summary script was run against a real failing report — but the workflow itself has never executed on GitHub Actions. |
| `infrastructure/ci/azure-pipelines.yml` | Same: validated as YAML, never executed on Azure Pipelines. |
| S3-compatible artifact storage | Only the filesystem store has been run. The interface has a second implementation that has not been pointed at a real bucket. |
| OpenAI, Anthropic and Gemini providers | No API key is configured here, so every AI result so far came from the local deterministic engines. The provider abstraction is exercised; the HTTP clients for the hosted models are not. |
| Scale and concurrency | Runs here are single-worker and small. Nothing has been load-tested, and no claim is made about behaviour under parallel workers or large knowledge graphs. |

## Known gaps

These are absences rather than untested code — things a reader might reasonably expect to
exist that do not yet.

- **Remaining documentation.** Nothing links to a page that does not exist any more; the
  link check over `README.md` and `docs/*.md` finds no broken relative link. Deeper pages
  on the AI architecture, the browser engine and self-healing internals are still not
  written, and there is no hand-written API reference; the API's own reference is served
  at `/swagger`.
- **No metrics endpoint and no distributed tracing.** Correlation ids give log correlation
  across the API, the queue and the worker; there is no Prometheus target, no
  OpenTelemetry exporter and no span timing. `docs/observability.md` says so explicitly so
  that nothing elsewhere reads as claiming them.
- **The console covers a subset of the continuous-quality surfaces.** Schedules and the
  audit trail have screens; contracts, test data, release comparison and the AI request
  record are reachable through the API and the CLI only.
- **No Kubernetes manifests.** `infrastructure/kubernetes` is an empty directory. The
  compose file is the deployment topology; nothing expresses it as a chart yet.
- **The agent has not been run at scale.** Passes here covered an 8-page application. Nothing has been tried against a large knowledge graph, and no claim is made about how
  the prioritisation behaves with hundreds of routes.

## Independent verification

An adversarial verification pass was run against a live deployment and is recorded under
`verification/`, with its own environment record, traceability matrix, evidence index
(SHA-256 per artifact) and bug reports. Forty-seven checks; all pass on the current build.
It found six defects the 215-test product suite had not, including a rate limiter that had
never partitioned as designed and an SSRF flag that unlocked the cloud metadata range.

Seven of those checks (EXT-001 to EXT-007) drive the real browser extension in a real
Chromium and are themselves checked: `node verification/tests/ext-negative-control.mjs`
breaks the extension five different ways and requires each check to catch its own
breakage.

Run it with `make verify-all`. Its conclusion is **PARTIALLY VERIFIED** — see
`verification/final-report/FINAL-VERIFICATION-REPORT.md` for exactly what that excludes and
why.

## Defects found by this verification

Recorded because they are the argument for doing it this way, rather than reading the code
and declaring it correct.

| Found by | Defect |
| --- | --- |
| Integration suite | JWT inbound claim mapping rewrote `sub` and `email`, so `/auth/me` returned 401 for a valid token and — far worse — `ICurrentUser.UserId` was null on every authenticated request. Audit entries recorded no author and `CreatedByUserId` was stored as null everywhere. Confirmed on the running API before fixing. |
| Extension check | A lost-update race in the MV3 service worker dropped recorded steps: filling a username and then a password had both handlers read the recording before either wrote it back. A recording missing its password step generates a test that cannot sign in. |
| CLI check | The CLI sent `ci` as a run trigger where the platform's value is `cicd`. The cross-language parity test covered other enums but not this one. |
| Journey import check | An executed action recorded the page it landed on rather than the one it ran on, but only when it passed — so the same field meant different things depending on outcome. |
| Phase 7 review | The quality gate engine had no endpoint and no UI: gates could be evaluated but never configured, so every run reported "no quality gates are configured". |
| Phase 8 review | `make setup`, `make dev`, `make test`, `make verify`, `make migrate` and `make db-reset` all referenced scripts that did not exist. |
| Agent pass | Polling a status through a tracking `DbContext` returned the first-loaded entity forever, so the agent waited on a crawl that had already finished six minutes earlier. |
| Agent pass | `TestGenerationService` read the organization from the signed-in user, which only exists for callers with an HTTP request. The agent was the first caller without one. The DbContext already stamps the tenant on save, so the assignment was removed rather than worked around. |
| Agent pass | A phase that threw was recorded as failed, but the run still reported `completed` because the loop reached its end — exactly the kind of quiet green the platform refuses everywhere else. |
| Docker work | This page previously said no Docker daemon was available. That was wrong: the daemon simply was not running, and I had not tried starting it. The images below were built and run once it was. |
| Docker work | `make docker-down` used `down -v`, which deletes the database, the queue and every stored artifact. A command called "down" should not destroy anything; the destructive one is now `make docker-reset`. |
| Docker work | Compose reads `.env` from beside the compose file, so the documented command resolved none of the secrets and failed with an error that did not explain why. Both the Makefile and the documented command now pass `--project-directory .`. |
| Docker work | `Dockerfile.worker` claimed the worker exposes no port and health-checked it with `kill -0 1`. The worker serves `/health` on 9091, and a consumer that has lost Redis looks perfectly alive to a PID check while doing no work at all. |
| User management | Every access token carried a security stamp that nothing ever checked. Disabling an account, demoting someone or resetting a password left their existing session working for up to an hour — the token lifetime — while the UI reported success. Removing the new validator makes three tests fail, which is what that gap looked like. |
| User management | Login refused any account whose status was not `Active`, so an invited user could never sign in and every invitation was a dead end. Login now accepts `Invited` and promotes it to `Active` on first use, which is also what makes the status worth recording. |
| Extension verification | The service worker's de-duplication of consecutive edits to one field had never fired: it compared two locators by `JSON.stringify`, and `chrome.storage.session` returns keys in sorted order, so the stored locator and the incoming one never matched. Every change event became a step, corrected values included. The unit test covering it passed because its storage stub preserved key order; the stub now sorts keys as Chrome does. See `verification/failures/BUG-0006/`. |
| Golden suite (SPA discovery) | Sign-in against a single-page application was decided by two `waitForLoadState` calls, both of which return immediately when an SPA never reloads. Discovery against React reported "failed, 0 pages" while the bank's own record showed the correct credentials arriving 5ms earlier. Every React, Vue or Angular application would have behaved this way. See `verification/bugs/BUG-0007/`. |
| Golden suite (discovery model) | The crawler signed in before capturing anything, so the login page — the one page every user sees — was never in the model. Recall against ground truth was 88.9% with the missing page being `/login`. `BUG-0008`. |
| Golden suite (execution) | The recorder and the executor contradicted each other: a recorded journey that signs in itself was forced through the configured sign-in first, so it started on `/dashboard` and failed at step 2. Two shipped features, each correct alone. `BUG-0009`. |
| Golden suite (assertions) | The generated plan never carried its expected value onto the action, so `assertValue` could not pass at all and `assertText` passed vacuously at action level. Measured rather than assumed: the paired planned assertions still caught wrong values, so this produced false negatives, not false passes. `BUG-0010`. |
| Golden suite (generation) | `maxScenarios` was accepted by the API and then ignored — asking for 2 produced 11. `BUG-0011`. |
| Golden suite (analysis) | The failure classifier matched on prose the execution engine had stopped producing ("expected the text" against "Expected the element to contain"), and the same drift was duplicated in the local analyser. Classification accuracy 7/10 with 2 unknown; 10/10 after. `BUG-0012`. |
| Golden suite (reliability) | Text and value assertions read the element once. A value the page rendered after three seconds failed in 17ms, and all twenty runs against the lab's unstable application failed — including the ones it answered in a tenth of a second. `BUG-0014`. |
| Golden suite (generation) | A generated "Reject an invalid filter range" scenario closed by asserting that the filter control it had just clicked was still visible — an assertion that holds whatever the application does. The generated step's own description admitted it was a placeholder. Two more scenarios did the same. A test that cannot fail is worse than no test. `BUG-0016`. |
| My own golden test | `GEN-011` — "a generated test fails when the application it covers is broken" — passed once on a run where the only failure was an unrelated authentication blip in a two-step smoke test. A test about false passes produced one. It now chooses the fault from the routes the generated tests actually visit and counts only failures in tests that visit the broken page. |
| Golden suite (generation context) | `TestGenerationService` carries at most 30 elements per page and chose them by stability score — which the crawler gives every stable element equally, all 95 on the page in question. The order was therefore the database's, the cut arbitrary, and it varied between runs: the navigation links that appear on every page survived while the form controls unique to that one were dropped, and the same scenario filled a date range in the right order on one run and the wrong order on the next. Only visible once the generated tests asserted something real. `BUG-0016`. |
| Writing the installation guide | The API sets `Content-Security-Policy: default-src 'none'` on every response — right for an endpoint that only answers JSON, and fatal for the one page it serves as HTML. `/swagger`, which the setup guide and README both tell a newcomer to open as the API reference, rendered blank with nine same-origin resources refused. A blank page after a fresh install is indistinguishable from a broken install. `BUG-0018`. |
| Writing the user manual | The sample demo bank redirected `/` to `/login` even for a customer who was already signed in. Wrong on its own terms, and it meant that registering the application by its root URL — the obvious thing to type — produced a **one-page model**, because a crawl that starts at `/` and is bounced to the sign-in page can reach nothing else. Discovery reported "completed" while it did it: 9 pages became 1, and generation then refused because there was nothing to generate from. Fixed in the sample; the manual also tells readers to point the base URL at a page behind the sign-in. |
| Writing the installation guide | `tests/e2e/first-run-check.mjs` counted the people table immediately after its heading appeared, before the query behind it resolved — so it reported "the founder is not listed exactly once (found 0)" against a platform that was working correctly. A false failure, in the check that exists to prove the documented first run works. It now waits for the row. |
| Auditing the suite against the brief | `assertCount` and `assertAttribute` are implemented by the engine, carried by `BrowserAction` and checked by its validator — and could not be authored at all: the recorded-journey contract had no field for a count or an attribute name, `TestRunService` never copied either onto the executed action, and `MapAssertion` fell through to `_ => Visible`, so an imported count assertion silently became a visibility check pointed at a locator matching three elements. Two of nine assertion types were dead. `BUG-0017`. |
| Product demonstration | A 401 the application returns on its own sign-in page — the ordinary answer to "is anyone signed in?" — outranked the engine's statement that no element matched, so a removed button was reported as an authentication problem and the reader was sent to check account permissions. Found by the demonstration, not by a test; the classifier now has unit tests that pin the rule ordering. `BUG-0015`. |
| Writing `setup.md` | The project-key field's `pattern` attribute was `[A-Za-z0-9_-]+`. Chrome compiles that attribute with the regular-expression `v` flag, where `_-` is a reserved double punctuator, so the browser rejected the pattern outright and it validated nothing — logging a console error on every render of the form. The server still validated the key, so this was a usability defect rather than a security one. |
