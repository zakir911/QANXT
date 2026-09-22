# BUG-0021 — A quality gate rule over a metric nothing measured reported itself as satisfied

| | |
| --- | --- |
| **ID** | BUG-0021 |
| **Title** | An unmeasurable metric was read as `0`, so a rule meant to stop a release always passed |
| **Severity** | **HIGH** |
| **Found by** | Adding the API-failure metric and asking what the two metrics without measurements were doing |
| **Environment** | See `verification/environment.md` |
| **Build** | `5642a03` |
| **Component** | `apps/api/src/Aira.Application/Quality/QualityGateEvaluator.cs` |
| **Reproduction rate** | 2 of 2 |
| **Status** | Fixed and re-verified |

## What happens

The evaluator gathered its metrics into a dictionary and compared each rule against it:

```csharp
var actual = metrics.GetValueOrDefault(rule.Metric, 0m);
var passed = Compare(actual, rule.Operator, rule.Threshold);
```

Two of the seventeen metrics — `ContractBreakingChangeCount` and `SecurityFailedCount` —
have no measurement yet. A rule over either was therefore compared against zero and
reported as satisfied, with the same explanation format as a real measurement:

```
"The number of breaking API contract changes was 0, which satisfies equalling 0."
```

That sentence is not true. Nothing counted anything.

## Why it matters

This is the most expensive kind of green there is. A team configures
"no breaking contract changes" precisely because it is the thing they cannot afford, sees
the rule pass on every release, and has a gate that has never once looked.

It is also a trap that grows: every metric added to the enum ahead of its measurement
becomes a rule that silently always passes.

## Root cause

`GetValueOrDefault(metric, 0m)` conflates "the value is zero" with "there is no value".
For a count metric those read identically, and zero is the reassuring one.

## Expected

A rule whose metric this run could not measure is never reported as satisfied. It is not
a failure either — the run is not broken — so the honest answer is the third one the gate
already has: REVIEW, with an explanation saying the metric was not measured.

## Fix

- The evaluator uses `TryGetValue`, so absent is distinguished from zero.
- `QualityGateRuleResult` gains `Measured`. An unmeasured rule is returned with
  `Passed: false`, `Measured: false`, `Action = Review` and the explanation
  "… was not measured for this run, so this rule could not be evaluated. It is reported
  for review rather than treated as satisfied."
- Because review beats pass in the outcome precedence, a run with such a rule comes back
  REVIEW and exits the CLI with 7 (HUMAN_REVIEW_REQUIRED) rather than 0.

## Re-verification

Golden test API-011 configures a rule over `contractBreakingChangeCount` on a project
whose tests all pass, runs it, and asserts the whole chain:

```
PASS  API-011  run passed; rule measured=false passed=false; outcome review
```

| | Before | After |
| --- | --- | --- |
| Rule verdict | passed, "was 0, which satisfies equalling 0" | not measured, sent for review |
| Gate outcome on an otherwise-clean run | `pass` | `review` |
| CLI exit status | 0 | 7 |
