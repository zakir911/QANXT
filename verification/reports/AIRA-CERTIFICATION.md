# AIRA certification

**Status: CERTIFIED**

Run `2026-09-21T12-26-40Z` · build `5bf2579` · generated 2026-09-21T12:48:39.671Z

10 of 10 questions answered YES, 0 NO, 0 NOT VERIFIED.
Every answer below is derived from golden tests that executed in this run; none is asserted.

| | |
| --- | --- |
| Golden tests executed | 121 of 125 |
| Passed | 121 |
| Failed | 0 |
| Not verified | 4 |
| **False-healing rate** | **0.0%** (0 incorrect heals) |
| Healing confidence margin | 16 points |
| Discovery recall / precision | 100.0% / 100.0% |
| Failure classification accuracy | 100.0% |

---

## 1. Can AIRA discover a real web application?

**YES**

Measured against hand-written ground truth for a React single-page application, and repeated against one whose element ids are regenerated on every render.

| Test | Result | Detail |
| --- | --- | --- |
| DISC-001 | **PASS** | status completed, 11 page(s) in 18s |
| DISC-002 | **PASS** | recall 100.0% (9/9) |
| DISC-003 | **PASS** | precision 100.0% |
| DISC-004 | **PASS** | found, requiresAuthentication=false |
| DISC-011 | **PASS** | recall 83% of 12 browsable endpoint(s); sign-in POST observed: true; missing DELETE /api/session, GET /api/statements/:id/download |
| DISC-012 | **PASS** | 9 transition(s), 0 dangling |
| DISC-015 | **PASS** | 6 page(s) (recall 100%), 111 element(s), 0 locator(s) bound to a generated id |

Evidence: 7 artifact(s) under `verification/evidence/`

---

## 2. Can it generate meaningful tests?

**YES**

Meaningful is judged by structure, locator quality and how much of the application the tests reach — not by how the text reads. No model provider is configured here, so this measures the built-in rules engine.

| Test | Result | Detail |
| --- | --- | --- |
| GEN-001 | **PASS** | 5 case(s), 5 with an assertion, 13 step(s) total; provider local/aira-rules-v1; requirement keywords present: balance, dashboard |
| GEN-002 | **PASS** | 5 case(s), 5 with an assertion, 13 step(s) total; provider local/aira-rules-v1; requirement keywords present: statement, download |
| GEN-003 | **PASS** | 5 case(s), 5 with an assertion, 13 step(s) total; provider local/aira-rules-v1; requirement keywords present: payment, pay |
| GEN-004 | **PASS** | 5 case(s), 5 with an assertion, 13 step(s) total; provider local/aira-rules-v1; requirement keywords present: payment, amount, invalid, valid |
| GEN-005 | **PASS** | 5 case(s), 5 with an assertion, 13 step(s) total; provider local/aira-rules-v1; requirement keywords present: login, credential |
| GEN-007 | **PASS** | 100.0% stable of 40 targeted step(s): testId=40 |
| GEN-008 | **PASS** | 25/25 case(s) carry an objective, preconditions and expected results |
| GEN-012 | **PASS** | 6/9 distinct page(s) appear in a generated step (67%), across 9 generated case(s); 8/11 before collapsing repeated routes; 9 case(s) from one unbudgeted generation |

Evidence: 8 artifact(s) under `verification/evidence/`

---

## 3. Can generated tests actually execute?

**YES**

Executed unedited in a real browser: they pass against a healthy application and at least one fails once it is broken.

| Test | Result | Detail |
| --- | --- | --- |
| GEN-010 | **PASS** | 5/5 generated test(s) passed: TC-0001 passed, TC-0002 passed, TC-0003 passed, TC-0004 passed, TC-0005 passed |
| GEN-011 | **PASS** | FAULT_EMPTY_TRANSACTIONS on /transactions (the transactions list renders nothing): 1/2 test(s) that visit that page failed (all 5 passed when it was healthy): TC-0001 pas |

Evidence: 2 artifact(s) under `verification/evidence/`

---

## 4. Can it detect real failures?

**YES**

Eleven failure classes, each on its own page of an application otherwise identical in shape, plus a control where nothing is broken.

