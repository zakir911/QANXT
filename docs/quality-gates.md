# Quality gates

A gate turns a run into a release decision. It has three answers, not two.

| | |
| --- | --- |
| **PASS** | Ship it. |
| **FAIL** | Do not. |
| **REVIEW** | A person has to look. |

REVIEW exists because "somebody should check this" is a real third answer, and folding it
into either of the others loses information a release decision needs. A run whose tests
only passed because a locator was silently rewritten is the obvious case: failing the build
would be wrong, the journey completed — and passing silently would hide that the test is
no longer testing what it was written to test.

REVIEW reaches the pipeline as its own exit code (`7`), so the team decides whether it
stops a deployment. That decision belongs in the pipeline, not in AIRA.

## Rules

```bash
curl -X POST "$AIRA_API_URL/api/v1/quality-gates?projectId=$AIRA_PROJECT_ID" \
  -H "authorization: Bearer $AIRA_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Ninety-five percent must pass","metric":"passRatePercent",
       "operator":"greaterThanOrEqual","threshold":95,"action":"fail",
       "message":"This project does not ship below 95%."}'
```

A rule is a metric, an operator, a threshold and an action. The `message` is the team's own
words and is quoted back whenever the rule blocks — a team that disagrees with a block
should be arguing with the rule, and they cannot do that unless the rule is quoted.

`action` is `fail`, `review` or `warn`.

`operator` is `lessThan`, `lessThanOrEqual`, `greaterThan`, `greaterThanOrEqual`, `equal` or
`notEqual`. **It has no default worth relying on.** A request that omits it, or spells the
field something else, gets `lessThan` — and `lessThan 0` on a count is a rule nothing can
satisfy, which is why the platform now refuses it:

```
400  No run can satisfy this rule: the metric is never negative, so "less than 0" can never
     hold and the gate would block every build. Did you mean "lessThanOrEqual" with a
     threshold of 0 — that is, none at all?
```

"No failing tests" is `failedCount` `lessThanOrEqual` `0`. The same refusal covers
`passRatePercent greaterThan 100`. A gate nothing can pass is a permanent block wearing the
costume of a check, and it gets switched off rather than fixed.

## Metrics

| | |
| --- | --- |
| `passRatePercent` | Passing as a proportion of finished. Healed and flaky count as passes. |
| `failedCount` · `criticalFailedCount` · `highFailedCount` · `mediumFailedCount` | Failures, by the test's priority. |
| `criticalJourneyFailedCount` | Failures on tests whose **risk** is critical. Not the same as `criticalFailedCount`, which is priority. |
| `blockedCount` | Tests that never produced a verdict. |
| `flakyCount` · `flakyRatePercent` | Tests that passed on a retry. |
| `newFailureCount` · `regressionFailedCount` | Failures that are new, and ones that used to pass. |
| `healedCount` | Tests that only passed because a locator was repaired. |
| `apiFailedCount` | Failed API tests, counted separately from UI. |
| `contractBreakingChangeCount` | Breaking API changes against the baseline. |
| `securityFailedCount` | Failed security checks. |
| `accessibilitySeriousCount` | Accessibility violations at critical or serious impact. |
| `visualDifferenceCount` | Visual checks that no longer match their baseline. |
| `averageDurationMs` | Mean execution time. |
| `highConfidenceDefectCount` | Failures the analyser is confident are application defects. |

## A metric this run could not measure

**A rule whose metric was not measured is never treated as satisfied.** It is reported as
unmeasured and sent for review:

```
The number of critical or serious accessibility violations was not measured for this
run, so this rule could not be evaluated. It is reported for review rather than
treated as satisfied.
```

This is the failure mode that matters most. A run with no accessibility step has not been
shown to have zero violations — nobody looked. Comparing an absent metric as zero turns a
rule intended to stop a release into a rule that always passes, and it does so silently,
which is why it would never be noticed.

The same applies to visual checks, contract checks, and anything else a run may or may not
have exercised.

## Self-healing and the gate

A test that only passed because AIRA repaired a locator is reported, never hidden. The
project's `SelfHealingGatePolicy` decides what that means:

| | |
| --- | --- |
| `allow` | A healed test counts as a pass and the gate says nothing. |
| `review` | The run goes to REVIEW so somebody sees the rewrite. |
| `fail` | A heal fails the run. |

The default is `review`. A rewritten locator is a change to what the test tests, and
whoever owns the test should know it happened.

## Reading a verdict

```bash
aira quality-gate --run <id>
```

Every rule comes back with the number it measured, the threshold it was judged against, its
explanation and whether it was measured at all. `report.json` carries the same, so a
pipeline can act on the numbers rather than on prose.

## What a gate is not

It is not a way to make a build green. Lowering a threshold to pass a release is a decision
somebody made, and it is in the audit trail with their name on it.

Give the CI service account permission to start runs and read results — **not** to change
quality gates. A pipeline that can relax its own gate is not a gate.

## See also

[Running from a pipeline](ci-cd.md) · [Release quality](release-quality.md) ·
[Accessibility](accessibility.md) · [Visual regression](visual-regression.md)
