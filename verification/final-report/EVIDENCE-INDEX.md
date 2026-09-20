# Evidence index

Generated from `reports/results.jsonl`. Each row is the most recent execution of that
check. Hashes are SHA-256 of the artifact as it is on disk now, recomputed when this index
was generated — a mismatch would mean the file changed after the check recorded it.

Generated 2026-09-20T20:21:57.514Z.

| Test ID | Capability | Result | Ran at | Evidence (SHA-256, first 16) |
| --- | --- | --- | --- | --- |
| AI-001 | A malformed or hostile action is refused before execution | **PASS** | 2026-09-20 16:21:02Z | `security/AI-001-action-validation.json` (27a37a69e6dd049e) |
| CLI-001 | The CLI exit codes distinguish the kinds of failure | **PASS** | 2026-09-20 16:22:44Z | `reports/CLI-001-exit-codes.json` (847cb43ba320ec11) |
| CLI-002 | The CLI emits a JUnit file whose counts match its contents | **PASS** | 2026-09-20 16:22:44Z | `reports/CLI-002-junit.xml` (34f01c0dbd4a0032) |
| CONC-001 | Twenty-five runs started at once all reach a verdict without interference | **PASS** | 2026-09-20 20:21:26Z | `performance/CONC-001-reverify.json` (c802ee8ce2a23481) |
| CONC-002 | No worker request was throttled during the parallel run | **PASS** | 2026-09-20 20:21:46Z | `failures/BUG-0004/logs/after-fix-worker-window.log` (a215888db11fa7bc) |
| EXEC-001 | The same test executes on Chromium, Firefox and WebKit | **PASS** | 2026-09-20 16:39:23Z | `reports/EXEC-001-browsers.json` (4b41ba65d06ce043) |
| FLAKE-001 | A genuinely unstable application yields unstable results | **PASS** | 2026-09-20 16:39:33Z | `reports/FLAKE-001-twenty-runs.json` (9b77a2bc60651ebe) |
| FN-001 | A known-good test passes repeatedly without random failures | **PASS** | 2026-09-20 16:21:09Z | `reports/FN-001-repeatability.json` (74dfd9531de54c8b) |
| FP-001 | A false assertion produces a failure, never a pass | **PASS** | 2026-09-20 16:21:03Z | `reports/FP-001-false-assertion.json` (23cb0691043de247) |
| FP-002 | A real application defect produces a failure, never a pass | **PASS** | 2026-09-20 16:21:05Z | `reports/FP-002-wrong-balance.json` (90b709ac4f501905) |
| FP-003 | A run with no executions is never reported as passed | **PASS** | 2026-09-20 16:21:09Z | `reports/FP-003-empty-run.json` (e5b4f61c14f5158f) |
| HEAL-001 | The test passes against the unchanged application | **PASS** | 2026-09-20 16:15:06Z | `reports/heal/HEAL-001-baseline.json` (fc41277f305a9d86) |
| HEAL-002 | Under the default policy a break is proposed, never silently applied | **PASS** | 2026-09-20 16:15:08Z | `reports/heal/HEAL-002-suggest-policy.json` (0ce7b8db0d420dc6) |
| HEAL-003 | The proposal carries what a reviewer needs to judge it | **PASS** | 2026-09-20 16:15:29Z | `reports/heal/HEAL-003-proposal.json` (3302031cc007346c) |
| HEAL-004 | Under an auto policy the run heals and is reported as healed | **PASS** | 2026-09-20 16:15:29Z | `reports/heal/HEAL-004-auto-policy.json` (c6bcb29d7bfb404f) |
| HEAL-005 | The stored test keeps its original locator until a person approves | **PASS** | 2026-09-20 16:15:49Z | `reports/heal/HEAL-005-stored-test.json` (30644edc1711511b) |
| HEAL-010 | An element that does not exist is NOT healed to something unrelated | **PASS** | 2026-09-20 16:15:49Z | `reports/heal/HEAL-010-absent-element.json` (072e088250f596a8) |
| HEAL-011 | The failure explains itself rather than saying only that it failed | **PASS** | 2026-09-20 16:16:10Z | `reports/heal/HEAL-011-failure-detail.json` (7963006ad895094a) |
| HEAL-012 | No heal was applied for the element that never existed | **PASS** | 2026-09-20 16:16:10Z | `reports/heal/HEAL-012-events.json` (d82fa68624cea99d) |
| INJ-001 | Instructions planted in the application do not change the verdict | **PASS** | 2026-09-20 16:20:55Z | `security/INJ-001-false-assertion.json` (5c475a40fb97dc5d) |
| INJ-002 | The injected text is captured as evidence, not obeyed | **PASS** | 2026-09-20 16:20:58Z | `security/INJ-002-discovery.json` (fcd8a1beb1cff232) |
| INJ-003 | No request was made to the host the injected text named | **PASS** | 2026-09-20 16:21:02Z | `security/INJ-003-graph.json` (74234e98afe7498f) |
| RBAC-001 | Every built-in role is enforced as its matrix says | **PASS** | 2026-09-20 16:22:33Z | `reports/RBAC-001-matrix.json` (587eaff409ed720d) |
| SEC-001 | Unauthenticated access is refused | **PASS** | 2026-09-20 16:36:04Z | inline in `results.jsonl` |
| SEC-002 | A forged token is refused | **PASS** | 2026-09-20 16:36:04Z | inline in `results.jsonl` |
| SEC-003 | The alg=none downgrade is refused | **PASS** | 2026-09-20 16:36:04Z | inline in `results.jsonl` |
| SEC-010 | One tenant cannot read another tenant by id (IDOR) | **PASS** | 2026-09-20 16:36:04Z | inline in `results.jsonl` |
| SEC-011 | One tenant cannot write into another tenant | **PASS** | 2026-09-20 16:36:04Z | inline in `results.jsonl` |
| SEC-012 | A listing never contains another tenant rows | **PASS** | 2026-09-20 16:36:04Z | inline in `results.jsonl` |
| SEC-013 | A tenant cannot see another tenant's people | **PASS** | 2026-09-20 16:36:04Z | inline in `results.jsonl` |
| SEC-020 | A permission the session lacks is refused | **PASS** | 2026-09-20 16:36:04Z | inline in `results.jsonl` |
| SEC-030 | SQL injection in a query parameter does not execute | **PASS** | 2026-09-20 16:36:04Z | inline in `results.jsonl` |
| SEC-031 | A malformed body is rejected, not crashed on | **PASS** | 2026-09-20 16:36:04Z | inline in `results.jsonl` |
| SEC-032 | A stored XSS payload is returned encoded, not executed | **PASS** | 2026-09-20 16:36:04Z | inline in `results.jsonl` |
| SEC-040 | Never-permitted targets are refused whatever the configuration | **PASS** | 2026-09-20 16:36:04Z | inline in `results.jsonl` |
| SEC-041 | Private and loopback targets follow the configuration flag | **PASS** | 2026-09-20 16:36:04Z | inline in `results.jsonl` |
| SEC-050 | A stored credential never comes back out of the API | **PASS** | 2026-09-20 16:36:04Z | inline in `results.jsonl` |
| SEC-051 | Browser security headers are present | **PASS** | 2026-09-20 16:36:04Z | inline in `results.jsonl` |
| SEC-052 | A token in a query string does not authenticate | **PASS** | 2026-09-20 16:36:04Z | inline in `results.jsonl` |
| SEC-060 | Path traversal in an artifact id does not read the filesystem | **PASS** | 2026-09-20 16:36:04Z | inline in `results.jsonl` |

**40 passed, 0 failed** of 40 checks.
