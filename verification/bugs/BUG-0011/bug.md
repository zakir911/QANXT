# BUG-0011 — The scenario budget is passed to the generator and never enforced

| | |
| --- | --- |
| **ID** | BUG-0011 |
| **Title** | `maxScenarios` has no effect: asking for at most two test cases produces eleven |
| **Severity** | **MEDIUM** |
| **Found by** | GEN-009 (golden generation suite) |
| **Environment** | See `verification/environment.md` |
| **Build** | `6d5d914` |
| **Component** | `apps/api/src/Aira.Application/Testing/TestGenerationService.cs` |
| **Reproduction rate** | 2 of 2 |
| **Status** | Fixed and re-verified |

## What happens

```
asked for at most 2, created 11
asked for at most 3, created 11
```

The number generated is whatever the planner felt like producing — one per discovered page
— regardless of the budget in the request.

## Why it matters

`maxScenarios` is a documented field of the public generation API. A caller uses it to keep
a first run small, to stay inside a review budget, or to control cost when a hosted model
is configured. Silently ignoring it is worse than rejecting it: the caller believes a limit
is in force.

## Root cause

The budget is handed to the model as context and then nothing checks the result:

```csharp
var context = BuildContext(application.BaseUrl, request.Requirement, pages, request.MaxScenarios ?? 20);
…
var persisted = await PersistAsync(result.Value, suite, project, application.Id, …);
```

The built-in rules planner ignores the field entirely — it generates per page — and a
hosted model is only *asked* to respect it. Nothing between the plan and the database
enforces it.

## Expected

At most `maxScenarios` test cases are created, whatever produced the plan, and the caller
is told when a plan was truncated.

## Reproduction

```bash
bash test-lab/scripts/lab-ctl.sh start
node verification/bugs/BUG-0011/reproduce.mjs
```

## Fix

The budget is now enforced between the plan and the database, where it holds whatever
produced the plan:

```csharp
var budget = request.MaxScenarios ?? DefaultScenarioBudget;
if (budget > 0 && plan.Scenarios.Count > budget)
{
    truncated = plan.Scenarios.Count - budget;
    plan = plan with { Scenarios = plan.Scenarios.Take(budget).ToList() };
}
```

and the caller is told, rather than left to wonder why a plan was smaller than the model
proposed:

> The plan proposed 11 scenarios; 9 were dropped to stay within the requested limit of 2.

## Re-verification

| Asked for | Before | After |
| --- | --- | --- |
| 2 | 11 created | 2 created, with the warning above |
| 5 | 11 created | 5 created |

`reproduce.mjs`: 2 of 2 over budget before, 0 of 2 after. (In that script the second
attempt creates one case fewer than its budget, because the project already holds a case
with the same name from the first attempt — de-duplication, not truncation.)
