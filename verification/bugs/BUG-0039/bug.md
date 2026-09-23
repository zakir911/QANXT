# BUG-0039 — A quality gate rule that no run could ever satisfy was accepted, and blocked every build

| | |
| --- | --- |
| **ID** | BUG-0039 |
| **Title** | `QualityGateRuleRequest.Operator` is a non-nullable enum, so a request that omits it — or misspells the field — silently gets `LessThan` (0); with a threshold of 0 the rule reads "fewer than zero", which no run can satisfy, and the API returned 201 |
| **Severity** | **HIGH** |
| **Found by** | The continuous-quality demonstration: after the injected fault was cleared the run was green, and the gate still said FAIL |
| **Environment** | See `verification/environment.md` |
| **Build** | `7f50d74` |
| **Component** | `apps/api/src/Aira.Application/Quality/QualityGateService.cs` |
| **Reproduction rate** | 3 of 3 |
| **Status** | Fixed and re-verified |

## What happens

The demonstration asked for the most ordinary rule a team writes — "no failing tests" — and
sent the field as `comparison` rather than `operator`. System.Text.Json ignored the unknown
field, `Operator` took its default of `LessThan`, and the rule was stored as
`failedCount < 0`.

The API returned 201. Nothing said anything. The symptom only appeared two acts later:

```
17. Fix it
    run passed: 3 passed, 0 failed
    gate outcome: FAIL
      still blocking — No failing tests: measured 0 against 0
        — The number of failed tests was 0, which fails being below 0.
```

A green run, blocked by a rule named "No failing tests", because zero is not below zero.

## Why it matters

Every metric this gate measures is non-negative: counts, a percentage, a duration. So
`< 0` can never hold for any of them, and a rule carrying it is not a check — it is a
permanent block wearing the costume of one.

The way it arrives is what makes it dangerous. Nobody types "less than zero failing tests".
They omit the field, or spell it the way their last tool spelled it, and a required enum
quietly becomes its zeroth member. The rule then looks right in every listing — name,
metric, threshold all as intended — and only the operator is wrong. A team would reasonably
conclude the gate was broken, or worse, delete the rule.

The intent to prevent this was already in the file. The comment above the percentage check
reads "a threshold that can never be met turns the gate into a permanent block" — the idea
was right and the coverage was one case short.

It is the same principle the product already applies elsewhere and did not apply here:
API-006 refuses a test that asserts nothing, and REG-011 refuses a regression rule that
would silently match nothing. A gate rule nothing can satisfy is the same defect.

## Reproduction

```
$ curl -X POST "$AIRA_API_URL/api/v1/quality-gates?projectId=$P" -H "authorization: Bearer $T" \
    -d '{"name":"No failing tests","metric":"failedCount","threshold":0}'
201 Created      # operator defaulted to lessThan
```

Three attempts, three 201s, each producing a rule that fails a green run.

## Fix

Refuse the unsatisfiable shapes in `Validate`, with a message that names the likely
intention rather than just rejecting:

```csharp
if (request.Operator == QualityGateOperator.LessThan && request.Threshold == 0)
{
    errors["operator"] = new[]
    {
        "No run can satisfy this rule: the metric is never negative, so \"less than 0\" "
        + "can never hold and the gate would block every build. Did you mean \"lessThanOrEqual\" "
        + "with a threshold of 0 — that is, none at all?"
    };
}
```

and the percentage counterpart, `greaterThan 100`, which cannot hold either.

The message matters as much as the refusal. "Invalid operator" would send somebody to the
enum documentation; naming the rule they almost certainly meant sends them to the fix.

## Re-verification

```
lessThan 0        -> 400 No run can satisfy this rule: the metric is never negative, so "less than 0" can never hold…
operator omitted  -> 400 No run can satisfy this rule: the metric is never negative, so "less t…
lessThanOrEqual 0 -> 200 lessThanOrEqual
```

The omitted-operator case is the one that mattered: it is refused now rather than defaulting
into the trap. The correct rule is still accepted and stores the operator it was given.

Covered from outside by CI-008.

## A note on how this was found

Not by reading the code, and not by a test. The demonstration narrates what actually
happened at each step, and act 17 said the build was green and the gate said no. A
demonstration that had printed "gate: FAIL" without the rule detail would have looked like a
successful demonstration of a gate blocking a build.
