# The `qanxt` command

One binary, nine exit codes, and no output parsing.

```bash
npm install -g @qa-nxt/cli     # or: node packages/cli/dist/qanxt.js
export QANXT_API_URL=https://qanxt.example.com
export QANXT_TOKEN=…          # a service account token; never run "qanxt login" in a pipeline
export QANXT_PROJECT_ID=…
```

## Commands

| | |
| --- | --- |
| `qanxt login` | Store a session. For a person at a terminal, not for a pipeline. |
| `qanxt projects` · `qanxt apps` · `qanxt environments` | What this account can see. |
| `qanxt discover` | Crawl an application and refresh its knowledge graph. |
| `qanxt api-test` | Author, generate and run API tests. |
| `qanxt contract` | API contract baselines, and what has moved since. |
| `qanxt regression` | Run the tests a change needs, and say why. |
| `qanxt schedule` | Regression that happens without anybody asking. |
| `qanxt test-data` | The named data a test case uses. |
| `qanxt release` | What changed between runs, and whether to ship. |
| `qanxt run` | Start a run, wait for it, write reports. |
| `qanxt status [run-id]` | What a run did. |
| `qanxt quality-gate` | Evaluate a finished run against its gate. |
| `qanxt security` | Security scopes, scans, findings and the gate. Needs `security:read`; triage needs `security:triage`. See [docs/security/running-a-scan.md](security/running-a-scan.md). |
| `qanxt audit` | Who did what, and whether it worked. Needs `audit:read`. |
| `qanxt report <run-id>` | Write reports for a run that already finished. |

Every command takes `--help`.

## Exit codes

These are the contract. Anything non-zero fails a build by default, so the distinctions
cost nothing and save a misdirected investigation.

| | | Who should look |
| --- | --- | --- |
| `0` | `PASS` | — |
| `1` | `TEST_FAILURE` | Whoever owns the application or the tests |
| `2` | `QUALITY_GATE_FAILURE` | Whoever set the rule — every test was within tolerance |
| `3` | `CONFIGURATION_ERROR` | Whoever edited the pipeline |
| `4` | `AUTHENTICATION_ERROR` | Whoever holds `QANXT_TOKEN` |
| `5` | `INFRASTRUCTURE_ERROR` | The platform operator. **Nothing is known about quality** |
| `6` | `SECURITY_POLICY_VIOLATION` | Read why before retrying. Do **not** widen permissions |
| `7` | `HUMAN_REVIEW_REQUIRED` | A person. Not a pass, not a failure |
| `8` | `QANXT_INTERNAL_ERROR` | Whoever maintains QA NXT. Not a finding about your application |

Adding a code is additive. Changing what one means is a breaking change for every pipeline
keying off it.

**5 is never a pass.** It means QA NXT could not be used, so nothing was measured. A pipeline
that treats it as "no failures found" is reporting an assurance nobody gave.

**6 is not 4.** A rejected token is resolved by rotating a credential; a policy refusal is
not, and a pipeline told the wrong one will try to fix it by widening the service account.
That is the opposite of the correct response.

## Environment

| | |
| --- | --- |
| `QANXT_API_URL` | The control plane. |
| `QANXT_TOKEN` | A service account token. Sent in a header, never in a URL. |
| `QANXT_PROJECT_ID` | Which project. |
| `QANXT_ENVIRONMENT_ID` | Which deployment. Worth setting even with one environment — it carries the base URL, the allowed domains, the rate limit and the production guard. |

An exported-but-empty variable is treated as absent, which is the normal state of one a
pipeline declares and does not set.

## Artifacts

`--report-dir <dir>` writes all of these under fixed names, so a pipeline can publish the
directory without knowing what is in it:

| | |
| --- | --- |
| `junit.xml` | Every CI system already understands this. |
| `report.json` | The whole run: tests, gate rules with measured values, CI context, contracts. |
| `report.html` | The run as a person reads it. |
| `summary.md` | A pull request comment: verdict first, failures with diagnosis, rest collapsed. |
| `regression-selection.json` | What was chosen and what was left out, with reasoning. |

QA NXT writes `summary.md`; your CI system posts it. It already has the credentials to
comment, and a second set would be another thing to grant, rotate and audit.

## Gating on regressions rather than failures

```bash
qanxt release compare --run "$RUN_ID" --fail-on-new-failures
```

Exits 1 only when a test that used to pass now fails. Twelve failing tests are not a reason
to stop a release if the same twelve failed last week; one that used to pass is. This
complements the quality gate: the gate enforces a standard, this enforces a direction.

## See also

[Running from a pipeline](ci-cd.md) · [Quality gates](quality-gates.md) ·
[Regression selection](regression-selection.md) · [Scheduled regression](scheduling.md) ·
[Release quality](release-quality.md) · [Test data](test-data.md)
