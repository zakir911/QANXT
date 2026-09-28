# Running QA NXT from a pipeline

QA NXT is driven from CI by the `qanxt` command line. The CLI talks to a control plane that is
already running; it does not start one. A pipeline therefore needs three things: the URL of
that deployment, a token, and the id of what to run.

## The short version

```bash
pnpm --filter @qa-nxt/cli... build

QANXT_API_URL=https://qanxt.example.com \
QANXT_TOKEN="$QANXT_TOKEN" \
node packages/cli/dist/qanxt.js run --suite "$SUITE_ID" --report-dir reports
```

The command's exit code is the verdict, so a pipeline needs no extra logic to decide
whether to stop.

## Exit codes

A pipeline usually only distinguishes zero from non-zero, but "your application is broken",
"a rule stopped the release" and "the tooling could not run" go to three different people,
so the CLI separates them.

| Code | Name | Meaning | Who should look |
| --- | --- | --- | --- |
| `0` | PASS | The run finished and the quality gate passed | Nobody |
| `1` | TEST_FAILURE | One or more tests failed | The team that owns the application |
| `2` | QUALITY_GATE_FAILURE | Every test was within tolerance and a rule stopped it anyway | The team, and whoever set the rule |
| `3` | CONFIGURATION_ERROR | A missing argument, a mistyped flag, a project with no tests | Whoever edited the pipeline |
| `4` | AUTHENTICATION_ERROR | Not signed in, the token expired, or the account lacks the permission | Whoever holds the credentials |
| `5` | INFRASTRUCTURE_ERROR | The platform could not be reached, or the run never reached a verdict | Whoever operates the deployment |
| `6` | SECURITY_POLICY_VIOLATION | A policy refused the run — an unauthorized production environment, a target outside the boundary | Read why before retrying |
| `7` | HUMAN_REVIEW_REQUIRED | The gate's third answer: not a pass, not a failure | A person, before the release |
| `8` | QANXT_INTERNAL_ERROR | QA NXT itself failed | Report it; this is a defect in QA NXT |

`1` and `2` are separate because the conversation is different. "Six tests failed" is a
defect; "every test passed and the pass rate rule was set to 100%" is a policy argument.

`7` exists because REVIEW is a real third answer, and folding it into either of the others
loses what a release decision needs. Whether it stops a pipeline is the team's choice:
every example pipeline treats it as a warning unless `QANXT_REVIEW_BLOCKS` is set.

A mistyped option is an error rather than something silently ignored: a `--juint` that is
quietly dropped produces a green build with no report, which looks exactly like success.

## Artifacts

`--report-dir <dir>` writes the CI artifact layout — fixed names, so a pipeline can publish
the directory without knowing what is in it:

| File | What it is |
| --- | --- |
| `junit.xml` | The test result format every CI system already understands |
| `report.json` | The whole run: every test, every gate rule with the number it measured, the CI context and the contract check |
| `report.html` | The run as a person reads it |
| `summary.md` | A pull request comment: the verdict first, the failures with their diagnosis next, the rest collapsed |
| `regression-selection.json` | What `qanxt regression` chose and what it left out, with the reasoning — written when that command produced the run |

QA NXT writes `summary.md`; your CI system posts it. It already has the credentials to comment
on a pull request, and an integration needing a second set would be another thing to grant,
rotate and audit for no capability the pipeline does not have.

## Example pipelines

`infrastructure/ci/examples/` holds one per system — GitHub Actions, Azure DevOps, GitLab
CI, Jenkins, and a plain shell script the others are variations of. Each does the same six
things: deploy, wait for health, select, run, publish, comment.

They are **not verified**: running them needs credentials for that CI system and a
deployment of QA NXT it can reach, and neither exists in this repository. What is verified is
everything they depend on — the exit codes, the artifact layout, the summary, the selection
— and the whole sequence end to end, locally, in `test-lab/ci-simulation/`.

## The local simulation

`test-lab/ci-simulation/pipeline.sh` runs those same six stages, in the same order, with
the same commands, against the lab bank. Twelve scenarios put it through every exit code
above, both quality gate outcomes that are not a plain pass, and both answers a pipeline can
give to a review verdict.

```bash
node test-lab/ci-simulation/run.mjs                    # all twelve, with a report
node verification/golden-tests/run.mjs --suite ci-simulation   # the same, with evidence
```

If you are adapting a pipeline for a CI system that is not one of the four, read
`pipeline.sh` rather than the YAML: it is the part that has actually been run.

Building it found three defects, each a control that existed, was correct and was never
reached — a security refusal reported as an authentication failure, a defect in QA NXT
reported as the platform being down, and a production guard with no caller. See BUG-0026 to
BUG-0028 in `verification/bugs/`.

## Authentication

Never run `qanxt login` in a pipeline. Create a token once and store it as a secret:

```bash
qanxt login --email ci@example.com --org acme --show-token
```

Then set `QANXT_TOKEN` from that secret. The CLI sends the token in an `Authorization`
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

JUnit only has *pass*, *failure*, *error* and *skipped*. QA NXT distinguishes more than that,
and the mapping is deliberate:

| QA NXT status | JUnit | Why |
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
| `.github/workflows/qanxt-tests.yml` | GitHub Actions |
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
qanxt discover --application "$APP_ID"     # refresh the knowledge graph before generating tests
qanxt status                               # recent runs in the project
qanxt status "$RUN_ID" --json              # one run, machine-readable
qanxt report "$RUN_ID" --report-dir ./out  # reports for a run that already finished
qanxt run --no-wait                        # queue a run, print its id, exit
```

`--no-wait` with a later `qanxt report` is the pattern for pipelines that separate the stage
that runs tests from the stage that publishes artifacts.

## Verifying a pipeline change

`tests/e2e/cli-check.mjs` drives the CLI against a running stack and checks what a pipeline
depends on: the exit codes, that the JUnit file parses in a real XML parser, that its
declared counts match its contents, and that breaking the application actually turns the
build red. Run it with `pnpm cli` from `tests/e2e`.
