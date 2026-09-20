# Running AIRA from a pipeline

AIRA is driven from CI by the `aira` command line. The CLI talks to a control plane that is
already running; it does not start one. A pipeline therefore needs three things: the URL of
that deployment, a token, and the id of what to run.

## The short version

```bash
pnpm --filter @aira/cli... build

AIRA_API_URL=https://aira.example.com \
AIRA_TOKEN="$AIRA_TOKEN" \
node packages/cli/dist/aira.js run --suite "$SUITE_ID" --report-dir reports
```

The command exits `0` if the run's quality gate passed and `1` if it did not, so a pipeline
needs no extra logic to decide whether to stop.

## Exit codes

A pipeline usually only distinguishes zero from non-zero, but "your application is broken"
and "the tooling could not run" go to different people, so the CLI separates them.

| Code | Meaning | Who should look |
| --- | --- | --- |
| `0` | The run finished and the quality gate passed | Nobody |
| `1` | Tests failed, or a blocking gate rule was not met | The team that owns the application |
| `2` | The command was used wrongly — a missing argument, a mistyped flag | Whoever edited the pipeline |
| `3` | Not signed in, the token expired, or the account lacks the permission | Whoever holds the credentials |
| `4` | The platform refused, or could not be reached | Whoever operates the deployment |
| `5` | The run did not reach a verdict within `--timeout` | Start here, then the platform operator |

A mistyped option is an error rather than something silently ignored: a `--juint` that is
quietly dropped produces a green build with no report, which looks exactly like success.

## Authentication

Never run `aira login` in a pipeline. Create a token once and store it as a secret:

```bash
aira login --email ci@example.com --org acme --show-token
```

Then set `AIRA_TOKEN` from that secret. The CLI sends the token in an `Authorization`
header and never places it in a URL, so it does not appear in access logs or in CI console
output. Nothing the CLI prints contains it.

Give the CI account the narrowest role that can start runs and read results. It does not
need permission to change quality gates — a pipeline that can relax its own gate is not a
gate.

## Reports

`--report-dir <dir>` writes all three formats; `--junit`, `--json` and `--html` write them
individually.

| File | For | Notes |
| --- | --- | --- |
| `junit.xml` | The CI system | Parsed natively by GitHub, Azure Pipelines, Jenkins, GitLab |
| `report.json` | Anything programmatic | Carries `schemaVersion`, so a consumer can refuse a shape it does not know |
| `report.html` | People | One self-contained file: no external stylesheet, font or script, so it opens from a build artifact with no network |

### How verdicts map onto JUnit

JUnit only has *pass*, *failure*, *error* and *skipped*. AIRA distinguishes more than that,
and the mapping is deliberate:

| AIRA status | JUnit | Why |
| --- | --- | --- |
| `passed` | pass | |
| `healed` | pass, with a note | The journey completed, so failing the build would be wrong. The note says a locator was rewritten, so the pass is never silent. |
| `flaky` | pass, with a note | Same. Only a *pass* is ever labelled flaky, so this can never hide a failure. |
| `failed`, `timedOut` | `<failure>` | The test ran and did not get the expected result. |
| `blocked` | `<error>` | The test could not run at all. Reporting it as a pass would claim coverage that does not exist; reporting it as a failure would send someone hunting for a defect that is not there. |
| `skipped`, `cancelled` | `<skipped>` | Not evidence of anything. |
| `pending`, `queued`, `running` | `<error>` | A finished run should not contain these. The result is unknown, and a report must not quietly drop a test it cannot account for. |

The healed and flaky notes appear in each test's `<system-out>`, and in the JSON report as a
`qualification` field that is `null` for an unqualified pass.

One detail worth knowing: the root `<testsuites time>` is the run's wall clock, while each
`<testsuite time>` is the sum of its executions. With parallel execution the suites can add
up to more than the root. That is not a contradiction — the run really did take the shorter
time.

## Quality gates

Gates are configured per project, in the console under **Settings → Quality gates**, or
through `/api/v1/quality-gates`. Each rule compares one measured value against a threshold:

| Metric | Measures |
| --- | --- |
| `passRatePercent` | Passed (including healed) as a percentage of finished |
| `failedCount` | Failed executions |
| `criticalFailedCount` | Failed executions of critical-priority tests |
| `criticalJourneyFailedCount` | Failed executions of critical-risk tests |
| `flakyCount` | Executions labelled flaky |
| `newFailureCount` | Failures not seen before |
| `highConfidenceDefectCount` | Failures the analyser attributes to the application with ≥80 confidence |
| `healedCount` | Executions that needed a locator healed |
| `averageDurationMs` | Mean execution duration |

A rule is either **blocking** or a **warning**. Only a blocking rule can fail the gate; a
warning is recorded and reported without stopping a release. Every rule reports the number
it actually saw next to the threshold it was compared against, because a gate that fails
without explaining itself gets switched off.

Changing a gate is audited, with the before and after values, since "who weakened this and
from what" is the question asked after a bad release. The platform never changes a gate on
its own.

## Templates

| File | Platform |
| --- | --- |
| `.github/workflows/aira-tests.yml` | GitHub Actions |
| `infrastructure/ci/azure-pipelines.yml` | Azure Pipelines |

Both publish the reports whether or not the gate passed — a failing run is exactly when the
evidence is needed — and both check their configuration up front so a missing variable
produces a clear message instead of a confusing authentication error later.

In the Azure template, `PublishTestResults` is deliberately set to
`failTaskOnFailedTests: false`. The build's fate is decided once, by the CLI's exit status
after the quality gate has been evaluated; letting the publish task also fail the build
would mean a warning-only rule could stop a release.

## Recording CI context

The CLI reads the common CI variables automatically, so a run in the console can be traced
back to a build without the pipeline passing anything:

| Read from | GitHub Actions | Azure Pipelines |
| --- | --- | --- |
| Provider | `GITHUB_ACTIONS` | `TF_BUILD` |
| Build | `GITHUB_RUN_ID` | `BUILD_BUILDID` |
| Commit | `GITHUB_SHA` | `BUILD_SOURCEVERSION` |
| Branch | `GITHUB_REF_NAME` | `BUILD_SOURCEBRANCHNAME` |

Override any of them with `--ci-provider`, `--ci-build`, `--ci-commit`, `--ci-branch`, and
record which build of the application was under test with `--app-build`.

## Other commands

```bash
aira discover --application "$APP_ID"     # refresh the knowledge graph before generating tests
aira status                               # recent runs in the project
aira status "$RUN_ID" --json              # one run, machine-readable
aira report "$RUN_ID" --report-dir ./out  # reports for a run that already finished
aira run --no-wait                        # queue a run, print its id, exit
```

`--no-wait` with a later `aira report` is the pattern for pipelines that separate the stage
that runs tests from the stage that publishes artifacts.

## Verifying a pipeline change

`tests/e2e/cli-check.mjs` drives the CLI against a running stack and checks what a pipeline
depends on: the exit codes, that the JUnit file parses in a real XML parser, that its
declared counts match its contents, and that breaking the application actually turns the
build red. Run it with `pnpm cli` from `tests/e2e`.
