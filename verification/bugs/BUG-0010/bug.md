# BUG-0010 — An assertion step loses its expected value on the way to the browser

| | |
| --- | --- |
| **ID** | BUG-0010 |
| **Title** | Assertion actions are executed with no expected value: `assertValue` always fails, `assertText` and `assertUrl` pass vacuously at the action level |
| **Severity** | **HIGH** |
| **Found by** | EXEC-009, EXEC-010 (golden execution suite) |
| **Environment** | See `verification/environment.md` |
| **Build** | `399446c` |
| **Component** | `apps/api/src/Aira.Application/Testing/TestRunService.cs` (execution plan) |
| **Reproduction rate** | 2 of 2 |
| **Status** | Fixed and re-verified |

## What happens

A test asserts that a field holds `100`. The field holds `100`. The step fails:

```
assertValue  failed  "Expected the value "" but found "100"."
```

The expected value reaching the browser is the empty string.

## Root cause

A test step is stored with its action *and* a separate assertion row. The execution plan is
built from the step:

```csharp
Action = new BrowserAction
{
    Action = step.Action,
    Description = step.Description,
    Target = LocatorDescriptor.FromJson(step.TargetJson),
    Value = step.Value,
    Url = step.Url,
    TimeoutMs = step.TimeoutMs,
    Critical = step.IsCritical
},                                    // ← no Expected
…
Assertions = step.Assertions.Select(a => new PlannedAssertionPayload
{
    …
    Expected = a.ExpectedValue        // ← the expected value lives only here
})
```

`TestStep` has no column for an expected value — it is kept on the assertion row — but the
worker evaluates an assertion-typed *action* as well as the planned assertions:

```ts
const result = await this.runStep(…);     // runs the action, including assertValue
…
for (const assertion of step.assertions) { … }   // then runs the planned assertion
```

So each assertion step is evaluated twice, and the first evaluation has no expectation:

| Action | Evaluation with an empty expectation | Effect |
| --- | --- | --- |
| `assertValue` | `'' !== '100'` | **always fails** unless the field is empty |
| `assertText` | `actual.includes('')` | always true — a vacuous pass |
| `assertUrl` | `location.href.includes('')` | always true — a vacuous pass |

## Impact

The false **negative** is the one that bites today: a correct application is reported as
broken, and the failure message blames the application (`found "100"`) rather than the
platform. That is the "no false negatives" gate in the brief, failing.

The vacuous passes do not currently produce a false green, because the paired planned
assertion still carries the expectation and is evaluated afterwards — measured, not
assumed: a text assertion with the wrong expected text and a URL assertion with the wrong
fragment both fail correctly, in both attempts. But an assertion action that reaches the
engine *without* a paired assertion row would pass no matter what the page said, and
nothing in the engine would notice.

## Expected

An assertion step carries its expectation to the browser, `assertValue` passes when the
field holds the expected value, and no assertion can pass because its expectation was
empty.

## Reproduction

```bash
bash test-lab/scripts/lab-ctl.sh start
node verification/bugs/BUG-0010/reproduce.mjs
```

Three journeys, twice each: a wrong text assertion (must fail), a wrong URL assertion (must
fail) and a correct value assertion (must pass). Before the fix, 2 of 6 verdicts are wrong
— both instances of the value assertion.

## Fix

The execution plan now carries the step's expectation onto the action, taken from the
step's own assertion:

```csharp
Expected = step.Assertions
    .OrderBy(a => a.CreatedAt)
    .Select(a => a.ExpectedValue)
    .FirstOrDefault(value => !string.IsNullOrEmpty(value))
```

Both evaluations then agree, and no assertion can pass because its expectation was empty.

## Re-verification

| Case | Before | After |
| --- | --- | --- |
| Wrong expected text | failed (correct) | failed (correct), now with the action's own message |
| Wrong URL fragment | failed (correct) | failed (correct) |
| Correct expected value | **failed (wrong)** | **passed** |

`reproduce.mjs`: 2 of 6 verdicts wrong before, 0 of 6 after.
