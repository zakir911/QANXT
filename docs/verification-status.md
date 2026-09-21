# Verification status

What has actually been executed, and what has not.

The point of this page is that "implemented" and "verified" are different claims, and a
reader deserves to know which one applies to each part. Everything marked **verified** was
run in this environment and observed to work; everything marked **unverified** may be
correct but has not been proved, and should be treated as untested until it is.

Last updated after the user-management work that followed Phase 9.

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
| `.github/workflows/aira-tests.yml` | The YAML parses, the pnpm filter it uses was run locally, and its embedded summary script was run against a real failing report — but the workflow itself has never executed on GitHub Actions. |
| `infrastructure/ci/azure-pipelines.yml` | Same: validated as YAML, never executed on Azure Pipelines. |
| S3-compatible artifact storage | Only the filesystem store has been run. The interface has a second implementation that has not been pointed at a real bucket. |
| OpenAI, Anthropic and Gemini providers | No API key is configured here, so every AI result so far came from the local deterministic engines. The provider abstraction is exercised; the HTTP clients for the hosted models are not. |
| Scale and concurrency | Runs here are single-worker and small. Nothing has been load-tested, and no claim is made about behaviour under parallel workers or large knowledge graphs. |

## Known gaps

These are absences rather than untested code — things a reader might reasonably expect to
exist that do not yet.

- **Remaining documentation.** Nothing links to a page that does not exist any more.
  `architecture.md`, `setup.md`, `deployment.md`, `database.md`, `ci-cd.md`, `agent.md`,
  the ADRs and this page are written. Deeper pages on the AI architecture, the browser
  engine, self-healing internals and a hand-written API reference are not; the API's own
  reference is served at `/swagger`.
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
| Writing `setup.md` | The project-key field's `pattern` attribute was `[A-Za-z0-9_-]+`. Chrome compiles that attribute with the regular-expression `v` flag, where `_-` is a reserved double punctuator, so the browser rejected the pattern outright and it validated nothing — logging a console error on every render of the form. The server still validated the key, so this was a usability defect rather than a security one. |
