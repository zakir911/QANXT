# BUG-0019 — A new verb in the wrong number range would have reported itself as an assertion

| | |
| --- | --- |
| **ID** | BUG-0019 |
| **Title** | `IsAssertion` was the numeric range 20–89, so `ApiRequest = 30` classified a step that performs an HTTP request as a check |
| **Severity** | **HIGH** |
| **Found by** | Reading the action contract while adding the `apiRequest` verb; confirmed by a unit test over the whole enum |
| **Environment** | See `verification/environment.md` |
| **Build** | `5642a03` (latent) |
| **Component** | `apps/api/src/Aira.Application/Contracts/BrowserAction.cs`, `Testing/TestGenerationService.cs`, `Journeys/JourneyImportService.cs` |
| **Reproduction rate** | 3 of 3 (one per place that encoded the range) |
| **Status** | Fixed before the verb shipped |

## What happens

Whether a verb asserts rather than acts was decided arithmetically:

```csharp
public bool IsAssertion => (int)Action >= 20 && (int)Action < 90;
```

The assertion verbs occupy 20–28 and `ExecuteScript` is 90, so the range was correct for
the set that existed. It is not a property of the verb, though — it is a property of the
number it happens to have been given. `ApiRequest = 30` falls inside it, so a step that
performs a POST would have answered `IsAssertion == true`.

Three separate places encoded the same range independently:
`BrowserAction.IsAssertion`, `TestGenerationService.IsAssertionAction` and
`JourneyImportService.IsAssertion`.

## Why it matters

`IsAssertion` decides how a step failure is reported, and generation uses its own copy to
decide whether a scenario checks anything at all — a scenario with no assertions is dropped
with a warning. With `apiRequest` inside the range, a generated API-calling scenario would
have counted as self-asserting and been kept with nothing checked, and a failing request
would have been described as a check that found nothing wrong.

Nothing shipped in this state: it was found while adding the verb. It is recorded because
the shape of the mistake is the same one as BUG-0017's `_ => AssertionType.Visible` — a
default that turns an unhandled case into a plausible wrong answer — and because it was
latent in three files rather than one.

## Root cause

Knowledge about which verbs assert was expressed as a numeric band and duplicated. Adding
a verb inside the band was enough to change the answer in three places at once, and none
of them would have failed a test: the platform would have kept running and reported
something untrue.

## Expected

Whether a verb asserts is an explicit property of that verb, stated once.

## Fix

- `BrowserActionVerbs` is now the one place that knows: an explicit set of the nine
  assertion verbs, plus `IsApi` for the new one.
- `BrowserAction.IsAssertion`, `TestGenerationService.IsAssertionAction` and
  `JourneyImportService.IsAssertion` all delegate to it. No numeric range remains in the
  codebase (`grep ">= 20 && (int)"` returns nothing).

## Re-verification

Three unit tests in `ApiRequestValidatorTests.cs` close the gap permanently rather than
just fixing today's instance:

| Test | Asserts |
| --- | --- |
| `An_api_request_is_not_an_assertion` | `apiRequest` is an action, and `IsApi` recognises it |
| `Every_assert_verb_is_still_recognised_as_an_assertion` | enumerates every `Assert*` member and requires each to be classified as one |
| `No_other_verb_is_recognised_as_an_assertion` | enumerates every other member and requires none to be |

The last two iterate the enum itself, so any verb added on either side of the line is
covered without anyone remembering to add a case.
