# BUG-0017 — Two assertion types the engine implements cannot be authored

| | |
| --- | --- |
| **ID** | BUG-0017 |
| **Title** | `assertCount` and `assertAttribute` are executed by the browser worker but cannot be imported, and when forced through, the planned assertion beside them silently became a visibility check |
| **Severity** | **HIGH** |
| **Found by** | Auditing the assertions suite against the brief's minimum of ten |
| **Environment** | See `verification/environment.md` |
| **Build** | `8b1d8d4` |
| **Component** | `apps/api/src/Aira.Application/Journeys/JourneyImportService.cs`, `apps/api/src/Aira.Application/Testing/TestRunService.cs`, `apps/api/src/Aira.Domain/Applications/Journey.cs` |
| **Reproduction rate** | 2 of 2 |
| **Status** | Fixed and re-verified |

## What happens

The browser worker implements `assertCount` and `assertAttribute`. `BrowserAction` carries a
`count` and an `attribute`. `BrowserActionValidator` checks for them. But the recorded
journey payload — the only way to author an exact test, since there is no manual authoring
endpoint (BUG-0002) — has no field for either. The values are dropped during
deserialization, and the validator then refuses the step for lacking the very thing the
contract cannot carry:

```
assertCount      sent 5 step(s), stored [navigate, fill, fill, click], run passed — UNREACHABLE
    warning: Step 5 (“ten account cards”) was not imported: assertCount requires a count.
assertAttribute  sent 2 step(s), stored [navigate], run passed — UNREACHABLE
    warning: Step 2 (“the username field is numeric”) was not imported: assertAttribute requires an attribute name.
```

Both journeys were written to be **wrong** about the application — ten account cards where
there are three, a numeric username field that is not numeric. Both runs passed, because the
check was gone.

## Why it matters

Two of the nine assertion types the engine can evaluate are dead. A team that records a
journey to check a row count gets a test that checks nothing about the row count.

The platform's conduct is better than that summary suggests, and the difference matters: it
does not pass the step silently. It warns once per dropped step and again that the test now
contains no assertions at all. Nobody is lied to. But a capability that cannot be reached is
still a capability that does not exist, and a warning is not a substitute for the feature.

## Root cause

Three layers, each of which alone was enough to break it:

1. **`RecordedStepPayload`** had no `attribute` or `count`, so the values never survived
   deserialization.
2. **`TestRunService`** never copied `Attribute` or `Count` onto the executed action — the
   same omission BUG-0010 fixed for `Expected` and did not notice beside it. Even a stored
   step would have run with no attribute name and no count.
3. **`MapAssertion`** had no case for either action and fell through to
   `_ => AssertionType.Visible`. So an imported `assertCount` step gained a *visibility*
   assertion pointed at a locator matching three elements — and resolving a locator that
   matches three elements is an error. The step counted correctly; the planned assertion
   beside it then failed on the same locator.

The third is the one worth dwelling on. A silent `_ =>` fallback in a mapping between two
enums turns every unhandled case into a plausible-looking wrong answer. It had been there
since the journey importer was written, and nothing failed because nothing reached it.

## Expected

Both assertion types can be authored through a recorded journey, reach the engine with the
count or attribute they need, and fail when they are wrong about the application.

## Reproduction

```bash
bash test-lab/scripts/lab-ctl.sh start
node verification/bugs/BUG-0017/reproduce.mjs
```

Imports two journeys, each deliberately wrong about the bank, and reports whether the
assertion survived import and whether the run failed as it must. Before the fix: 2 of 2
unreachable. After: 0.

## Fix

- `RecordedStepPayload` gains `attribute` and `count`; both are carried into the
  `BrowserAction` that is validated, and stored on the step's `Assertion`
  (`AttributeName`, and the count in `ExpectedValue` — a count is an expectation like any
  other).
- `JourneyStep` gains `AttributeName` and `ExpectedCount` so the recording itself keeps
  them; migration `AddJourneyStepAssertionDetail` adds two nullable columns.
- `TestRunService` reads both back onto the action, exactly as it does for `Expected`.
- `MapAssertion` covers `AssertCount`, `AssertAttribute`, `AssertEnabled` and
  `AssertDisabled`, and returns `null` instead of guessing. An unmapped action now produces
  **no** planned assertion: the step itself still runs and still decides the verdict, and a
  wrong assertion is worse than none.

## Re-verification

| | Before | After |
| --- | --- | --- |
| `reproduce.mjs` | 2 of 2 unreachable, both runs passed | **0 of 2** — both stored, both runs failed |
| Assertions suite | 8 tests | **10**, all passing in both directions |
| ASRT-009 (`assertCount`) | could not be written | holds at 3 → passed; breaks at 10 → failed, "Expected 10 matching elements but found 3" |
| ASRT-010 (`assertAttribute`) | could not be written | holds → passed; breaks → failed, "Expected attribute \"name\" to be \"account-number\" but it was \"username\"" |

Two of my own expectations were wrong first, and are recorded here rather than quietly
corrected: ASRT-009 originally counted `account-card`, which the bank does not render, and
ASRT-010 asserted the username field's `type` attribute, which it does not carry — the field
is a plain `<input name="username">`. Both failed against a perfectly healthy application
until the expectation was fixed to match what the lab actually serves. A test whose
expectation is wrong is indistinguishable from a product defect until you go and look.
