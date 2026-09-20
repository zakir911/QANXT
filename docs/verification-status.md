# Verification status

What has actually been executed, and what has not.

The point of this page is that "implemented" and "verified" are different claims, and a
reader deserves to know which one applies to each part. Everything marked **verified** was
run in this environment and observed to work; everything marked **unverified** may be
correct but has not been proved, and should be treated as untested until it is.

Last updated at the end of Phase 8.

## Verified by automated tests

| Area | How | Count |
| --- | --- | --- |
| Domain contracts, locators, action validation | `dotnet test` — unit | 120 tests |
| API over real HTTP against real PostgreSQL | `dotnet test` — integration | 29 tests |
| Cross-language enum parity (C# ↔ TypeScript) | `pnpm -r test` | 12 tests |
| Browser worker: healing, execution, discovery | `pnpm -r test` | 81 tests |
| CLI: reports, verdict mapping, argument parsing | `pnpm -r test` | 30 tests |
| Extension recorder: locators, recording state | `pnpm -r test` | 20 tests |
| Web console components | `pnpm -r test` | 19 tests |

Run all of them with `make test`. The integration tests need PostgreSQL; they say so
clearly if it is not running.

## Verified end to end, against a running stack

These drive the real system in a real browser. They live in `tests/e2e` and each one is run
with `pnpm <name>` from that directory.

| Check | What was observed |
| --- | --- |
| `console` | A person can sign in, read dashboard metrics computed from real runs, open the discovered application map, inspect a generated test, open a run and an execution, see a stored screenshot render through the authorized artifact path, review a healing proposal, ask the insights engine a question, and configure a quality gate — with no console errors. |
| `recorder` | The real MV3 extension loads into Chromium, recording starts from its own popup, and a journey through the demo bank is captured with the right locator preferences and the password stored as a `${secret:...}` reference rather than a value. |
| `journey` | That recording imports, generates a test case, and the generated test executes green in a real browser with every step passing, the secret masked in stored evidence, and screenshot, video, trace and network log captured. |
| `cli` | The CLI runs a real 11-test suite; the emitted JUnit parses in a browser's XML parser with its declared counts matching its contents; breaking the demo bank's transactions API turns the build red (exit 1) with the failure carried into the XML; misuse, a rejected token and an unreachable platform each exit with their own code. |
| `security` | Against production settings: a session resolves to a real user, responses carry the browser security headers and a CSP, a token in a query string does not authenticate a normal endpoint, stored evidence requires a session, and sign-in is rate limited after its configured budget without throttling the first attempt. |

Self-healing was additionally observed end to end: renaming the demo bank's filter controls
breaks a locator, the healer proposes a replacement with a confidence score, approving it
makes the test pass on re-run, and the run is reported as *healed* rather than as a clean
pass.

## Implemented but not verified

| Area | Why not, and what it would take |
| --- | --- |
| `.github/workflows/aira-tests.yml` | The YAML parses, the pnpm filter it uses was run locally, and its embedded summary script was run against a real failing report — but the workflow itself has never executed on GitHub Actions. |
| `infrastructure/ci/azure-pipelines.yml` | Same: validated as YAML, never executed on Azure Pipelines. |
| Firefox and WebKit execution | Every run so far has been Chromium. The browser is a parameter and the code paths are shared, but neither other engine has been exercised. |
| S3-compatible artifact storage | Only the filesystem store has been run. The interface has a second implementation that has not been pointed at a real bucket. |
| OpenAI, Anthropic and Gemini providers | No API key is configured here, so every AI result so far came from the local deterministic engines. The provider abstraction is exercised; the HTTP clients for the hosted models are not. |
| Scale and concurrency | Runs here are single-worker and small. Nothing has been load-tested, and no claim is made about behaviour under parallel workers or large knowledge graphs. |

## Known gaps

These are absences rather than untested code — things a reader might reasonably expect to
exist that do not yet.

- **No user management endpoint.** An organization's first administrator is created by
  registration, and the role/permission matrix is enforced, but there is no API for
  inviting a second user or changing someone's role. The integration tests mint
  reduced-permission tokens through the real token service to check authorization.
- **Remaining documentation.** `docs/setup.md`, `development.md`, `ai-architecture.md`,
  `browser-engine.md`, `self-healing.md`, `security.md`, `api.md`, `deployment.md`,
  `browser-extension.md`, `troubleshooting.md` and `database.md` are referenced in places
  but not yet written. `architecture.md`, `ci-cd.md`, the ADRs and this page exist.
- **No container or cluster manifests.** `infrastructure/docker` and
  `infrastructure/kubernetes` are empty directories. There is no Dockerfile and no compose
  file, so the "clone, `docker compose up`" path in the definition of done does not work
  today; the local stack is started with `make dev` instead. No Docker daemon is available
  in this environment, so anything written there could not be built or run, and writing an
  unrunnable compose file would be worse than an empty directory that says so.
- **Phase 9 is not started.** The autonomous agent mode, risk scoring and regression
  intelligence described in the implementation plan are not implemented.

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
