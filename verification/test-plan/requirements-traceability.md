# Requirements traceability

Every capability the repository implements, mapped to the checks that exercise it and the
evidence they produced. Status is what the evidence supports, not what the code suggests.

Check IDs resolve in `final-report/EVIDENCE-INDEX.md`, which carries timestamps and artifact
hashes. "Project suite" means the repository's own tests, which were run for regressions but
are not independent evidence.

| ID | Feature | Requirement | Test IDs | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| R-01 | Authentication | Only a token this platform issued grants access | SEC-001, SEC-002, SEC-003 | `security/http-exchanges.json` | **VERIFIED** |
| R-02 | Session revocation | Disabling, demoting or resetting ends live sessions at once | Project suite (`UserManagementTests`) | 52 integration tests | **VERIFIED** |
| R-03 | Tenant isolation | One tenant cannot read or write another's data | SEC-010, SEC-011, SEC-012, SEC-013 | `security/http-exchanges.json` | **VERIFIED** |
| R-04 | RBAC | Each built-in role is enforced server-side | RBAC-001, SEC-020 | `reports/RBAC-001-matrix.json` | **VERIFIED** |
| R-05 | SSRF protection | The platform cannot be pointed at internal or metadata addresses | SEC-040, SEC-041 | `failures/BUG-0001/` | **VERIFIED** (after BUG-0001) |
| R-06 | Injection resistance | SQL, XSS and malformed input are refused safely | SEC-030, SEC-031, SEC-032 | `security/http-exchanges.json` | **VERIFIED** |
| R-07 | Path traversal | Artifact ids cannot read the filesystem | SEC-060 | `security/http-exchanges.json` | **VERIFIED** |
| R-08 | Credential storage | A stored credential never comes back out | SEC-050, BUG-0003 | `failures/BUG-0003/` | **VERIFIED** (after BUG-0003) |
| R-09 | Transport headers | Browser security headers and CSP are set | SEC-051, SEC-052 | `security/http-exchanges.json` | **VERIFIED** |
| R-10 | Application discovery | A real application is crawled into a knowledge graph | INJ-002 | `security/INJ-002-discovery.json` | **PARTIALLY VERIFIED** — crawl runs and produces pages; expected-vs-discovered model comparison not done |
| R-11 | Test generation | Tests are generated from the discovered model | Project suite, agent pass | `docs/verification-status.md` | **PARTIALLY VERIFIED** — generation observed producing runnable tests; generation quality not independently assessed |
| R-12 | Journey import | A recorded journey becomes an executable test | HEAL-001…012, all trust checks | `reports/heal/` | **VERIFIED** |
| R-13 | Browser execution | Tests run on Chromium, Firefox and WebKit | EXEC-001 | `reports/EXEC-001-browsers.json` | **VERIFIED** |
| R-14 | Evidence capture | Screenshots, video, trace and network logs are stored | CONC-002, HEAL evidence | `failures/BUG-0004/logs/` | **VERIFIED** |
| R-15 | Self-healing (positive) | A renamed locator is healed without editing the test | HEAL-002, HEAL-003, HEAL-004 | `reports/heal/` | **VERIFIED** |
| R-16 | Self-healing (negative) | A missing element is never healed to something else | HEAL-010, HEAL-011, HEAL-012 | `reports/heal/HEAL-010-absent-element.json` | **VERIFIED** |
| R-17 | Healing policy | Healing only applies when a project opts in | HEAL-002 (suggest), HEAL-004 (auto), HEAL-005 | `reports/heal/` | **VERIFIED** |
| R-18 | Failure explanation | A failure says why, not just that it failed | HEAL-011 | `reports/heal/HEAL-011-failure-detail.json` | **VERIFIED** |
| R-19 | No false positives | A broken application or false assertion fails | FP-001, FP-002, FP-003 | `reports/FP-*.json` | **VERIFIED** |
| R-20 | No false negatives | A known-good test does not fail at random | FN-001 | `reports/FN-001-repeatability.json` | **VERIFIED** |
| R-21 | Prompt injection | Application content is data, never instruction | INJ-001, INJ-002, INJ-003 | `security/INJ-*.json` | **VERIFIED** |
| R-22 | AI action safety | Model-proposed actions are schema-validated before execution | AI-001 | `security/AI-001-action-validation.json` | **VERIFIED** |
| R-23 | Instability detection | An unstable application produces visibly unstable results | FLAKE-001 | `reports/FLAKE-001-twenty-runs.json` | **VERIFIED** |
| R-24 | Concurrency | Parallel runs all reach a verdict | CONC-001, CONC-002 | `performance/CONC-001-reverify.json` | **VERIFIED** (after BUG-0004) |
| R-25 | Stranded work | A run always reaches a verdict | BUG-0005 re-verification | `failures/BUG-0005/` | **VERIFIED** (after BUG-0005) |
| R-26 | CLI | Exit codes distinguish failure kinds; JUnit is well-formed | CLI-001, CLI-002 | `reports/CLI-*.json`, `reports/CLI-002-junit.xml` | **VERIFIED** |
| R-27 | Quality gates | A failing gate blocks a pipeline | Project suite (`tests/e2e/cli-check.mjs`) | `docs/verification-status.md` | **PARTIALLY VERIFIED** — verified by the project's own e2e check, not independently re-run here |
| R-28 | Autonomous agent | A bounded pass proposes without acting | Project suite (`AgentTests`) | 52 integration tests | **PARTIALLY VERIFIED** — bounds and absence of authority covered by the project suite; not independently re-executed |
| R-29 | Browser extension | A journey is recorded in a real browser | EXT-001, EXT-002, EXT-007 | `evidence/extension/recorded-journey.json` | **VERIFIED** |
| R-33 | Recorder fidelity | Recorded locators address real elements in a fresh browser | EXT-004 | `evidence/extension/locator-resolution.json` | **VERIFIED** |
| R-34 | Recorder transparency | The recorder does not alter or intercept the application it records | EXT-005 | `evidence/extension/page-fingerprints.json` | **VERIFIED** |
| R-35 | Recorded credentials | A typed password is unreadable in the export, the extension's storage, the popup and the platform's database | EXT-003, EXT-006 | `evidence/extension/session-storage.json`, `evidence/extension/imported-test-case.json` | **VERIFIED** |
| R-30 | CI/CD pipelines | Pipelines run the product and publish results | — | — | **NOT VERIFIED** — no runner available; see limitations |
| R-31 | Docker deployment | The platform runs from one compose file | Project verification | `docs/verification-status.md` | **PARTIALLY VERIFIED** — API and worker images built and run; console and demo-bank images unbuildable here |
| R-32 | Manual test authoring | A test can be written by hand | BUG-0002 | `failures/BUG-0002/` | **NOT IMPLEMENTED** — no endpoint exists |

