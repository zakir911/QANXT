# QA NXT — autonomous QA: what was built, and what that establishes

This report exists to be disagreed with. Every claim in it names the thing that would show it
false, and where nothing would, it says so rather than claiming anything.

Seven states are kept apart throughout, because collapsing them is how software reporting
misleads:

| State | Means |
| --- | --- |
| **IMPLEMENTED** | The code exists. Nothing more. |
| **EXECUTED** | It ran. |
| **VERIFIED** | It ran, the expected behaviour was observed, and evidence was recorded. |
| **FAILED** | It ran and did not behave as expected. |
| **NOT VERIFIED** | Declared, deliberately not executed, with the reason recorded. |
| **NOT TESTED** | Nothing covers it. |
| **KNOWN LIMITATION** | A boundary of what any of this can establish. |

**Nothing here is called verified because the code exists.** That is the distinction the
whole report is for.

## The headline

| | |
| --- | --- |
| Autonomous golden tests | **271**, all passing, 0 not verified |
| Requirements traced to tests that ran | **30 of 30** |
| Evidence files recorded, hashes still matching | 750 / 750 |
| Unit tests | 885 |
| Integration tests | 57 |
| Independent applications the agent has run against | **1** |
| Defects found by the golden tests | 8 in the product |
| Defects found by one afternoon of the pilot | **2 more, that the 251 before them had missed** |

The last line is the most useful number in this document.

## VERIFIED

Each of these ran against the real stack, produced evidence, and is pinned by named tests.
The full matrix is in `verification/reports/AUTONOMOUS-QA-REPORT.md`.

- **An autonomous pass, end to end.** Explore, model, prioritise, assess coverage, plan, wait
  for a person, generate, scan, execute, investigate, propose. Every phase recorded,
  including those that decided to do nothing.
- **The plan is a proposal.** Nothing is generated or run until somebody answers, and the
  estimate says whether it came from history or from defaults.
- **The policy ladder.** Nine rungs, deterministic, a pure function over a frozen policy.
  A refusal names the rung that stopped it and the rungs it had already passed.
- **A decision with no evidence is refused at the point of recording.** Enforced in code.
- **Questions stop the pass.** Asking is not granting; an answer needs a reason; the same
  question cannot be answered twice; answering releases the pass, which resumes on its own.
- **Exclusions are absolute.** Honoured before scoring, never weighed against a risk number.
- **Coverage separates Unknown from Not covered.** Tests that exist and have never run are
  reported as unknown, not as coverage.
- **Application content is data.** 25 injection payloads; none widened a bound, gained a
  permission, granted an approval or reached a host outside the scope.
- **Production and destructive actions are refused.** Their refusals are verified; see below
  for what that does not establish.
- **A pass against a broken, unreachable, unauthenticated or cancelled application** still
  finishes, still records, and never reports a clean result it did not earn.
- **Tenant isolation.** One tenant cannot read another's pass or its business context.
- **The release assessment includes what a pass executed**, always carries a security section,
  and never reports an unscanned build as clean.

## IMPLEMENTED — and NOT VERIFIED end to end

**Nothing.** Every model with unit tests is now reachable from a pass and pinned by a named
golden test. All eight that were once on this list are wired in:

| Component | Brief section | Where it runs now |
| --- | --- | --- |
| `TestGapModel` | §10 gap analysis | The `AnalysingGaps` phase |
| `TestDuplicationModel` | §12 duplication | After generation, reporting duplicates it cannot delete |
| `DynamicSelectionModel` | §14 dynamic selection | Investigating, from the error responses the run produced |
| `ExploratoryModel` | §15 exploratory mode | Exploring, reporting the crawl as a fraction of what is known |
| `TestHistoryModel` | §19 historical intelligence | Prioritising, replacing a hand-rolled sort by fail count |
| `FailureCorrelationModel` | §21 root-cause correlation | The `Correlating` phase, which existed in the enum with nothing behind it |
| `RegressionPromotionModel` | §25, §26 promotion | Proposing, and it proposes rather than promotes |
| `AutonomousAssessmentModel` | §36, §37 release judgement | Proposing, with no overall score |

The section is kept rather than deleted. It is where the next component that exists and cannot
be reached belongs, and a report with no such heading reads as though the question was never
asked.

### What wiring them exposed

Three things, none of which unit tests could have found:

1. **Five phases returned early without recording anything** when there was nothing to do. A
   phase that ran and left nothing behind is indistinguishable from a phase that never ran, and
   "the pass looked and found nothing to group" is a different statement from "the pass did not
   look". The golden run found six failures, all of that shape. I fixed three, missed regression
   selection, and the tests caught it.
2. **A platform gap that had been invisible.** A journey needs three observations to qualify for
   the permanent suite, and the platform records only *that* a journey was observed, not how
   many times — so no journey can reach the bar. That is now stated in the decision's evidence;
   without it a reader concludes none was worth keeping.
3. **Three field names I invented** (`OccurrenceCount` on a security finding, `TimesObserved` on
   a journey) which the compiler rejected. The real sighting count comes through
   `SecurityScanFindings`; the journey count does not exist, which is finding 2.

## NOT TESTED

- ~~**The autonomous QA dashboard and run timeline in the console (§34, §35).**~~ **Built.** The
  console now carries the plan a person approves (and can narrow category by category), the
  approval queue, the decision log, the timeline and the business context. 16 tests cover what a
  person does there and the two ways the screen could lie: showing a blank where the API sent
  something, and letting an answer through without its reason.
- **Firefox and WebKit.** Supported in code; neither binary has ever launched here.
  `EXEC-015` and `EXEC-016` attempt a real run and report NOT VERIFIED with the reason.
- **Any model provider.** `AI_PROVIDER=local` throughout. Every generated test came from the
  deterministic planner. `GEN-016` records this.
- **A production pass in its permitted form.** Only the refusal is verified.
- **A pass with destructive actions permitted.** Only the refusal is verified.
- **Anything in `docs/compatibility.md` marked NOT TESTED** — server-rendered applications,
  GraphQL, WebSockets, SSO, MFA, applications larger than a 25-page crawl, and more.

## KNOWN LIMITATIONS

- **Every figure but the pilot's describes the golden lab.** Those applications were written
  alongside the platform that tests them. Nothing generalises to an application nobody has
  seen. The pilot exists because of this, and one pilot is not many.
- **A pass is only as wide as discovery.** Coverage, risk and gaps are measured against what
  the crawl reached. On Verdaccio that was 4 pages and 7 endpoints, and **none** of the npm
  registry protocol — a browser never calls it, so a crawler never finds it. On any
  application whose real surface is an API no browser drives, a pass tests what the browser
  sees and is silent about the rest.
- **Business context is matched to routes by substring.** A person writing a journey in
  English names something no route can contain. The coverage decision now says which named
  areas matched nothing; the matching itself is not better.
- **A coverage gap is a gap in the platform's records.** Somebody may be testing that
  capability by hand.
- **Injection resistance is tested against the payloads written for it.** An attack nobody
  thought of is untested, not defended.
- **Nothing has been run at scale.** Largest application: 25 pages. Largest pass: 12 tests.

## FAILED — and fixed

Eleven defects, each found by running the thing or looking at it, never by reading the code.

**Found by the golden tests (8):**

1. An unknown environment was read as production, so every write was refused with a reason
   that was both wrong and unactionable.
2. An approval was granted, audited and returned 200, and the run sat waiting for ever — the
   pending count was taken before the save.
3. A resumed pass repeated work and lost what earlier phases had assembled.
4. Named critical areas could never produce a critical-journey proposal.
5. API generation aborted instead of trimming, so a tight budget produced zero API tests.
6. A pass over an unreachable application reported `completed` and "completed its plan".
7. A pass's verification run carried no build reference, so it was invisible to every release
   assessment.

8. **One endpoint had two names in the same pass.** A pass reacting to evidence recorded a
   finding about `/api/session` while every endpoint record in that same pass said
   `http://localhost:4300/api/session`. The place was real — the run had just been refused by
   it — but a route nothing else uses joins to nothing, and the release assessment matches a
   finding's route against the areas a person called business-critical. A critical endpoint
   reached that way could have been left out of the verdict. `AQF-013` found it and pins it.

**Found by the pilot, in one afternoon, after all 251 tests passed (2):**

9. **A release report said NOT SECURITY TESTED about a build that had just been scanned.**
   The window for "scans covering this build" was drawn from the build's test runs and tested
   containment, so a single-run build had a window of one instant. The root cause was deeper:
   a scan recorded no build reference at all, so the relationship was always being deduced
   from timestamps. A scan now records the build it covered. `AQI-056` pins it.
