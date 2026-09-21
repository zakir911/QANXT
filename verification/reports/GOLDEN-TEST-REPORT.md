# Golden test report

Run `2026-09-21T09-27-06Z` · build `6bf8a08` (working tree dirty) · generated 2026-09-21T09:45:25.561Z

**121 passed, 0 failed, 4 not verified** of 125 golden tests.
No critical test failed.

## Quality gates

| Gate | Result | Executed | Failures | Not verified |
| --- | --- | --- | --- | --- |
| Functional | **PASS** | 26/28 | — | EXEC-015, EXEC-016 |
| Discovery | **PASS** | 15/15 | — | — |
| AI | **PASS** | 31/32 | — | GEN-016 |
| Self-healing | **PASS** | 20/20 | — | — |
| Security | **PASS** | 11/11 | — | — |
| Reliability | **PASS** | 6/7 | — | REL-007 |
| Failure detection | **PASS** | 12/12 | — | — |
| Evidence | **PASS** | 121/125 | — | — |

**Overall: PASS** — a gate is green only when every executed test in it passed.

## Metrics

### Discovery
| | |
| --- | --- |
| Page recall against ground truth | 100.0% |
| Page precision | 100.0% |
| API endpoint recall | 83.3% |
| Elements preferring a stable locator | 100.0% |
| Pages / elements discovered | 11 / 259 |
| Crawl duration | 15s |

### Generation
| | |
| --- | --- |
| Discovered pages reached by generated tests | 66.7% |
| Generated steps using a stable locator | 100.0% |
| Generated tests executed / passed on a healthy application | 5 / 5 |
| Generated tests that failed once the application was broken | 1 |

### Self-healing
| | |
| --- | --- |
| Healing opportunities | 12 |
| Correct heals | 2 |
| Correct rejections | 10 |
| **Incorrect heals** | **0** |
| Missed heals | 0 |
| Healing success rate | 100.0% |
| **False-healing rate** | **0.0%** |
| Confidence margin (lowest healable − highest wrong target) | 16 points (79% vs 63%) |

### Failure analysis
| | |
| --- | --- |
| Classification accuracy | 100.0% (10/10) |
| Classified "unknown" | 0 |

### Reliability
| | |
| --- | --- |
| Repeatability | 10 runs, 1 distinct verdict(s) |
| Flaky application | 7 passed / 13 failed of 20 |
| Concurrency | 10/10 concurrent runs reached a verdict |

### Result integrity
| | |
| --- | --- |
| Checks that would catch a false pass | 12 |
| **False passes observed** | **0** |
| Checks that would catch a false failure | 5 |
| **False failures observed** | **0** |

## Results