| Test | Result | Detail |
| --- | --- | --- |
| DET-001 | **PASS** | passed, 4/4 steps; 1 screenshot(s) |
| DET-002 | **PASS** | failed, 3/4 steps; failed at step 4 (assertText): Expected the element to contain "OK 42" but it read "failed" (waited 15060ms).; 2 screenshot(s); classified applicationD |
| DET-003 | **PASS** | failed, 3/4 steps; failed at step 4 (assertText): Expected the element to contain "OK 42" but it read "failed" (waited 15064ms).; 2 screenshot(s); classified authenticati |
| DET-004 | **PASS** | failed, 3/4 steps; failed at step 4 (assertText): Expected the element to contain "OK 42" but it read "failed" (waited 15051ms).; 2 screenshot(s); classified authenticati |
| DET-005 | **PASS** | failed, 3/4 steps; failed at step 4 (assertText): Expected the element to contain "OK 42" but it read "failed" (waited 15085ms).; 2 screenshot(s); classified applicationD |
| DET-006 | **PASS** | failed, 3/4 steps; failed at step 4 (assertText): Expected the element to contain "OK 42" but it read "failed" (waited 15029ms).; 2 screenshot(s); classified applicationD |
| DET-007 | **PASS** | failed, 3/4 steps; failed at step 4 (assertText): Expected the element to contain "OK 42" but it read "calculating…" (waited 15032ms).; 2 screenshot(s); classified applic |
| DET-008 | **PASS** | failed, 3/4 steps; failed at step 4 (assertText): Expected the element to contain "OK 42" but it read "failed" (waited 15041ms).; 2 screenshot(s); classified networkIssue |
| DET-009 | **PASS** | failed, 3/4 steps; failed at step 4 (assertText): Expected the element to contain "OK 42" but it read "calculating…" (waited 15058ms).; 2 screenshot(s); classified applic |
| DET-010 | **PASS** | failed, 3/4 steps; failed at step 4 (assertText): Expected the element to contain "OK 42" but it read "OK 99" (waited 15050ms).; 2 screenshot(s); classified applicationDe |
| DET-011 | **PASS** | failed, 3/4 steps; failed at step 4 (assertText): testId="outcome" could not be used: No element matched testId="outcome".; 2 screenshot(s); classified locatorChange |
| DET-012 | **PASS** | http-500: passed, timeout: passed, connection-reset: passed |

Evidence: 12 artifact(s) under `verification/evidence/`

---

## 5. Can it analyse failures?

**YES**

Classification accuracy is measured against the lab's expectations; an analysis never overturns a verdict; the same failure twice is recognised.

| Test | Result | Detail |
| --- | --- | --- |
| FA-001 | **PASS** | 10/10 failure(s) recorded with a category, message and signature |
| FA-012 | **PASS** | 10/10 correct (100%), 0 classified as unknown |
| FA-013 | **PASS** | 10/10 failure(s) analysed; 10 carry a summary, likely cause and suggested action; providers: local (deterministic) |
| FA-014 | **PASS** | 10/10 run(s) remained failed after analysis |
| FA-015 | **PASS** | signatures match; second run isNewFailure=false, occurrences 2 |

Evidence: 5 artifact(s) under `verification/evidence/`

---

## 6. Can it safely self-heal locator changes?

**YES**

Healing is proposed under the default policy and applied only under an opt-in one; a healed run is reported as healed; the stored test is never rewritten.

| Test | Result | Detail |
| --- | --- | --- |
| HEAL-G01 | **PASS** | passed, 5/5 steps, reached /welcome: true |
| HEAL-G02 | **PASS** | failed; 1 healing event(s), 0 applied; confidence 79; proposals: proposed |
| HEAL-G03 | **PASS** | passed; 1 heal(s) applied at 79%; best candidate 79% against a threshold of 75; reached /welcome: true |
| HEAL-G04 | **PASS** | run status "passed"; the click records wasHealed=true at 79% confidence |
| HEAL-G05 | **PASS** | the stored click still targets {"strategy":"testId","value":"login-submit","exact":false,"fallbacks":[]} |
| HEAL-G06 | **PASS** | passed; 1 heal(s) at 93%; best candidate 93% |
| HEAL-G08 | **PASS** | at threshold 100: failed, 0 heal(s) applied, best candidate 79% |

Evidence: 7 artifact(s) under `verification/evidence/`

---

## 7. Can it correctly refuse unsafe healing?

**YES**

Ten scenarios that must be refused. In each the run must fail AND the browser must never reach the signed-in page. The false-healing rate and the confidence margin are reported as numbers.

| Test | Result | Detail |
| --- | --- | --- |
| HEAL-N01 | **PASS** | failed; heals applied: 0; reached /welcome: false; classified as locatorChange; no candidate reached the threshold |
| HEAL-N02 | **PASS** | failed; heals applied: 0; reached /welcome: false; classified as locatorChange; 1 candidate(s) considered, best 51% |
| HEAL-N03 | **PASS** | failed; heals applied: 0; reached /welcome: false; classified as locatorChange; no candidate reached the threshold |
| HEAL-N04 | **PASS** | failed; heals applied: 0; reached /welcome: false; classified as locatorChange; no candidate reached the threshold |
| HEAL-N05 | **PASS** | failed; heals applied: 0; reached /welcome: false; classified as locatorChange; 1 candidate(s) considered, best 84% |
| HEAL-N06 | **PASS** | failed; heals applied: 0; reached /welcome: false; classified as locatorChange; 1 candidate(s) considered, best 94% |
| HEAL-N07 | **PASS** | failed; heals applied: 0; reached /welcome: false; classified as locatorChange; 1 candidate(s) considered, best 93% |
| HEAL-N08 | **PASS** | failed; heals applied: 0; reached /welcome: false; classified as locatorChange; 1 candidate(s) considered, best 63% |
| HEAL-N09 | **PASS** | failed; heals applied: 0; reached /welcome: false; classified as locatorChange; no candidate reached the threshold |
| HEAL-N10 | **PASS** | failed; heals applied: 0; reached /welcome: false; classified as locatorChange; 1 candidate(s) considered, best 84% |
| HEAL-M01 | **PASS** | 12 opportunities: 2 correctly healed, 10 correctly refused, 0 wrongly healed, 0 missed — false-healing rate 0.0% |
| HEAL-M02 | **PASS** | healable: renamed control 79%, test id changed 93%; highest wrong-target candidate 63% (AMBIGUOUS_CONTROLS 51%, CONTROL_IS_LINK_ELSEWHERE 63%); margin +16 points. Findabl |

