# QA NXT against Meridian Freight — run 9

**137 screens, 13 domains, 32 planted defects, AI disabled.**
Full pipeline: sign-up → discovery → generation → execution → security → detection.

## The headline

The noise is gone. The detection is not there.

| | Run 4 | Run 5 | **Run 9** |
|---|---|---|---|
| Discovery | 37 pages, 31/134 screens | 151, 103/134 | **152, 103/134** |
| Generation | 2189 cases, 192 distinct (11.4×) | 1431, 733 (2.0×) | **795, 561 (1.4×)** |
| Execution | 158 passed, 28 failed | 654 / 79 | **547 passed, 14 failed** |
| False failures | **28 of 28** | **68 of 79** | **0 of 14** |
| **Planted defects detected** | **0 of 32** | **0 of 32** | **0 of 32** |

A team reading run 4 would have investigated 28 defects and found none. Reading
run 9 they investigate 14 and find 14. That is the whole of the improvement, and
it is worth having: it is the difference between a suite a team trusts and one
they learn to ignore. It is not detection.

## What the 14 failures were

All 14 are the application behaving wrongly. No tool errors, no tests that
cannot tell a pass from a failure.

| Count | Finding |
|---|---|
| 12 | `Town or city*`, `Postcode*`, `Address line 1*` accept whitespace-only or punctuation-only values on **required** fields, and save them |
| 2 | `onboarding-submit` and `subnav-routes-history` discovered, absent at execution |

These are real. None is a planted defect: they are weaknesses in the lab
application that nobody planted, which the platform found correctly.

## Detection: 0 of 32

| | |
|---|---|
| found | **0** |
| possible | 0 |
| missed — screen discovered, nothing reported it | 26 |
| unreachable — discovery never reached the screen | 6 |

And the split that explains it, from the executed run:

| | |
|---|---|
| **a test ran on the defect's screen, passed, defect untouched** | **25** |
| no test ever visited the screen | 7 |
| a test failed on the defect's screen | 0 |

95 distinct paths carried test steps. **This is an oracle gap, not a coverage
gap.** The suite looked at 25 of the 32 defects and called those screens fine.

The generated tests ask: does the page load, is the field required, is the field
rejected when given something invalid, are there accessibility violations, did
the server return a 5xx. The planted defects are:

- a fuel surcharge computed on gross instead of net
- customs duty excluding freight from the value for duty
- a credit limit that does not block an order
- a rate band boundary off by one kilogram
- a credit note allowed to exceed the invoice it credits

Nothing in a rules engine knows where a surcharge belongs. Fixing the assertions
raised the signal-to-noise ratio from 0/28 to 14/14 and moved detection by zero,
because **detection is limited by what the tests do, not by what they assert.**

## Why the new oracle did not help detection

`assertNoServerError` was added so a boundary test could say what its objective
says. It removed 31 false failures. It detects none of the four crash defects:

| Defect | Trigger | Reachable? |
|---|---|---|
| FP_D18 | `/shipments?q=` over 500 characters | No — the battery tries one length, 256 |
| FP_D19 | oversize file upload | No — file inputs are now skipped entirely |
| FP_D20 | opening one invoice with a broken reference | No — detail pages get a smoke check, not the oracle |
| FP_D31 | an API error body | No — UI tests only |

FP_D19 is a cost taken knowingly: skipping file inputs traded a guaranteed false
failure for an unreachable defect. FP_D18 would be reached by a longer boundary
value, and real boundary testing tries several magnitudes rather than one. That
change was **not** made here, because sizing a value to a defect this exercise
planted is fitting the product to its own measurement.

## The operational finding that matters most

The test names in this run read `Edit AAAAAAAAAAAAAAA`. Discovery recorded those
titles, which means run 7's boundary tests **permanently renamed three customers
to 256 A's**:

```
/customers/cus-001       AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
/customers/cus-001/edit  Edit AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
```

`AllowStateChangingClicks` exists to stop the **crawler** touching data, and its
comment says "Off, and meant to stay off anywhere real." **Execution has no
equivalent.** The platform protects the application while crawling it and writes
to it freely while testing it, with no isolation, no reset and no warning.

Before this runs against a real application: these tests change real records.

## The security scan reported nothing, and that is not a clean result

The scan ran for 144 seconds, found things, and its completion answered 500 on a
duplicate key. Every finding was discarded and the scan was abandoned an hour
later. The run's security figure is 0 findings; the honest reading is that no
security result was obtained. Fixed after this run; not re-measured.

## The caveat that governs every number here

**AI is disabled throughout.** This measures `LocalTestPlanner`, the
deterministic fallback used when no model provider is configured — the only
planner this container can run. Whether the AI planner detects business-logic
defects is **unmeasured**, and 0 of 32 is not the product's ceiling. It is the
ceiling of a rules engine, which is the thing that was measured.

## Defects found in QA NXT across runs 4–9

Each fixed with a test confirmed to fail against the bug.

1. Generated tests that cannot run — selects, dates, numbers, readonly fields
2. Requirement text ignored by generation
3. Requirement scoping over-matching on generic verbs
4. Worker never recovers when its queue stream disappears
5. Required-field tests that never empty the field
6. File inputs filled with text
7. `waitForRun` returning null, destroying a 75-minute run's report
8. Boundary assertion contradicting its own objective
9. A form oracle given an assertion that needs a locator — all 13 oracles affected
10. Late progress updates reporting a crawl that found almost nothing
11. Stranded-run sweep killing crawls at their own budget
12. Duplicate scan↔finding links discarding a whole security scan

Four of these were invisible to 1061 unit tests and appeared only against a real
multi-screen application: the required-field clear, file inputs, the oracle
mapping, and the stranded-run grace.
