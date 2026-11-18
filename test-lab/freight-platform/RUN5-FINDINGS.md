# QA NXT against Meridian Freight — run 5

**137 screens, 13 domains, 32 planted defects, AI disabled.**
Run 2026-11-18. Full pipeline: sign-up → discovery → generation → execution.

## What changed from run 4

| | Run 4 | Run 5 |
|---|---|---|
| Discovery | 37 pages, 31/134 screens | **151 pages, 103/134 screens** |
| Generation | 2189 cases, 192 distinct (11.4 copies) | **1431 cases, 733 distinct (2.0 copies)** |
| Execution | 186 run, 158 passed, 28 failed | **733 run, 654 passed, 79 failed** |
| Unrunnable tests | 28 of 28 failures | **6 of 79 failures** |
| Planted defects detected | 0 of 32 | **0 of 32** |

Discovery and generation are fixed. Detection has not moved.

## The three issues that were fixed

**Discovery reach was my measurement, not the product.** `runDiscovery` in the
shared verification helper sent a hard-coded `timeoutSeconds: 240` over the
application's configured 900. The platform stopped at the budget and said so in
its own run log — `Stopped: the 240s exploration budget was reached` — and the
harness that set the 240 never read it back. With the real budget, control-plane
discovery reaches 103/134, identical to a direct crawl. There was never a gap.

**Tests the browser cannot perform.** Selects driven with a literal `"1"`, date
inputs filled with text, number inputs with letters, readonly fields filled.
All 28 of run 4's failures. Now 0 of those classes appear.

**Eleven requirements producing eleven identical suites.** The planner read the
requirement only to quote it in the summary. It now scopes to the screens a
requirement names. Duplication fell from 11.4 copies to 2.0, and distinct
coverage rose from 192 to 733 cases.

## What the 79 failures actually were

| Count | Class | Verdict |
|---|---|---|
| 31 | boundary value the application may accept | the test cannot tell pass from fail |
| 20 | required-field test on a pre-populated form | the test cannot tell pass from fail |
| 17 | whitespace on a field the app may trim | the test cannot tell pass from fail |
| 6 | file input filled with text | unrunnable |
| 2 | postcode accepts punctuation only | **genuine finding** |
| 3 | locator present at discovery, absent at execution | **genuine finding** |

**68 of 79 failures were tests that could not distinguish a pass from a failure.**
A team reading this run would investigate 79 defects and find 5.

The largest single cause is a contradiction inside one scenario.
`LocalTestPlanner.cs:702` states the boundary test's objective:

> "either accepts the value cleanly or refuses it with a message. An unhandled
> error is a failure."

Its assertion is `urlContains(route)` — the URL must still be the form's. Those
are incompatible: a form that accepts the value cleanly redirects to the record
it saved, which is the success path the objective allows. The assertion reaches
for "did not land on an error page" and expresses "did not navigate at all".
Evidence from the run: the URL was `/customers/cus-002`, the saved record.

This cannot be fixed by changing the value tested. It needs an assertion the
schema does not currently have — a negated or range check on status or URL
(`httpStatusNot5xx`, or `urlNotContains`). That is a schema, runner, validator
and test change, and it is **not done**.

## The result that matters

**0 of 32 planted defects detected, for the second run.**

| | |
|---|---|
| a test ran on the defect's screen, passed, defect untouched | **25** |
| no test ever visited the screen | 7 |
| a test failed on the defect's screen | 0 |

133 of 144 discovered paths carried at least one test step. Coverage is not the
problem. The suite looked at 25 of the 32 defects and called those screens fine.

**This is an oracle gap, not a coverage gap.** The generated tests are
structural — does the page load, is the field required, are there accessibility
violations, does the URL hold. The planted defects are semantic:

- a fuel surcharge computed on gross instead of net
- customs duty excluding freight from the value for duty
- a credit limit that does not block an order
- a rate band boundary off by one kilogram
- a credit note allowed to exceed the invoice it credits

No amount of element enumeration finds those. Knowing that a surcharge belongs
on the net figure is domain knowledge, and nothing in the rules engine has it.

## The caveat that governs all of it

**This run had AI disabled.** It measures `LocalTestPlanner`, the deterministic
fallback that runs when no model provider is configured. That is the only planner
this container can run — there is no model provider configured here.

So the honest scope of this result: QA NXT's **rules-based** planner reaches a
large application well, covers its controls broadly, and detects none of its
business-logic defects. Whether the AI planner does better **is not measured and
this run says nothing about it.** It is the single most important open question,
and answering it needs a model provider.

## Defects found in QA NXT during this run

Each fixed with a test confirmed to fail against the bug, except the last.

1. Generated tests that cannot run — selects, dates, numbers, readonly fields
2. Requirement text ignored by generation
3. Requirement scoping over-matching on generic verbs (`add` matched every "Add a …" screen)
4. Worker never recovers when its queue stream disappears (93 `NOGROUP` errors, no recovery, all job types stop)
5. Required-field tests that never empty the field
6. File inputs filled with text
7. `waitForRun` returning `null`, crashing the caller and destroying a 75-minute run's report
8. **Boundary assertion contradicting its own objective — not fixed, needs a new assertion type**
