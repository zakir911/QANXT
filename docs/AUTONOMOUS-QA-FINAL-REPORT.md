# AIRA — autonomous QA: what was built, and what that establishes

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
| Autonomous golden tests | **253**, all passing, 0 not verified |
| Requirements traced to tests that ran | **30 of 30** |
| Evidence files recorded, hashes still matching | 711 / 711 |
| Unit tests | 885 |
| Integration tests | 57 |
| Independent applications the agent has run against | **1** |
| Defects found by the golden tests | 7 in the product |
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

Seven models have unit tests and no caller. They work in isolation; nothing a user can reach
calls them, so no golden test can establish that they work in the product. They are listed
rather than counted as delivered.

| Component | Brief section | State |
| --- | --- | --- |
| `TestDuplicationModel` | §12 duplication | IMPLEMENTED, unreachable |
| `DynamicSelectionModel` | §14 dynamic selection | IMPLEMENTED, unreachable |
| `ExploratoryModel` | §15 exploratory mode | IMPLEMENTED, unreachable |
| `FailureCorrelationModel` | §21 root-cause correlation | IMPLEMENTED, unreachable |
| `RegressionPromotionModel` | §25, §26 promotion | IMPLEMENTED, unreachable |
| `TestHistoryModel` | §19 historical intelligence | IMPLEMENTED, unreachable |
| `AutonomousAssessmentModel` | §36, §37 release judgement | IMPLEMENTED, unreachable |

`TestGapModel` was in this list and is not any more: it is now the `AnalysingGaps` phase, and
`AQI-039`–`AQI-055` pin it.

## NOT TESTED

- **The autonomous QA dashboard and run timeline in the console (§34, §35).** The console's
  agent page lists passes, shows one and cancels it. The plan a person approves, the decision
  log, the approval queue, the timeline, the business context and the coverage assessment are
  **API-only**. A person would today answer the agent's questions with curl. The
  human-in-the-loop requirement is satisfied in the platform and not in the product.
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

Nine defects, each found by running the thing rather than reading it.

**Found by the golden tests (7):**

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

**Found by the pilot, in one afternoon, after all 251 tests passed (2):**

8. **A release report said NOT SECURITY TESTED about a build that had just been scanned.**
   The window for "scans covering this build" was drawn from the build's test runs and tested
   containment, so a single-run build had a window of one instant. The root cause was deeper:
   a scan recorded no build reference at all, so the relationship was always being deduced
   from timestamps. A scan now records the build it covered. `AQI-056` pins it.
9. **The operator's stated priorities fell on the floor without a word.** Three areas named
   critical, none matched, every gap ranked medium, and the plan quoted the three back so the
   record looked as though they had counted. `AQI-057` pins the disclosure.

**Recorded and not fixed (2), in `verification/OBSERVED-DEFECTS.md`:** a worker job whose
completion is refused is re-queued with no attempt count; a worker whose Redis connection
drops goes silently idle.

## Against the brief's twenty rules

Each of §53's rules, and what holds it.

| | Rule | Held by |
| --- | --- | --- |
| 1 | Do not rebuild AIRA | Every phase delegates to the engine that already did the work |
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
| 19 | Every result reproducible | 711 evidence files, hashed, hashes still matching |
| 20 | Every limitation documented | This section, and the three above it |

## The honest summary

An autonomous pass plans, refuses, asks, executes and writes up what it found, and 253 tests
say so with evidence. Thirty requirements are traced to tests that actually ran.

Two things should temper that. Almost none of it is reachable from the console, so what has
been verified is a platform rather than a product. And pointing it at one unfamiliar
application for an afternoon found two defects that 251 tests had not — including a security
report that said nothing was known about a build it had just scanned. The suite is 253 now
because those two findings became tests; it was not 253 when it mattered.

The second is the more useful finding. It is an argument for more pilots, not for more tests.