| ID | Suite | Severity | Result | Objective | Detail |
| --- | --- | --- | --- | --- | --- |
| ASRT-001 | Assertions | critical | **PASS** | assertVisible holds when it should and fails when it should not | holds → passed; breaks → failed; message: testId="no-such-element-anywhere" could not be used: No element matched testId="no-such-element-anywhere". |
| ASRT-002 | Assertions | critical | **PASS** | assertText holds when it should and fails when it should not | holds → passed; breaks → failed; message: Expected the element to contain "Something Else Entirely" but it read "Dashboard" (waited 15075ms). |
| ASRT-003 | Assertions | critical | **PASS** | assertUrl holds when it should and fails when it should not | holds → passed; breaks → failed; message: Expected the URL to contain "/nowhere-at-all" but it was "http://localhost:4300/dashboard". |
| ASRT-004 | Assertions | critical | **PASS** | assertValue holds when it should and fails when it should not | holds → passed; breaks → failed; message: Expected the value "999" but found "250" (waited 15068ms). |
| ASRT-005 | Assertions | high | **PASS** | assertHidden holds when it should and fails when it should not | holds → passed; breaks → failed; message: The element was expected to be hidden but was visible. |
| ASRT-006 | Assertions | high | **PASS** | A failed assertion on an element that exists does not trigger healing | 0 healing event(s) on a failed text assertion |
| ASRT-007 | Assertions | high | **PASS** | A failed assertion reports what it expected and what it found | 5/5 failing assertion(s) name expected and actual |
| ASRT-008 | Assertions | critical | **PASS** | Assertions run after a healed step, so a heal that reaches the wrong element is caught | the click healed at 93%; the assertion that followed passed |
| DET-001 | Failure detection | critical | **PASS** | A working application produces a passing run | passed, 4/4 steps; 1 screenshot(s) |
| DET-002 | Failure detection | high | **PASS** | A http 400 failure is detected and reported as a failure | failed, 3/4 steps; failed at step 4 (assertText): Expected the element to contain "OK 42" but it read "failed" (waited 15071ms).; 2 screenshot(s); classified applicationDefect |
| DET-003 | Failure detection | high | **PASS** | A http 401 failure is detected and reported as a failure | failed, 3/4 steps; failed at step 4 (assertText): Expected the element to contain "OK 42" but it read "failed" (waited 15037ms).; 2 screenshot(s); classified authenticationIssue |
| DET-004 | Failure detection | high | **PASS** | A http 403 failure is detected and reported as a failure | failed, 3/4 steps; failed at step 4 (assertText): Expected the element to contain "OK 42" but it read "failed" (waited 15087ms).; 2 screenshot(s); classified authenticationIssue |
| DET-005 | Failure detection | high | **PASS** | A http 404 failure is detected and reported as a failure | failed, 3/4 steps; failed at step 4 (assertText): Expected the element to contain "OK 42" but it read "failed" (waited 15083ms).; 2 screenshot(s); classified applicationDefect |
| DET-006 | Failure detection | critical | **PASS** | A http 500 failure is detected and reported as a failure | failed, 3/4 steps; failed at step 4 (assertText): Expected the element to contain "OK 42" but it read "failed" (waited 15052ms).; 2 screenshot(s); classified applicationDefect |
| DET-007 | Failure detection | high | **PASS** | A timeout failure is detected and reported as a failure | failed, 3/4 steps; failed at step 4 (assertText): Expected the element to contain "OK 42" but it read "calculating…" (waited 15010ms).; 2 screenshot(s); classified applicationDefect |
| DET-008 | Failure detection | high | **PASS** | A connection reset failure is detected and reported as a failure | failed, 3/4 steps; failed at step 4 (assertText): Expected the element to contain "OK 42" but it read "failed" (waited 15007ms).; 2 screenshot(s); classified networkIssue |
| DET-009 | Failure detection | high | **PASS** | A js error failure is detected and reported as a failure | failed, 3/4 steps; failed at step 4 (assertText): Expected the element to contain "OK 42" but it read "calculating…" (waited 15077ms).; 2 screenshot(s); classified applicationDefect |
| DET-010 | Failure detection | critical | **PASS** | A wrong value failure is detected and reported as a failure | failed, 3/4 steps; failed at step 4 (assertText): Expected the element to contain "OK 42" but it read "OK 99" (waited 15004ms).; 2 screenshot(s); classified applicationDefect |
| DET-011 | Failure detection | critical | **PASS** | A missing element failure is detected and reported as a failure | failed, 3/4 steps; failed at step 4 (assertText): testId="outcome" could not be used: No element matched testId="outcome".; 2 screenshot(s); classified locatorChange |
| DET-012 | Failure detection | critical | **PASS** | With every case made healthy, none of the tests fails | http-500: passed, timeout: passed, connection-reset: passed |
| DISC-001 | Discovery | critical | **PASS** | Discovery completes against a real single-page application | status completed, 11 page(s) in 15s |
| DISC-002 | Discovery | critical | **PASS** | Every page the application has is discovered | recall 100.0% (9/9) |
| DISC-003 | Discovery | high | **PASS** | Nothing is discovered that the application does not have | precision 100.0% |
| DISC-004 | Discovery | high | **PASS** | The sign-in page is discovered and recognised as public | found, requiresAuthentication=false |
| DISC-005 | Discovery | medium | **PASS** | Pages behind the sign-in are marked as requiring authentication | 8/8 marked private |
| DISC-006 | Discovery | high | **PASS** | Discovery finds the application's form fields | 5/5 found; classified as textInput/passwordInput; 8 element(s) of that kind |
| DISC-007 | Discovery | high | **PASS** | Discovery finds the application's buttons | 5/5 found; classified as button; 24 element(s) of that kind |
| DISC-008 | Discovery | high | **PASS** | Discovery finds the application's links | 4/4 found; classified as link; 93 element(s) of that kind |
| DISC-009 | Discovery | high | **PASS** | Discovery finds the application's select controls | 3/3 found; classified as select; 4 element(s) of that kind |
| DISC-010 | Discovery | medium | **PASS** | Tabular content is discovered on the pages that have it | /accounts:19 /transactions:35 /dashboard:39 /beneficiaries:17 |
| DISC-011 | Discovery | high | **PASS** | The application's own API calls are observed while the UI is driven | recall 83% of 12 browsable endpoint(s); sign-in POST observed: true; missing DELETE /api/session, GET /api/statements/:id/download |
| DISC-012 | Discovery | medium | **PASS** | Navigation between pages is recorded as transitions | 9 transition(s), 0 dangling |
| DISC-013 | Discovery | high | **PASS** | Discovered elements carry a stable preferred locator, not a structural path | 100.0% stable of 259 element(s): testId=240 role=19 |
| DISC-014 | Discovery | medium | **PASS** | Discovery captures a screenshot of each page it maps | 11/11 page(s) have a screenshot |
| DISC-015 | Discovery | high | **PASS** | Discovery copes with an application whose ids change on every render | 6 page(s) (recall 100%), 111 element(s), 0 locator(s) bound to a generated id |
| EXEC-001 | Browser execution | critical | **PASS** | A twenty-step journey through a real application passes end to end | run passed, 20/20 step(s) passed on chromium 141.0.7390.37 in 1218ms |
| EXEC-002 | Browser execution | high | **PASS** | The browser navigates to the start URL (navigate) | navigate passed in 51ms on about:blank |
| EXEC-003 | Browser execution | high | **PASS** | Text is typed into a field (fill) | fill passed in 62ms on http://localhost:4300/login via testId="username" |
| EXEC-004 | Browser execution | high | **PASS** | A checkbox is ticked (check) | check passed in 49ms on http://localhost:4300/login via testId="remember-me" |
| EXEC-005 | Browser execution | high | **PASS** | A control is pressed (click) | click passed in 45ms on http://localhost:4300/login via testId="login-submit" |
| EXEC-006 | Browser execution | high | **PASS** | An option is chosen from a select (select) | select passed in 40ms on http://localhost:4300/transactions via testId="filter-category" |
| EXEC-007 | Browser execution | high | **PASS** | A visibility assertion is evaluated (assertVisible) | assertVisible passed in 53ms on http://localhost:4300/login via testId="total-balance" |
| EXEC-008 | Browser execution | high | **PASS** | A URL assertion is evaluated (assertUrl) | assertUrl passed in 23ms on http://localhost:4300/dashboard |
| EXEC-009 | Browser execution | high | **PASS** | A value assertion compares what is in the field, not what was typed | assertValue passed |
| EXEC-010 | Browser execution | high | **PASS** | A text assertion reads the rendered text of an element | assertText passed — page-title reads "Statements" |
| EXEC-011 | Browser execution | critical | **PASS** | A password typed during execution is never stored in readable form | literal present: false; password step records "***REDACTED***" |
| EXEC-012 | Browser execution | high | **PASS** | A screenshot is captured for the execution | 1 screenshot(s), 5 artifact(s) in total |
| EXEC-013 | Browser execution | medium | **PASS** | A Playwright trace is captured for the execution | 1 trace(s), 955461 bytes |
| EXEC-014 | Browser execution | high | **PASS** | Console and network activity are recorded for the execution | 8 network event(s) of which 7 are API calls; 1 console event(s) |
| EXEC-015 | Browser execution | high | **NOT_VERIFIED** | The same unchanged test passes on firefox | firefox is not installed in this environment and cannot be downloaded (the Playwright CDN is unreachable); the platform reported: "browserType.launch: Executable doesn't exist at /opt/pw-browsers/fire |
| EXEC-016 | Browser execution | high | **NOT_VERIFIED** | The same unchanged test passes on webkit | webkit is not installed in this environment and cannot be downloaded (the Playwright CDN is unreachable); the platform reported: "browserType.launch: Executable doesn't exist at /opt/pw-browsers/webki |
| EXEC-017 | Browser execution | high | **PASS** | Execution waits for an element that arrives late instead of failing immediately | passed; the assertion waited 6389ms for content the page renders after about 2.5 seconds |
| EXEC-018 | Browser execution | high | **PASS** | A modal dialog can be opened, filled and submitted | passed, 12/12 steps |
| EXEC-019 | Browser execution | medium | **PASS** | Paging through a table changes what the page shows | passed, 8/8 steps |
| EXEC-020 | Browser execution | critical | **PASS** | A multi-step purchase journey completes, with each step depending on the last | passed, 21/21 steps; the shop's order endpoint answers 200 |
| FA-001 | Failure analysis | critical | **PASS** | Every failed run produces a failure record, not just a red verdict | 10/10 failure(s) recorded with a category, message and signature |
| FA-002 | Failure analysis | medium | **PASS** | A http 400 failure is classified as applicationDefect | classified "applicationDefect" at 70% confidence; the lab expects applicationError (accepting applicationDefect) |
| FA-003 | Failure analysis | medium | **PASS** | A http 401 failure is classified as authenticationIssue | classified "authenticationIssue" at 85% confidence; the lab expects authenticationFailure (accepting authenticationIssue) |
| FA-004 | Failure analysis | medium | **PASS** | A http 403 failure is classified as authenticationIssue | classified "authenticationIssue" at 85% confidence; the lab expects authorizationFailure (accepting authenticationIssue) |
| FA-005 | Failure analysis | medium | **PASS** | A http 404 failure is classified as applicationDefect | classified "applicationDefect" at 70% confidence; the lab expects applicationError (accepting applicationDefect) |
| FA-006 | Failure analysis | medium | **PASS** | A http 500 failure is classified as applicationDefect | classified "applicationDefect" at 90% confidence; the lab expects applicationError (accepting applicationDefect) |
| FA-007 | Failure analysis | medium | **PASS** | A timeout failure is classified as timingIssue or applicationDefect | classified "applicationDefect" at 70% confidence; the lab expects timeout (accepting timingIssue or applicationDefect) |
| FA-008 | Failure analysis | medium | **PASS** | A connection reset failure is classified as networkIssue | classified "networkIssue" at 85% confidence; the lab expects networkError (accepting networkIssue) |
| FA-009 | Failure analysis | medium | **PASS** | A js error failure is classified as applicationDefect | classified "applicationDefect" at 70% confidence; the lab expects javascriptError (accepting applicationDefect) |
| FA-010 | Failure analysis | medium | **PASS** | A wrong value failure is classified as applicationDefect or dataIssue | classified "applicationDefect" at 70% confidence; the lab expects assertionFailed (accepting applicationDefect or dataIssue) |
| FA-011 | Failure analysis | medium | **PASS** | A missing element failure is classified as locatorChange or applicationDefect | classified "locatorChange" at 90% confidence; the lab expects elementNotFound (accepting locatorChange or applicationDefect) |
| FA-012 | Failure analysis | high | **PASS** | Classification accuracy across every failure class is measured, not assumed | 10/10 correct (100%), 0 classified as unknown |
| FA-013 | Failure analysis | high | **PASS** | A failure carries an explanation a person can act on, and says what produced it | 10/10 failure(s) analysed; 10 carry a summary, likely cause and suggested action; providers: local (deterministic) |
| FA-014 | Failure analysis | critical | **PASS** | Analysis explains a failure; it never overturns the verdict | 10/10 run(s) remained failed after analysis |
| FA-015 | Failure analysis | medium | **PASS** | The same failure seen twice is recognised rather than counted as new | signatures match; second run isNewFailure=false, occurrences 2 |
| FA-016 | Failure analysis | critical | **PASS** | A confirmation shown for something that never happened is detected | failed; the confirmation banner passed, the payment list assertion failed |
| GEN-001 | AI test generation | high | **PASS** | A requirement in plain English produces runnable test cases: "Customer can login and view account balance." | 5 case(s), 5 with an assertion, 13 step(s) total; provider local/aira-rules-v1; requirement keywords present: balance, dashboard |
| GEN-002 | AI test generation | high | **PASS** | A requirement in plain English produces runnable test cases: "Customer can download account statement." | 5 case(s), 5 with an assertion, 13 step(s) total; provider local/aira-rules-v1; requirement keywords present: statement, download |
| GEN-003 | AI test generation | high | **PASS** | A requirement in plain English produces runnable test cases: "Customer can make a payment." | 5 case(s), 5 with an assertion, 13 step(s) total; provider local/aira-rules-v1; requirement keywords present: payment, pay |
| GEN-004 | AI test generation | high | **PASS** | A requirement in plain English produces runnable test cases: "Customer receives validation when payment amount is invalid." | 5 case(s), 5 with an assertion, 13 step(s) total; provider local/aira-rules-v1; requirement keywords present: payment, amount, invalid, valid |
| GEN-005 | AI test generation | high | **PASS** | A requirement in plain English produces runnable test cases: "Customer cannot login with invalid credentials." | 5 case(s), 5 with an assertion, 13 step(s) total; provider local/aira-rules-v1; requirement keywords present: login, credential |
| GEN-006 | AI test generation | critical | **PASS** | The platform names the provider that generated a suite and does not invent usage it did not have | 5 plan(s); providers local/aira-rules-v1; local fallback flagged: true; tokens reported 0 |
| GEN-007 | AI test generation | high | **PASS** | Generated steps address elements by test id, role or label rather than a structural path | 100.0% stable of 40 targeted step(s): testId=40 |
| GEN-008 | AI test generation | medium | **PASS** | Every generated test carries the context a reviewer needs | 25/25 case(s) carry an objective, preconditions and expected results |
| GEN-009 | AI test generation | medium | **PASS** | Generation respects the scenario budget it was given | asked for at most 2, created 2 |
| GEN-010 | AI test generation | critical | **PASS** | Generated tests execute in a real browser rather than merely reading well | 5/5 generated test(s) passed: TC-0001 passed, TC-0002 passed, TC-0003 passed, TC-0004 passed, TC-0005 passed |
| GEN-011 | AI test generation | critical | **PASS** | A generated test fails when the application it covers is broken | FAULT_EMPTY_TRANSACTIONS on /transactions (the transactions list renders nothing): 1/2 test(s) that visit that page failed (all 5 passed when it was healthy): TC-0001 passed, TC-0002 failed, TC-0003 p |
| GEN-012 | AI test generation | medium | **PASS** | Generation reaches across the application rather than testing one page repeatedly | 6/9 distinct page(s) appear in a generated step (67%), across 9 generated case(s); 8/11 before collapsing repeated routes; 9 case(s) from one unbudgeted generation |
| GEN-013 | AI test generation | critical | **PASS** | Generation against an application that was never discovered does not invent tests | status 400, 0 case(s) created; 0 warning(s): {"code":"validation_failed","title":"This application has no discovered pages yet. Run discovery before generating tests |
| GEN-014 | AI test generation | critical | **PASS** | Text in the application under test cannot give instructions to the generator | 3 case(s) generated from a page carrying an injected instruction; obeyed: false; credentials leaked: false |
| GEN-015 | AI test generation | medium | **PASS** | Every generation is recorded as an auditable request | 5/5 generation(s) recorded an AI request id |
| GEN-016 | AI test generation | high | **NOT_VERIFIED** | Generation quality with a hosted model provider (OpenAI, Anthropic or Gemini) | no model provider is configured in this environment (AI_PROVIDER=local) and no API key is available, so everything above measures the built-in rules engine, which the platform labels honestly as isLoc |
| HEAL-G01 | Self-healing | critical | **PASS** | The test passes against the unmodified application | passed, 5/5 steps, reached /welcome: true |
| HEAL-G02 | Self-healing | critical | **PASS** | Under the default policy a broken locator is proposed, never silently applied | failed; 1 healing event(s), 0 applied; confidence 79; proposals: proposed |
| HEAL-G03 | Self-healing | critical | **PASS** | Under an opt-in Auto policy the same break is healed and the run continues | passed; 1 heal(s) applied at 79%; best candidate 79% against a threshold of 75; reached /welcome: true |
| HEAL-G04 | Self-healing | critical | **PASS** | A healed run is reported as healed, not as a clean pass | run status "passed"; the click records wasHealed=true at 79% confidence |
| HEAL-G05 | Self-healing | critical | **PASS** | Healing at run time does not rewrite the stored test | the stored click still targets {"strategy":"testId","value":"login-submit","exact":false,"fallbacks":[]} |
| HEAL-G06 | Self-healing | high | **PASS** | A control whose test id changed but whose label did not is healed | passed; 1 heal(s) at 93%; best candidate 93% |
| HEAL-G07 | Self-healing | high | **PASS** | Every healing decision is recorded for a human to review | 3 healing event(s) listed, 3 with confidence, outcome and both locators |
| HEAL-G08 | Self-healing | high | **PASS** | Raising the confidence threshold stops a heal that would otherwise be applied | at threshold 100: failed, 0 heal(s) applied, best candidate 79% |
| HEAL-M01 | Self-healing | critical | **PASS** | Healing is measured as four counts, so a rate cannot hide a wrong heal | 12 opportunities: 2 correctly healed, 10 correctly refused, 0 wrongly healed, 0 missed — false-healing rate 0.0% |
| HEAL-M02 | Self-healing | critical | **PASS** | The scorer separates a break that should heal from one that must not | healable: renamed control 79%, test id changed 93%; highest wrong-target candidate 63% (AMBIGUOUS_CONTROLS 51%, CONTROL_IS_LINK_ELSEWHERE 63%); margin +16 points. Findable-but-unusable controls scored |
| HEAL-N01 | Self-healing | critical | **PASS** | Healing is refused: no control performs the function any more | failed; heals applied: 0; reached /welcome: false; classified as locatorChange; no candidate reached the threshold |
| HEAL-N02 | Self-healing | critical | **PASS** | Healing is refused: two equally plausible controls lead to different outcomes | failed; heals applied: 0; reached /welcome: false; classified as locatorChange; 1 candidate(s) considered, best 51% |
| HEAL-N03 | Self-healing | critical | **PASS** | Healing is refused: a control with the same label now cancels the sign-in | failed; heals applied: 0; reached /welcome: false; classified as locatorChange; no candidate reached the threshold |
| HEAL-N04 | Self-healing | critical | **PASS** | Healing is refused: an unrelated marketing button occupies the same position | failed; heals applied: 0; reached /welcome: false; classified as locatorChange; no candidate reached the threshold |
| HEAL-N05 | Self-healing | critical | **PASS** | Healing is refused: the control exists but only behind an extra interaction | failed; heals applied: 0; reached /welcome: false; classified as locatorChange; 1 candidate(s) considered, best 84% |
| HEAL-N06 | Self-healing | critical | **PASS** | Healing is refused: the control is present but disabled | failed; heals applied: 0; reached /welcome: false; classified as locatorChange; 1 candidate(s) considered, best 94% |
| HEAL-N07 | Self-healing | critical | **PASS** | Healing is refused: the control is present but not visible | failed; heals applied: 0; reached /welcome: false; classified as locatorChange; 1 candidate(s) considered, best 93% |
| HEAL-N08 | Self-healing | critical | **PASS** | Healing is refused: a link with the same words leads somewhere else | failed; heals applied: 0; reached /welcome: false; classified as locatorChange; 1 candidate(s) considered, best 63% |
| HEAL-N09 | Self-healing | critical | **PASS** | Healing is refused: the page has been replaced by a maintenance notice | failed; heals applied: 0; reached /welcome: false; classified as locatorChange; no candidate reached the threshold |
| HEAL-N10 | Self-healing | critical | **PASS** | Healing is refused: two controls share the label and do opposite things | failed; heals applied: 0; reached /welcome: false; classified as locatorChange; 1 candidate(s) considered, best 84% |
| REL-001 | Reliability | critical | **PASS** | A deterministic test gives the same verdict ten times running | 10/10 passed; verdicts: passed; duration 425–497ms (median 467ms) |
| REL-002 | Reliability | high | **PASS** | An unstable application produces unstable results, and they are recorded | 7 passed, 13 failed across 20 runs; delays the application served: 100ms, 800ms, 2500ms, 6000ms |
| REL-003 | Reliability | high | **PASS** | The platform records instability against the test rather than leaving it to a reader | the platform records 20 execution(s): 7 passed, 13 failed, flakiness score 56; this suite observed 7/20 passing |
| REL-004 | Reliability | critical | **PASS** | A test that only passes on a retry is not reported as a clean pass | 0/6 run(s) needed a retry; verdicts: passed, failed, failed, failed, passed, passed |
| REL-005 | Reliability | high | **PASS** | Ten runs started at the same moment all reach a verdict | 10/10 reached a verdict, 10 passed; statuses: passed |
| REL-006 | Reliability | critical | **PASS** | When the configured model provider cannot be reached, nothing is fabricated | run failed; analysis present, produced by local (deterministic rules) |
| REL-007 | Reliability | high | **NOT_VERIFIED** | An execution whose worker dies is reconciled rather than left running forever | this deployment reconciles stranded executions after 10 minutes, which is longer than this suite is willing to wait. Set Execution:StrandedAfterMinutes to 1 and AIRA_STRANDED_AFTER_MINUTES=1 to includ |
| SEC-G01 | Security and multi-tenancy | critical | **PASS** | Every data endpoint refuses an unauthenticated request | 6/6 refused with 401; other statuses: none |
| SEC-G02 | Security and multi-tenancy | critical | **PASS** | A forged or tampered token is refused | random: 401, flipped signature: 401, tampered payload with wildcard permissions: 401, empty: 401 |
| SEC-G03 | Security and multi-tenancy | critical | **PASS** | One tenant cannot read another's data by knowing its identifier | 7/7 refused for the other tenant; 7/7 readable by their owner; intruder statuses 404, 200 |
| SEC-G04 | Security and multi-tenancy | critical | **PASS** | One tenant cannot start work inside another's project | the write answered 404; 0 intruder run(s) visible in the owner's project |
| SEC-G05 | Security and multi-tenancy | critical | **PASS** | SQL and script payloads in user input are stored as data, not executed | 4/4 payload(s) stored verbatim; the project list still answers 200 with 5 project(s) |
| SEC-G06 | Security and multi-tenancy | critical | **PASS** | The platform refuses targets that are never legitimate, whatever it is configured to allow | 6/6 refused; accepted: none |
| SEC-G07 | Security and multi-tenancy | critical | **PASS** | A stored credential is never returned by the API | absent from all 6 surfaces; 2 action(s) record a masked value instead |
| SEC-G08 | Security and multi-tenancy | critical | **PASS** | Artifact identifiers cannot be turned into a path traversal | ../../../../etc/passwd → 404, ..%2f..%2f..%2fetc%2fpas → 404, 00000000-0000-0000-0000- → 404 |
| SEC-G09 | Security and multi-tenancy | critical | **PASS** | A test cannot run arbitrary JavaScript in the browser unless the project allows it | refused at import: 200 Step 2 (“Read the session cookie”) was not imported: executeScript is not permitted: enable script execution on the project and grant execut |
| SEC-G10 | Security and multi-tenancy | high | **PASS** | The API sets the browser security headers it claims to | all present: x-content-type-options, x-frame-options, referrer-policy |
| SEC-G11 | Security and multi-tenancy | high | **PASS** | Loopback and private addresses are treated consistently with the deployment's configuration | IPv4 loopback: 201, IPv6 loopback: 201, private range: 201, link-local: 400; loopback and private treated consistently: true; link-local refused regardless: true |

## Evidence

123 artifact(s), 353 KiB, under `verification/evidence/<TEST-ID>/2026-09-21T09-27-06Z/`.
0 missing, 0 changed since they were recorded.

Full index with SHA-256 per artifact: `verification/reports/EVIDENCE-INDEX.md`.
