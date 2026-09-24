# Golden test report

Run `2026-09-24T01-53-26Z` · build `5f49897` · generated 2026-09-24T02:02:03.972Z

**127 passed, 0 failed, 0 not verified** of 127 golden tests.
No critical test failed.

## Quality gates

| Gate | Result | Executed | Failures | Not verified |
| --- | --- | --- | --- | --- |
| Functional | **NOT MEASURED** | 0/0 | — | — |
| Discovery | **NOT MEASURED** | 0/0 | — | — |
| AI | **NOT MEASURED** | 0/0 | — | — |
| Self-healing | **NOT MEASURED** | 0/0 | — | — |
| Security | **NOT MEASURED** | 0/0 | — | — |
| Reliability | **NOT MEASURED** | 0/0 | — | — |
| Failure detection | **NOT MEASURED** | 0/0 | — | — |
| Evidence | **PASS** | 127/127 | — | — |

**Overall: INCOMPLETE** — a gate is green only when every executed test in it passed, and a
gate with no tests in this run is NOT MEASURED rather than green or failed.
Nothing failed. 7 gate(s) had no tests in this run: Functional, Discovery, AI, Self-healing, Security, Reliability, Failure detection. This is the expected verdict for a run that covers a subset of the suites; it is not a pass, and it is not a defect.

## Metrics

### Discovery
| | |
| --- | --- |
| Page recall against ground truth | not measured |
| Page precision | not measured |
| API endpoint recall | not measured |
| Elements preferring a stable locator | not measured |
| Pages / elements discovered | — / — |
| Crawl duration | — |

### Generation
| | |
| --- | --- |
| Discovered pages reached by generated tests | not measured |
| Generated steps using a stable locator | not measured |
| Generated tests executed / passed on a healthy application | — / — |
| Generated tests that failed once the application was broken | — |

### Self-healing
| | |
| --- | --- |
| Healing opportunities | — |
| Correct heals | — |
| Correct rejections | — |
| **Incorrect heals** | **—** |
| Missed heals | — |
| Healing success rate | not measured |
| **False-healing rate** | **not measured** |
| Confidence margin (lowest healable − highest wrong target) | — points (—% vs —%) |

### Failure analysis
| | |
| --- | --- |
| Classification accuracy | not measured (—/—) |
| Classified "unknown" | — |

### Reliability
| | |
| --- | --- |
| Repeatability | — runs, — distinct verdict(s) |
| Flaky application | — passed / — failed of — |
| Concurrency | —/— concurrent runs reached a verdict |

### Performance baseline

Measured on the hardware recorded in `verification/environment.md`. These are observations,
not targets: no gate depends on them, and a run on other hardware will differ.

| | |
| --- | --- |
| Discovery of the nine-page bank | not measured median, not measured p95 |
| …per discovered page | not measured |
| A twelve-step run, queued to verdict | not measured median, not measured p95 |
| …of which in the browser | not measured |
| …platform overhead (queue, claim, callbacks) | not measured |
| …per step | not measured |
| Generating a suite from one requirement | not measured |

### Result integrity
| | |
| --- | --- |
| Checks that would catch a false pass | 0 |
| **False passes observed** | **0** |
| Checks that would catch a false failure | 0 |
| **False failures observed** | **0** |

## Results

