# BUG-0016 — The generator emits an assertion that cannot fail

| | |
| --- | --- |
| **ID** | BUG-0016 |
| **Title** | A generated "Reject an invalid filter range" scenario closes by asserting that the control it just clicked is still visible, so the generated test cannot fail whatever the application does |
| **Severity** | **HIGH** |
| **Found by** | GEN-011 (golden generation suite) |
| **Environment** | See `verification/environment.md` |
| **Build** | `98c0687` |
| **Component** | `apps/api/src/Aira.Infrastructure/Ai/Providers/LocalTestPlanner.cs` |
| **Reproduction rate** | 2 of 2 |
| **Status** | Fixed and re-verified |

## What happens

`ListScenarios` produces a negative scenario for any list page with a filter: enter a start
date after the end date, apply the filter, then assert — that the filter button is visible.

```csharp
filterSteps.Add(Step("Apply the filter", "click", Locator(filter)));
filterSteps.Add(StepWithAssertion("Confirm the invalid range is reported", "assertVisible", Locator(filter),
    Assertion("visible", Locator(filter),
        description: "Review this assertion: replace it with the application's own validation message locator.")));
```

The filter control was visible before the click and is visible after it. The assertion holds
whether the application reports the invalid range, silently returns everything, or does
nothing at all. The generated step's own description admits the assertion is a placeholder —
and the placeholder ships as a passing test.

## Why it matters

A test that cannot fail is worse than no test: it occupies a line in a report, is counted in
coverage, and tells a reader that a behaviour is checked when nothing is checked. The
platform's own principle is that a pass means the expected behaviour was observed; this
scenario observes nothing.

It also passed every structural check the suite had. `GEN-001`…`GEN-005` require each case
to carry an assertion, and this case carries one. Counting assertions is not the same as
asking whether an assertion can fail.

## Root cause

The generator has no element to assert on. A validation message only exists in the DOM once
validation has failed, so discovery — which crawls a healthy application — never sees it.
Rather than decline the scenario, the generator fell back to the only locator it had.

## Expected

The closing assertion must be about something the action could change. In order of how
directly each answers "did the application refuse the range?":

1. An element that reports problems (`role=alert`/`status`, or a name mentioning error,
   validation, invalid or warning) → assert it became visible.
2. The list's own empty-state indicator → assert it became visible.
3. The records table → assert it is **hidden**: no record can fall inside an impossible
   range, so a filter that listed records would fail this step.

If none of the three exists, the scenario is not generated at all.

## Also fixed here

Every scenario on a single-page application was named after the page title, and an SPA
serves one `<title>` for every route — so one generation produced three cases all called
"View AIRA Demo Bank". Where a title does not distinguish a page, the route is now appended.
Three identically named cases are not a suite a reviewer can act on.

## Reproduction

```bash
bash test-lab/scripts/lab-ctl.sh start
node verification/bugs/BUG-0016/reproduce.mjs
```

Generates against the bank twice and reports every assertion that targets an element an
earlier step in the same test already acted on. Before the fix: 2 of 2 generations contain
one. After: none.

## Why the suite did not catch this sooner

`GEN-011` — "a generated test fails when the application it covers is broken" — passed on an
earlier run, and should not have. It enabled a wrong balance and an empty transaction list
whatever the generated tests covered, then accepted *any* failure as proof. On that run the
only failing test was a two-step smoke test that failed with `authenticationIssue`, which
had nothing to do with either fault. A test about false passes produced one.

`GEN-011` now chooses a fault from the routes the generated tests actually visit, and counts
a failure only in a test that visits the page that was broken. If no generated test reaches
a page the lab can break, that is reported as a failure rather than as a pass, because a
generated suite that cannot detect a defect is the finding.

## Fix

Three changes in `LocalTestPlanner`, all of the same shape — do not assert something the
action could not change:

1. **Filter scenario.** The closing assertion targets a problem-reporting element
   (`role=alert`/`status`, or a name mentioning error, validation, invalid, warning), else
   the list's empty-state element, else the records table with `assertHidden`. The scenario
   is generated only when both date inputs were discovered *and* one of those three targets
   exists: a scenario that never enters a range has nothing to say about one.
2. **Form happy path.** A confirmation element is asserted where discovery found one. Where
   it did not, no closing assertion is generated at all and `expectedResults` says so. The
   scenario keeps its value — the fill and click steps still fail if the form is broken —
   without claiming to have verified a success it cannot see.
3. **Naming.** Where several pages share a title, the route is appended.

## Re-verification

| | Before | After |
| --- | --- | --- |
| `reproduce.mjs` | 2 of 2 generations contained an assertion that cannot fail (4 in total) | **0** |
| GEN-010 (generated tests pass against a healthy application) | 5/5 | 5/5 |
| GEN-011 (and fail when it is broken) | **failed** — 0 of 4 failed under the injected faults | **passed** — `FAULT_EMPTY_TRANSACTIONS` on `/transactions`, 1 of 1 test visiting that page failed |
| GEN-012 (coverage of discovered pages) | 89% | 67% |
| Generation suite | 14/16, 1 critical failure | **15/16**, 0 failures, 1 NOT VERIFIED |

The coverage drop is the fix working. Three of the scenarios that made up the old 89% were
the placeholder ones; a generator that writes fewer tests it can stand behind is worth more
than one that pads the number. The threshold GEN-012 enforces is 50%.

The first attempt at the fix made GEN-010 fail — the new `assertHidden` was generated for a
page whose date inputs had been truncated out of the generation context by the 30-element
per-page cap, so the scenario clicked the filter with no range entered and then asserted
that an unfiltered list was empty. A healthy application failed that test. Requiring both
date inputs before generating the scenario is the second change above; the first attempt is
recorded here rather than quietly amended, because it is the same class of mistake as the
defect: asserting something the steps did not establish.
