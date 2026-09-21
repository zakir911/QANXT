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