Evidence: 12 artifact(s) under `verification/evidence/`

---

## 8. Can it avoid false PASS results?

**YES**

Includes a payment that is confirmed on screen and never recorded, a value that is wrong rather than missing, and every assertion type exercised in both directions.

| Test | Result | Detail |
| --- | --- | --- |
| DET-010 | **PASS** | failed, 3/4 steps; failed at step 4 (assertText): Expected the element to contain "OK 42" but it read "OK 99" (waited 15050ms).; 2 screenshot(s); classified applicationDe |
| DET-011 | **PASS** | failed, 3/4 steps; failed at step 4 (assertText): testId="outcome" could not be used: No element matched testId="outcome".; 2 screenshot(s); classified locatorChange |
| FA-016 | **PASS** | failed; the confirmation banner passed, the payment list assertion failed |
| ASRT-001 | **PASS** | holds → passed; breaks → failed; message: testId="no-such-element-anywhere" could not be used: No element matched testId="no-such-element-anywhere". |
| ASRT-002 | **PASS** | holds → passed; breaks → failed; message: Expected the element to contain "Something Else Entirely" but it read "Dashboard" (waited 15089ms). |
| ASRT-003 | **PASS** | holds → passed; breaks → failed; message: Expected the URL to contain "/nowhere-at-all" but it was "http://localhost:4300/dashboard". |
| ASRT-004 | **PASS** | holds → passed; breaks → failed; message: Expected the value "999" but found "250" (waited 15033ms). |
| ASRT-005 | **PASS** | holds → passed; breaks → failed; message: The element was expected to be hidden but was visible. |
| GEN-011 | **PASS** | FAULT_EMPTY_TRANSACTIONS on /transactions (the transactions list renders nothing): 1/2 test(s) that visit that page failed (all 5 passed when it was healthy): TC-0001 pas |

Evidence: 9 artifact(s) under `verification/evidence/`

---

## 9. Can it operate repeatedly?

**YES**

Ten identical runs, twenty runs against a genuinely unstable application, and ten runs started at the same moment.

| Test | Result | Detail |
| --- | --- | --- |
| REL-001 | **PASS** | 10/10 passed; verdicts: passed; duration 598–705ms (median 658ms) |
| REL-002 | **PASS** | 7 passed, 13 failed across 20 runs; delays the application served: 100ms, 800ms, 2500ms, 6000ms |
| REL-003 | **PASS** | the platform records 20 execution(s): 7 passed, 13 failed, flakiness score 78; this suite observed 7/20 passing |
| REL-005 | **PASS** | 10/10 reached a verdict, 10 passed; statuses: passed |

Evidence: 4 artifact(s) under `verification/evidence/`

---

## 10. Can it produce physical evidence?

**YES**

Screenshots, a Playwright trace, console and network logs, and a screenshot per discovered page — each recorded with a SHA-256 in the evidence index.

| Test | Result | Detail |
| --- | --- | --- |
| EXEC-012 | **PASS** | 1 screenshot(s), 5 artifact(s) in total |
| EXEC-013 | **PASS** | 1 trace(s), 927552 bytes |
| EXEC-014 | **PASS** | 8 network event(s) of which 7 are API calls; 1 console event(s) |
| DET-002 | **PASS** | failed, 3/4 steps; failed at step 4 (assertText): Expected the element to contain "OK 42" but it read "failed" (waited 15060ms).; 2 screenshot(s); classified applicationD |
| DISC-014 | **PASS** | 11/11 page(s) have a screenshot |

Evidence: 6 artifact(s) under `verification/evidence/`


---

## What this certification does not say

- It says nothing about a hosted model provider. None is configured in this environment, so
  every generation and analysis figure above describes AIRA's built-in deterministic rules,
  which the platform labels as such in its own responses.
- It says nothing about Firefox or WebKit. Neither browser is installed here and the
  Playwright CDN is unreachable, so those runs are recorded NOT VERIFIED rather than failed.
- It says nothing about behaviour at scale. The applications are small, the data sets are
  fixed, and the runs are measured on one machine whose specification is recorded in
  `verification/environment.md`.
- It is not an independent certification. The same author wrote the platform, the test lab
  and these tests. What it offers instead is falsifiability: every claim names a test, every
  test is a script, and every artifact is hashed.

## How to disprove it

```bash
./scripts/verify-product
```

Runs everything from infrastructure to this document. If a claim here is wrong, that command
will say so.