10. **The operator's stated priorities fell on the floor without a word.** Three areas named
   critical, none matched, every gap ranked medium, and the plan quoted the three back so the
   record looked as though they had counted. `AQI-057` pins the disclosure.

**Found by looking at the product rather than at a test (1):**

11. **A stopped pass wore its state twice.** Photographing the agent page for the manual showed
    a pass awaiting approval with two badges side by side, both reading "Awaiting approval" —
    one the run's status, one its phase, the same word for a stopped pass. No test objected,
    because every test asserted the state was shown and it was, twice. The same capture
    exposed two caption proofs that could not fail: one proved "after a completed pass" by the
    run's name being on screen, true of a pass in any state; the other proved the decision log
    was in a photograph using Playwright's notion of visible, which means present in the
    document rather than on the screen — it was a thousand pixels below the fold. Both are now
    proved against what the frame actually contains.

**Recorded and not fixed (2), in `verification/OBSERVED-DEFECTS.md`:** a worker job whose
completion is refused is re-queued with no attempt count; a worker whose Redis connection
drops goes silently idle.

## Against the brief's twenty rules

Each of §53's rules, and what holds it.

| | Rule | Held by |
| --- | --- | --- |
| 1 | Do not rebuild QA NXT | Every phase delegates to the engine that already did the work |
| 2 | Do not duplicate existing services | `AQP-034` reads the registry from the running platform |
| 3 | AI cannot bypass deterministic policy | The ladder is a pure function; no model output reaches it |
| 4 | No testing outside authorization | `AQX-022`, `AQX-023`; the scope guard re-checks at the engine |
| 5 | No automatic destructive actions | `AQP-035`, verified as a refusal only |
| 6 | No automatic high-risk approval | `AQP-045`: it cannot be switched off through the API |
| 7 | Do not fabricate evidence | A permitted decision with no evidence is refused in code |
| 8 | Do not invent functionality | `AQF-013`: no finding names a place the crawl never reached |
| 9 | Do not weaken assertions for a PASS | Three tests were made *stronger* to pass; see the AQ-19 commit |
| 10 | Do not silently modify tests | `AQE-038`: no test was deleted or changed |
| 11 | Do not silently heal security assertions | `AQE-036`: the pass has no authority over healing |
| 12 | Do not hide failures | The two unfixed defects are written down, not omitted |
| 13 | No vulnerability claim without evidence | Findings with no exchange are refused at ingest |
| 14 | No universal compatibility claim | `docs/compatibility.md`, where most rows read NOT TESTED |
| 15 | No "zero bugs" | `AQF-008`, `AQI-029` |
| 16 | No "100% secure" | `AQI-028`: an unscanned build says so in words |
| 17 | No unexplained AI score | Risk is deterministic, every point attributed to a named factor |
| 18 | Every decision auditable | `AQP-001`–`AQP-007`, and the timeline |
| 19 | Every result reproducible | 750 evidence files, hashed, hashes still matching |
| 20 | Every limitation documented | This section, and the three above it |

## The honest summary

An autonomous pass plans, refuses, asks, executes and writes up what it found, and 271 tests
say so with evidence. Thirty requirements are traced to tests that actually ran.

One thing should temper it. Pointing the platform at one unfamiliar application for an
afternoon found two defects that 251 tests had not — including a security report that said
nothing was known about a build it had just scanned. The suite is larger now because those
findings became tests; it was not larger when it mattered.

The console gap that stood here in the previous version of this report is closed: a person can
now read a plan, narrow it, answer the agent's questions and read every refusal without
touching curl. And nothing implemented is unreachable any more. Both were real shortfalls and
both were found by asking what a person could actually do with this, rather than by counting
what passed.

The second is the more useful finding. It is an argument for more pilots, not for more tests.

A smaller version of the same lesson closed this phase. Photographing the new console page for
the manual found a defect nothing had objected to — a stopped pass showing its state twice —
and two of the manual's own caption proofs that could not fail, one of them asserting a
screenshot contained something a thousand pixels below the fold. Six golden tests had the same
shape and were found the same way, by reading what they printed rather than that they passed.
The count in the headline is worth exactly as much as the willingness to keep checking that
each of those tests can still fail.