## Added by the product test lab and golden suite (2026-09-21)

The rows above came from the independent verification pass in September. The golden suite
re-examines several of them against purpose-built applications with written-down ground
truth, and covers capabilities that pass could only observe in passing. Test IDs resolve in
`reports/GOLDEN-TEST-REPORT.md`; evidence is under `evidence/<TEST-ID>/<RUN-ID>/`, each
artifact hashed in `reports/EVIDENCE-INDEX.md`.

| ID | Feature | Requirement | Test IDs | Status |
| --- | --- | --- | --- | --- |
| R-10 | Application discovery | A real application is crawled into a knowledge graph, measured against ground truth | DISC-001…DISC-015 | **VERIFIED** — recall and precision measured against hand-written ground truth for a React SPA, and repeated against one whose ids regenerate each render (supersedes the earlier PARTIALLY VERIFIED) |
| R-11 | Test generation | Tests generated from the model are runnable and reach the application | GEN-001…GEN-015 | **VERIFIED** for the built-in rules engine — generated tests executed unedited and one failed once the application was broken. **NOT VERIFIED** for a hosted model provider (GEN-016): none is configured here |
| R-36 | Fault injection | A named fault can be turned on and off without editing application source | Every DET-, HEAL- and GEN-011 test | **VERIFIED** — faults are set through `POST /__faults` on the application under test |
| R-37 | Failure classification | A failure is classified into the right category | FA-001…FA-012 | **VERIFIED** — accuracy measured across every failure class the lab can produce |
| R-38 | Analysis honesty | An analysis explains a failure and never overturns its verdict | FA-013, FA-014 | **VERIFIED** |
| R-39 | Duplicate failures | The same failure seen twice is recognised, not counted as new | FA-015 | **VERIFIED** |
| R-40 | Silent failure | A confirmation shown for something that never happened is caught | FA-016, DET-010 | **VERIFIED** |
| R-41 | Negative self-healing | A removed or changed-meaning control is never healed to something else | HEAL-N01…HEAL-N10 | see report — each requires both that the run fails *and* that the browser never reaches the signed-in page |
| R-42 | False-healing rate | Incorrect heals are counted and reported, never folded into a success rate | HEAL-M01, HEAL-M02 | see report — the rate and the confidence margin are published as numbers |
| R-43 | Assertion correctness | Each assertion type holds when it should and fails when it should not | ASRT-001…ASRT-008 | **VERIFIED** |
| R-44 | Late-arriving content | An assertion waits for content rather than reading the page once | EXEC-017, ASRT-002, ASRT-004 | **VERIFIED** (after BUG-0014) |
| R-45 | Evidence integrity | Every artifact is hashed at capture and the hash re-checked in the index | EXEC-012, EXEC-013, EXEC-014, DISC-014 | **VERIFIED** |
| R-46 | Evidence retention | A run never overwrites an earlier run's evidence | Harness (`evidence/<TEST-ID>/<RUN-ID>/`) | **VERIFIED** — enforced by the harness, visible in the evidence tree |
| R-47 | Repeatability | Ten identical runs produce one verdict | REL-001 | see report |
| R-48 | Instability visibility | An application that is genuinely unstable produces visibly unstable results | REL-002 | see report — the application's own delay record is the control |
| R-49 | Concurrency | Runs started together all reach a verdict | REL-003 | see report |
| R-50 | SPA authentication | Sign-in against a single-page application is detected by outcome, not by a load event | DISC-001 (and every test that signs in) | **VERIFIED** (after BUG-0007) |
| R-51 | Recorded sign-in | A test that signs in itself is not forced through a second configured sign-in | Every imported journey test | **VERIFIED** (after BUG-0009) |
| R-52 | Scenario budget | `maxScenarios` is respected | GEN-009 | **VERIFIED** (after BUG-0011) |
| R-53 | Prompt injection (generation) | Text in the application under test cannot instruct the generator | GEN-014 | **VERIFIED** |
| R-55 | Generated assertions can fail | A generated assertion is about something the action could change | GEN-010, GEN-011, `verification/bugs/BUG-0016/reproduce.mjs` | **VERIFIED** (after BUG-0016) — GEN-011 now attributes the failure to the injected fault rather than accepting any failure |
| R-57 | Every assertion type is authorable | An assertion the engine implements can be written and reaches it | ASRT-001…ASRT-010, `verification/bugs/BUG-0017/reproduce.mjs` | **VERIFIED** (after BUG-0017) — assertCount and assertAttribute were unreachable end to end |
| R-58 | Performance baseline | The cost of discovery, execution and generation is measured, not asserted | PERF-001, PERF-002, PERF-003 | **VERIFIED** — published in the report with the hardware it was measured on; no gate depends on it |
| R-56 | The lab itself | The applications serve, their faults bite, and their ground truth still matches | `test-lab/scripts/lab-selftest.mjs` | **VERIFIED** — 34 checks, run by `make test` |
| R-54 | Verification visibility | The console shows the last golden run and cannot report green over a red gate | `apps/web-console/src/pages/VerificationPage.test.tsx` | **VERIFIED** — the gate re-check is itself tested with a report that falsely claims to have passed |