| ID | Suite | Severity | Result | Objective | Detail |
| --- | --- | --- | --- | --- | --- |
| ACC-001 | Accessibility | critical | **PASS** | A page with no violations passes, and the result says what was actually run | run passed; 0 violation(s), 21 rule(s) passed, 1 incomplete; axe-core 4.13.0 |
| ACC-002 | Accessibility | critical | **PASS** | Every accessibility fault in the lab is found, and found as the rule it is | 5 fault(s), each producing exactly what its ground truth names |
| ACC-003 | Accessibility | critical | **PASS** | failOn decides whether a violation fails the step, and the result is stored either way | failOn serious: run failed, 1 violation(s) stored; failOn null: run passed, 1 violation(s) stored |
| ACC-004 | Accessibility | high | **PASS** | A failing check names the rule, the element and where to read about it | 2 violation(s); message 361B, names rules: true, carries help URL: true |
| ACC-005 | Accessibility | critical | **PASS** | A run with no accessibility step reports the metric as unmeasured, never as zero | rule measured=false passed=false; outcome review; "The number of critical or serious accessibility violations was not measured for this run, so this rule could not be eval" |
| ACC-006 | Accessibility | critical | **PASS** | A run that does check reports the number it found, and the gate acts on it | run passed; metric measured 2; rule passed=false; gate fail |
| AIF-001 | AI provider failure | critical | **PASS** | A provider that never answers fails the request visibly instead of returning nothing | status 503; 0 test case(s) created; model request recorded: true (status failed); message "The request to the model provider timed out. (simulated)" |
| AIF-002 | AI provider failure | critical | **PASS** | A provider error fails the request visibly instead of being swallowed | status 503; 0 test case(s) created; model request recorded: true (status failed); message "The model provider returned 503 Service Unavailable. (simulated)" |
| AIF-003 | AI provider failure | critical | **PASS** | A reply that is not JSON is refused rather than partially parsed | status 503; 0 test case(s) created; model request recorded: true (status schemaRejected); message "The model's response did not satisfy the test_plan schema: The response was not valid JSON: 'C' is a" |
| AIF-004 | AI provider failure | critical | **PASS** | Valid JSON of the wrong shape is refused, not leniently deserialized | status 503; 0 test case(s) created; model request recorded: true (status schemaRejected); message "The model's response did not satisfy the test_plan schema: : Required properties ["summary"] are not" |
| AIF-005 | AI provider failure | critical | **PASS** | An empty response is refused rather than treated as "no scenarios" | status 503; 0 test case(s) created; model request recorded: true (status schemaRejected); message "The model's response did not satisfy the test_plan schema: The response was empty." |
| AIF-006 | AI provider failure | critical | **PASS** | Model output carrying instructions is treated as data, and never reaches a test as an action | status 503; model request recorded: true; 0 test case(s) created; attacker host in stored tests: false; shell command in stored tests: false; existing tests deleted: false |
| AIF-007 | AI provider failure | critical | **PASS** | A provider outage does not stop a test run: the model plans, and something else executes | run passed with 1 passed / 0 failed, while every model request would have failed |
| AIF-008 | AI provider failure | high | **PASS** | Every failed model request is recorded with the reason it failed, rather than vanishing | 9 recorded request(s) after 3 injected fault(s); statuses: failed, schemaRejected |
| AIF-009 | AI provider failure | critical | **PASS** | Fault injection cannot be armed by a caller who is not an organization administrator | a QA engineer arming a fault: 403; the same account reading projects: 200 |
| API-001 | API testing | critical | **PASS** | An API test is authored through the platform and stored as a test case | stored as TC-0001 kind=api with 2 request(s) and 6 assertion(s) |
| API-002 | API testing | critical | **PASS** | An API test executes in the ordinary run pipeline and passes when the API works | run passed, execution passed, 2 action(s), 42ms |
| API-003 | API testing | critical | **PASS** | The request and the response are recorded as evidence, tagged with the step that made them | 2 exchange(s) recorded: step 1 POST /api/session → 200 in 2ms; step 2 GET /api/accounts → 200 in 4ms |
| API-004 | API testing | critical | **PASS** | A test that expects an unauthenticated call to be refused passes on the refusal | run passed; the call returned 401 |
| API-005 | API testing | critical | **PASS** | A switched-on server fault fails the API test, with the response as evidence | run failed; message "POST http://localhost:4300/api/session returned 500 Internal Server Error."; evidence body "{"error":"internal_error","message":"The authentication service is unavailable."}" |
| API-006 | API testing | high | **PASS** | The platform refuses an API test that asserts nothing | status 400; 2 problem(s): Request 1 has no assertions and tolerates error statuses, so no result could make it fail. Add an assertion, or let an error status fail the step. \| This test asserts nothin |
| API-007 | API testing | high | **PASS** | The platform refuses a page assertion attached to an API request | status 400; Request 1: 'visible' is a page assertion and cannot be evaluated against an HTTP response. Use a response assertion instead. |
| API-008 | API testing | critical | **PASS** | The platform refuses an API test pointed at a host outside the application boundary | status 400; Request 1: The request to 'https://api.stripe.com/v1/charges' is not allowed: host 'api.stripe.com' is not in the application's allowed domains |
| API-009 | API testing | critical | **PASS** | The platform refuses an API test that inlines a credential instead of referencing one | literal header 400, literal token 400, reference 200 |
| API-010 | API testing | critical | **PASS** | The quality gate measures API failures as their own metric, and a rule over it fires | ApiFailedCount=1, outcome fail, rule "No failing API tests" passed=false |
| API-011 | API testing | critical | **PASS** | A gate rule over a metric the run could not measure is sent for review, never reported as satisfied | run passed; rule measured=false passed=false; outcome review |
| API-012 | API testing | critical | **PASS** | A referenced secret is sent but never appears in the run's stored evidence | run passed; the password appears in none of execution, executions, network |
| API-013 | API testing | critical | **PASS** | A pipeline can author and run API tests through the CLI, and branch on its exit status | add exit 0, list exit 0, healthy run exit 0 (expected 0), broken run exit 1 (expected 1) |
| API-014 | API testing | critical | **PASS** | A mutating API request is refused in an environment that does not permit destructive tests | run failed; message "A POST request is not permitted against this environment. Destructive API requests are disabled for it."; 0 request(s) recorded |
| AUD-001 | Isolation, audit and observability | critical | **PASS** | Authorizing production testing is recorded, with the written reason that was given | authorization 200; 2 audit record(s) for the environment; the reason is on the trail: true |
| AUD-002 | Isolation, audit and observability | high | **PASS** | Creating, changing and deleting a schedule are each recorded separately | actions recorded: scheduleCreated, scheduleDeleted, scheduleUpdated |
| AUD-003 | Isolation, audit and observability | high | **PASS** | Changing a quality gate is recorded, because it changes what the platform will let through | 2 qualityGateChanged record(s); the new rule is named: true |
| AUD-004 | Isolation, audit and observability | critical | **PASS** | A failed action is recorded as failed, not omitted | sign-in refused with 401; 1 loginFailed record(s) with succeeded=false; the attempted password appears in the trail: false |
| AUD-005 | Isolation, audit and observability | critical | **PASS** | The audit trail has no write path: it cannot be added to, edited or deleted through the API | postCollection 405, deleteCollection 405, patchRecord 404, putRecord 404, deleteRecord 404; total 18 → 18 |
| AUD-006 | Isolation, audit and observability | critical | **PASS** | Reading the audit trail needs its own permission, which ordinary read access does not carry | viewer reading projects: 200; reading the audit trail: 403 |
| AUD-007 | Isolation, audit and observability | critical | **PASS** | Configuring a secret is audited without the secret being recorded | integration 201; the configuration is on the trail: true; the secret value appears in the trail: false |
| AUD-008 | Isolation, audit and observability | high | **PASS** | A burst of credential attempts is refused, and the refusals are recorded as a security event rather than as ordinary traffic | 15 of 20 attempt(s) refused with 429; 15 limiter line(s) written — 15 at warning level, 15 named as a credential endpoint, 15 attributed to the limiter |
| CI-001 | CI integration | critical | **PASS** | A run writes exactly the four documented artifacts, under fixed names | exit 0; files junit.xml, report.html, report.json, summary.md; junit 485B, json 1721B, html 4318B, summary 404B |
| CI-002 | CI integration | critical | **PASS** | The pull request summary names the failure, its message and its diagnosis | exit 1; summary 492B; headline "### ❌ 1 test(s) failed" |
| CI-003 | CI integration | high | **PASS** | A passing run produces a summary with no failure section at all | exit 0; headline "### ✅ All tests passed" |
| CI-004 | CI integration | critical | **PASS** | A run the gate sends for review exits 7 and says so in the summary | exit 7 (expected 7); headline "### ⚠️ This run needs a person to look at it" |
| CI-005 | CI integration | high | **PASS** | Every example pipeline passes only flags the CLI accepts and handles every exit code the CLI documents | 5 pipeline file(s): no unknown flags, every exit code handled, each marked as not executed in its CI system |
| CI-006 | CI integration | critical | **PASS** | The JUnit XML reports the same counts as the run it came from | junit tests=2 failures=1; run 2 test(s), 1 failed |
| CI-007 | CI integration | high | **PASS** | The build, commit and branch a pipeline passes are recorded on the run | provider github, build 99123, commit a1b2c3d4, branch feature/accounts-filter |
| CI-008 | CI integration | high | **PASS** | A quality gate rule that no run could ever satisfy is refused, rather than blocking every build | explicit lessThan 0: 400; operator omitted: 400; lessThanOrEqual 0: 200 stored as lessThanOrEqual; the refusal names the likely intention: true |
| CON-001 | API contracts | high | **PASS** | The API inventory reports which observed endpoints nothing tests | 14 endpoint(s) observed, 2 covered by an API test, 0 with a baseline; GET /api/accounts testCount=1 |
| CON-002 | API contracts | critical | **PASS** | Contract baselines are inferred from responses the application actually gave | 14 baseline(s) captured, 0 skipped; GET /api/accounts v1 with 12 field(s) |
| CON-003 | API contracts | critical | **PASS** | An unchanged API produces no contract differences at all | run passed; 0 breaking, 0 potentially breaking, 0 non-breaking |
| CON-004 | API contracts | critical | **PASS** | A field the API stops returning is classified as a breaking change | the test passed while 1 breaking change(s) were found; $.accounts[].sortCode: "accounts[].sortCode" was present as string and is now absent. Any caller reading it will find nothing. |
| CON-005 | API contracts | critical | **PASS** | A field whose type changes is classified as a breaking change | the test passed; $.accounts[].balance: number → string (breaking) |
| CON-006 | API contracts | critical | **PASS** | A field that can now be null is classified as potentially breaking, not breaking | the test passed; $.accounts[].sortCode classified "potentiallyBreaking" (string → null\|string); 0 breaking |
| CON-007 | API contracts | critical | **PASS** | A new field is reported as non-breaking and does not fail anything | the test passed; $.accounts[].nickname classified "nonBreaking"; 0 breaking, 0 potentially breaking |
| CON-008 | API contracts | critical | **PASS** | A quality gate rule over breaking contract changes fires when one is found | run passed; ContractBreakingChangeCount=1; rule measured=true passed=false; outcome fail |
| CON-009 | API contracts | high | **PASS** | A breaking change can be acknowledged, and the acknowledgement carries forward | without a reason: 400; with one: 204; the same change on the next run: acknowledged=true |
| CON-010 | API contracts | critical | **PASS** | API tests are generated from the observed inventory, including negative ones | 29 test(s) from 14 endpoint(s): 13 positive, 12 unauthenticated, 4 not-found; 1 endpoint(s) skipped as mutating; the first test carries 5 assertion(s) |
| CON-011 | API contracts | critical | **PASS** | A generated API test executes and passes against the application it was generated from | "GET http://localhost:4300/api/accounts refuses an unauthenticated caller" ran and passed in 27ms |
| CON-012 | API contracts | critical | **PASS** | A generated unauthenticated-refusal test fails if the endpoint stops requiring credentials | run failed; "The endpoint refuses a caller with no credentials: Expected a status in "401,403" but the response was 200 OK." |
| CON-013 | API contracts | high | **PASS** | Accepting a new contract baseline requires a reason and is versioned | without a note: 400; with one: 14 captured, 14 replaced; GET /api/accounts is now v2 |
| CON-014 | API contracts | medium | **PASS** | A contract check can read what a crawl observed, not only what an API test called | 14 endpoint(s) compared from the crawl, 0 breaking |
| COR-001 | UI/API correlation | critical | **PASS** | Every recorded request is attributed to the step that made it | 7 API call(s) recorded, 7 attributed to a step, across step(s) 1, 2, 3 |
| COR-002 | UI/API correlation | critical | **PASS** | A UI step that fails because its own API call returned 500 is diagnosed as that | applicationDefect at 90%: "The step before this one made an API call that returned 500." — 1 failed call(s) recorded |
| COR-003 | UI/API correlation | critical | **PASS** | An API test's failure is diagnosed from the call the failing step made | applicationDefect at 95%: "The step failed because the API call it made returned 500." / "POST /api/session → 500 in 3ms — the fault is in the application or a service it depends on, not in the test." |
| COR-004 | UI/API correlation | critical | **PASS** | A request that never completed is diagnosed as a network issue and named | networkIssue at 90%: "The step failed because the API call it made never completed." |
| COR-005 | UI/API correlation | critical | **PASS** | A failure where the API answered correctly is attributed to the front end | 2 API call(s), 0 failed; applicationDefect at 80%: "The API answered correctly and the page showed something else." |
| COR-006 | UI/API correlation | critical | **PASS** | A signed-out page's own 401 never becomes the explanation for a removed control | locatorChange at 35%: "The element Press login-submit targets has changed." |
| COR-007 | UI/API correlation | high | **PASS** | Re-analysing a stored failure rebuilds the correlation from the evidence | first: authenticationIssue at 90%; re-analysed: authenticationIssue at 90% |
| DAT-001 | Test data | critical | **PASS** | A data set can be created with each kind of field and read back | 4 field(s): bookingDate=seededRandom, customerEmail=generated, orderReference=static, password=secretReference |
| DAT-002 | Test data | critical | **PASS** | A seeded field resolves to the same value every time, through the platform | 16 generator type(s), every one reproducible |
| DAT-003 | Test data | critical | **PASS** | A field whose name is a credential is refused unless it references a secret | 4/4 credentials refused; 3/3 ordinary fields accepted |
| DAT-004 | Test data | critical | **PASS** | A field declared as a secret reference must name a secret, not hold one | 400: "password" is a secret reference, so its value must name a secret, as "${secret:the_name}". It must not contain the secret itself. |
| DAT-005 | Test data | critical | **PASS** | Neither a read nor a preview ever returns a sensitive value | neither the read nor the preview returned the sensitive value |
| DAT-006 | Test data | high | **PASS** | Deleting a data set a test case uses is refused rather than cascaded | attach 204; in use: 409 "1 test case(s) use this data set. Point them elsewhere first — deleting it would leave them running with no data, which reads as an application defect."; detach 204; once free |
| DAT-007 | Test data | high | **PASS** | A data set exports to a file, imports back, and the export carries no secret | import 0, preview 0, re-import 0; exported 3 field(s), secret carried as "${secret:app_password}" |
| DAT-008 | Test data | medium | **PASS** | A data set with several problems reports all of them at once | 4 problem(s) reported at once |
| ISO-001 | Isolation, audit and observability | critical | **PASS** | An API test belonging to another tenant cannot be read by identifier | intruder 404, owner 200 |
| ISO-002 | Isolation, audit and observability | critical | **PASS** | Contract baselines and the API inventory are scoped to the owning tenant | intruder 404 with 0 endpoint(s), owner 200 |
| ISO-003 | Isolation, audit and observability | critical | **PASS** | A schedule cannot be read, changed or deleted across a tenant boundary | read 404, patch 404, delete 404; afterwards name "Tenant A nightly" enabled=true |
| ISO-004 | Isolation, audit and observability | critical | **PASS** | Another tenant's notification integration is neither listed nor readable, and its secret never leaves the platform | tenant B list 200 (saw tenant A: false), by id 405; owner list 200; signing secret present in any response: false |
| ISO-005 | Isolation, audit and observability | critical | **PASS** | A test data set cannot be read or previewed by another tenant | read: intruder 404, owner 200; preview: intruder 404, owner 200 |
| ISO-006 | Isolation, audit and observability | critical | **PASS** | Quality gate rules are scoped to their project and tenant | tenant B list 404 (saw the rule: false), delete 404; rule still present for its owner: true |
| ISO-007 | Isolation, audit and observability | critical | **PASS** | The audit trail is scoped to one organization, and there is no parameter that would widen it | tenant A sees 9 record(s) from 1 org(s); tenant B 1 from 1; forcing organizationId returned 1 org(s), tenant A's included: false |
| NOT-001 | Notifications | critical | **PASS** | A webhook integration delivers, and the receiver gets a signed, well-formed body | delivered=true status=200; sink got 1 delivery, signature valid: true |
| NOT-002 | Notifications | critical | **PASS** | A run with failing tests produces a notification naming the failure | 1 delivery(ies): RunFailed; title "1 test(s) failed in Golden notifications"; facts {"passed":1,"failed":1,"blocked":0,"healed":0,"flaky":0,"qualityGate":"Pass","branch":null,"commit":null} |
| NOT-003 | Notifications | high | **PASS** | A green run sends nothing unless somebody asked for it | nothing was sent, as intended |
| NOT-004 | Notifications | medium | **PASS** | A team that wants a heartbeat from a green run can have one | 1 delivery(ies): RunPassed |
| NOT-005 | Notifications | critical | **PASS** | No notification body contains a credential, checked against the bytes sent | 1 delivery(ies) scanned for 3 secret(s): none present; 1 signed |
| NOT-006 | Notifications | critical | **PASS** | A failed delivery is recorded with the reason, and never fails the run | run ended "failed"; 1 delivery record(s); failed record: status 500, "The receiver answered 500 Internal Server Error." |
| NOT-007 | Notifications | critical | **PASS** | A credential submitted as a readable setting is refused, not quietly stored | 3/3 refused; the harmless one returned 201 |
| NOT-008 | Notifications | critical | **PASS** | A webhook cannot be pointed at cloud metadata | delivered=false; "The webhook URL was refused: 169.254.0.0/16 is link-local (cloud metadata) and is never a permitted target." |
| OBS-001 | Isolation, audit and observability | high | **PASS** | Every response carries a correlation id, and one supplied by the caller is honoured rather than replaced | minted "d2812a6e607240d6b6d1c76e8a28cb9d"; supplied "golden-gif6cnl36n" came back as "golden-gif6cnl36n" |
| OBS-002 | Isolation, audit and observability | critical | **PASS** | The correlation id on a response is the one on the audit record that request produced | 1 record(s) carry correlation golden-trace-bzkdzoqw9z; the created project is among them: true (projectCreated) |
| OBS-003 | Isolation, audit and observability | critical | **PASS** | A correlation id survives from the caller through the queue to the execution the worker ran | run passed; the execution carries correlation "golden-run-wj3mi873jn" (supplied "golden-run-wj3mi873jn") |
| OBS-004 | Isolation, audit and observability | high | **PASS** | Liveness and readiness answer different questions, and liveness depends on nothing | /live 200 "Healthy"; /ready 200 "Healthy"; /health 200 "Healthy" |
| OBS-005 | Isolation, audit and observability | high | **PASS** | A correlation id a caller invents is bounded, so it cannot be used to write arbitrary text into every log line | sent 500 characters; the platform used a 32-character id of its own: true |
| REG-001 | Regression selection | critical | **PASS** | A changed file is mapped to what a rule says it affects, and the mapping is marked as declared | 1/1 path(s) mapped; routes ["/accounts"]; declared=true |
| REG-002 | Regression selection | critical | **PASS** | A change a rule marks as shared selects the whole suite rather than a narrowed set | mode full, 5/5 selected |
| REG-003 | Regression selection | critical | **PASS** | A change to one area selects the tests that reach it and leaves the others out | 3/5 selected: TC-0001(70) TC-0004(70) TC-0005(40) \| excluded: TC-0002(30) TC-0003(30) |
| REG-004 | Regression selection | critical | **PASS** | A change AIRA cannot map to anything runs the whole suite, and says so | fellBack=true, mode full, 5/5 selected; unmatched: ["infrastructure/terraform/main.tf"] |
| REG-005 | Regression selection | critical | **PASS** | A selection with no changed paths at all runs everything rather than nothing | fellBack=true, 5/5 selected |
| REG-006 | Regression selection | critical | **PASS** | Every selected test carries its score, the score's components and the reason for each | score 70 from 5 component(s); reasons: This test exercises /accounts, which the change affects. \| Priority medium, risk medium. \| This test has never run, so nothing is known about it. \| It has nev |
| REG-007 | Regression selection | high | **PASS** | A test tagged smoke is selected even when the change does not reach it | selected at 40, impacted=false; Priority medium, risk medium. \| This test has never run, so nothing is known about it. \| It has never been run. \| Tagged smoke, which this project always runs. |
| REG-008 | Regression selection | high | **PASS** | A mapping AIRA inferred from a file name is reported as inferred, not declared | 1 inferred mapping(s): route /payments |
| REG-009 | Regression selection | critical | **PASS** | A pipeline can select, inspect and run a regression set through the CLI | select exit 0, run exit 0; artifact: 3/5 test(s) |
| REG-010 | Regression selection | critical | **PASS** | The same change produces the same selection and the same scores | identical across both runs: 2 test(s) |
| REG-011 | Regression selection | high | **PASS** | A rule that would silently match nothing, or affect nothing, is refused | blank pattern: 400; missing value: 400 |
| REG-012 | Regression selection | critical | **PASS** | A selection that would contain no tests is refused rather than returned empty | status 400: No enabled tests matched this selection. A regression run with nothing in it would report success without testing anything. |
| RLS-001 | Release quality | critical | **PASS** | A test that passed before and fails now is reported as newly failing | TC-0002: newlyFailing; TC-0001: stillPassing; "1 test(s) that used to pass now fail." |
| RLS-002 | Release quality | high | **PASS** | A test that failed before and passes now is reported as fixed | TC-0002: fixed; "1 that used to fail now pass." |
| RLS-003 | Release quality | critical | **PASS** | A failure present in both runs is still failing, never newly failing | TC-0002: stillFailing; unchanged=true; "Nothing changed. 1 test(s) are still failing, as they were before." |
| RLS-004 | Release quality | high | **PASS** | A test that ran before and not this time is reported, not silently dropped | TC-0002: removed; "1 that ran before did not run this time." |
| RLS-005 | Release quality | critical | **PASS** | A release report covers every run that tested one build and says what changed | build v2.4.1: 1 run(s), 1 failing, compared with v2.4.0; "Build v2.4.1 was tested by 1 run(s). 1 test(s) are failing in the most recent one. Against Release green: 1 test(s) that used to pass now fail |
| RLS-006 | Release quality | critical | **PASS** | A run with nothing to compare against says so rather than reporting zeros | 400: There is no earlier finished run in this project to compare against. A first run has nothing to have changed from. |
| RLS-007 | Release quality | critical | **PASS** | aira release compare --fail-on-new-failures exits 1 on a regression and 0 on a known failure | regression exit 1 (expected 1); already-failing exit 0 (expected 0); markdown headline "#### ❌ 1 test(s) that used to pass now fail" |
| SCH-001 | Scheduling | critical | **PASS** | A schedule created through the API fires on its own and starts a real run | fired at 2026-09-24T01:57:23.584981+00:00, run ab7c8f70-07ed-4cdd-bc9b-ce1c8a5af7c0 (passed, trigger scheduled, 1/1 passed); next run 2026-09-24T01:58:00+00:00 |
| SCH-002 | Scheduling | high | **PASS** | A schedule restricted by tag runs only the tests carrying that tag | ran 1 test(s): TC-0002 (expected only TC-0002) |
| SCH-003 | Scheduling | critical | **PASS** | Firing moves the schedule forward, so one occurrence starts exactly one run | fired at 2026-09-24T01:59:23.636284+00:00, next 2026-09-24T02:00:00+00:00 (advanced: true); 1 run(s) started for this schedule |
| SCH-004 | Scheduling | high | **PASS** | A cron expression that cannot work is refused when it is written, not at 3am | 5/5 refused with 400; the valid expression returned 201 |
| SCH-005 | Scheduling | critical | **PASS** | A schedule pointed at unauthorized production is refused when it is created | 403 security_policy: Environment 'prod' is production and testing it has not been authorized. Authorize it explicitly with POST /api/v1/environments/{id}/authorize-production, with a note saying why. |
| SCH-006 | Scheduling | medium | **PASS** | Preview reports the real occurrences, in the schedule's own time zone | 5 occurrence(s), local times 02:30:00, ascending: true |
| SCH-007 | Scheduling | high | **PASS** | A schedule can be created, listed, previewed, disabled and removed from the CLI | add 0, list 0, preview 0, disable 0, remove 0; gone from the list afterwards: true |
| VIS-001 | Visual regression | critical | **PASS** | A first run stores a baseline and reports that nothing was compared | first newBaseline (1280x1694); second match at 0.0042% — the live timestamp's own noise, tolerated by the default threshold |
| VIS-002 | Visual regression | critical | **PASS** | Every visual change in the lab produces the verdict its ground truth names | TINY: match 0.0228%; OBVIOUS: differs 0.2952%; TALLER: sizeChanged 0.0000% |
| VIS-003 | Visual regression | critical | **PASS** | A difference does not fail the step by default; it asks for a person | default: run passed, verdict differs; onDifference=fail: run failed, verdict differs |
| VIS-004 | Visual regression | high | **PASS** | A difference stores the baseline, the capture and a diff; a match stores none | match: no images stored; differs: baseline=true actual=true diff=true |
| VIS-005 | Visual regression | critical | **PASS** | A run with no visual step reports the metric as unmeasured, never as zero | rule measured=false passed=false; outcome review |
| VIS-006 | Visual regression | critical | **PASS** | Masking a region that changes every run removes the difference entirely | two masked comparisons: 0 and 0 differing pixels; recorded as masked: ["[data-testid=\"generated-at\"]"] |
| VIS-007 | Visual regression | high | **PASS** | A baseline taken at one viewport is not compared against another | 1280: newBaseline then match; 800 with the same baseline name: newBaseline |

## Evidence

155 artifact(s), 217 KiB, under `verification/evidence/<TEST-ID>/2026-09-24T01-53-26Z/`.
0 missing, 0 changed since they were recorded.

Full index with SHA-256 per artifact: `verification/reports/EVIDENCE-INDEX.md`.
