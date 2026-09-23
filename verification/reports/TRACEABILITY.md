# Continuous quality — requirements and the tests that verify them

Each requirement names the golden tests that verify it. traceability.mjs checks this file against what actually ran: a requirement with no test, a test id that does not exist, and a named test that did not pass are all failures. A table nobody checks is a table that rots.

Checked against golden run `CQ9F-FULL-2026-09-23T04-54-10Z`.

**24 of 31 requirements verified.** 7 not covered by this run.

| Requirement | Verified by | Status |
| --- | --- | --- |
| **CQ-R01** A pipeline can run AIRA from a command line and act on the result without parsing output. | CI-001, CI-006, CIS-001 | partially run |
| **CQ-R02** Every documented exit code can actually be produced, and each distinguishes who should look at the failure. | CIS-001, CIS-002, CIS-003, CIS-004, CIS-005, CIS-006, CIS-007, CIS-008, CIS-010, CIS-012, CI-005 | partially run |
| **CQ-R03** A run publishes evidence whether it passed or failed. | CI-001, CIS-002, VIS-004 | partially run |
| **CQ-R04** A failure is reported with enough context to act on without opening the platform. | CI-002, ACC-004, COR-001, COR-003 | VERIFIED |
| **CQ-R05** A run records where it came from, so a failure can be traced to the commit and the deployment that produced it. | CI-007, CIS-009 | partially run |
| **CQ-R06** API endpoints can be tested as first-class test cases, in the same engine as UI tests. | API-001, API-002, API-004, API-013 | VERIFIED |
| **CQ-R07** An API contract change is detected against a stored baseline and classified by how badly it breaks callers. | CON-001, CON-002, CON-003, CON-005, CON-006 | VERIFIED |
| **CQ-R08** A UI failure caused by an API call is explained as such, rather than as a broken locator. | COR-001, COR-002, COR-003 | VERIFIED |
| **CQ-R09** A change selects the tests it reaches, and says why each was or was not selected. | REG-001, REG-002, REG-008, REG-009 | VERIFIED |
| **CQ-R10** Regression runs happen on a schedule without anybody asking, and a schedule that stops running says so. | SCH-001, SCH-002, SCH-003, SCH-004, SCH-005 | VERIFIED |
| **CQ-R11** A quality gate produces PASS, FAIL or REVIEW, and REVIEW survives to the pipeline as its own answer. | CIS-003, CIS-010, CIS-011, CI-004 | partially run |
| **CQ-R12** A quality gate rule whose metric this run could not measure is reported as unmeasured, never as satisfied. | ACC-005, VIS-005 | VERIFIED |
| **CQ-R13** A release decision can be made from what changed, not only from what is broken. | RLS-001, RLS-002, RLS-003, RLS-005, RLS-007 | VERIFIED |
| **CQ-R14** Coverage that stops being exercised is visible rather than silently dropped. | RLS-004 | VERIFIED |
| **CQ-R15** A failure is told to whoever configured a channel, and whether they were told is recorded. | NOT-001, NOT-002, NOT-006 | VERIFIED |
| **CQ-R16** Notifications never carry a credential, checked against the bytes sent. | NOT-005, NOT-007 | VERIFIED |
| **CQ-R17** Test data is reproducible from a seed, so a failure can be reproduced. | DAT-002 | VERIFIED |
| **CQ-R18** A credential is never stored as a literal in test data, and is never returned by any read. | DAT-003, DAT-004, DAT-005 | VERIFIED |
| **CQ-R19** Accessibility is measured against named rules, and a clean result is not reported as a clearance. | ACC-001, ACC-002, ACC-006 | VERIFIED |
| **CQ-R20** A team can measure accessibility before enforcing it. | ACC-003 | VERIFIED |
| **CQ-R21** Visual changes are detected against a baseline, with a noise floor that does not produce false differences. | VIS-001, VIS-002, VIS-006 | VERIFIED |
| **CQ-R22** A visual difference asks for a person by default rather than failing the build, and what was masked is on the record. | VIS-003, VIS-006 | VERIFIED |
| **CQ-R23** AIRA never tests outside its configured authorization boundary, and production is refused without an explicit written authorization. | CIS-008, SCH-005, API-008, NOT-008 | partially run |
| **CQ-R24** A security refusal is reported distinctly from a permissions failure, so nobody resolves it by widening access. | CIS-005, CIS-008 | not run |
| **CQ-R25** A run is never silently finished twice, and one occurrence of a schedule starts exactly one run. | SCH-003, NOT-002 | VERIFIED |
| **CQ-R26** Every continuous-quality surface is scoped to one tenant, and a denial is accompanied by the owner's successful read. | ISO-001, ISO-002, ISO-003, ISO-004, ISO-005, ISO-006 | VERIFIED |
| **CQ-R27** The audit trail can be read through the product, is scoped to one organization, and no parameter widens it. | ISO-007, AUD-005, AUD-006 | VERIFIED |
| **CQ-R28** Actions that change what the platform will permit — authorizing production, changing a schedule, changing a quality gate — are recorded with who asked and why. | AUD-001, AUD-002, AUD-003 | VERIFIED |
| **CQ-R29** A failed or refused action is recorded as such rather than omitted, and never carries the credential that was attempted. | AUD-004, AUD-007, AUD-008 | VERIFIED |
| **CQ-R30** One correlation id follows a request from the caller through the API and the queue to the execution and the audit record, and a caller cannot abuse it. | OBS-001, OBS-002, OBS-003, OBS-005 | VERIFIED |
| **CQ-R31** Liveness and readiness are separable, so a dependency outage does not present as a dead process. | OBS-004 | VERIFIED |

## Tests claimed by no requirement

175 test(s). A test nobody can connect to a requirement is either verifying something undocumented or verifying nothing. This is reported rather than failed, because a test can legitimately exist to cover a defect no requirement anticipated. 134 of them belong to suites this matrix does not cover — they are the product certification's, not this document's — and 41 are continuous-quality tests that no requirement above names.

263 test id(s) are known to exist: 214 written as literals in a suite, 49 built at run time and proven by having executed.

```
AIF-006  AIF-007  AIF-008  AIF-009  API-003  API-005  API-006  API-007  API-009  API-010  API-011  API-012
API-014  ASRT-001  ASRT-002  ASRT-003  ASRT-004  ASRT-005  ASRT-006  ASRT-007  ASRT-008  ASRT-009  ASRT-010  CI-003
CON-004  CON-007  CON-008  CON-009  CON-010  CON-011  CON-012  CON-013  CON-014  COR-004  COR-005  COR-006
COR-007  DAT-001  DAT-006  DAT-007  DAT-008  DET-001  DET-002  DET-003  DET-004  DET-005  DET-006  DET-007
DET-008  DET-009  DET-010  DET-011  DET-012  DISC-001  DISC-002  DISC-003  DISC-004  DISC-005  DISC-006  DISC-007
DISC-008  DISC-009  DISC-010  DISC-011  DISC-012  DISC-013  DISC-014  DISC-015  EXEC-001  EXEC-002  EXEC-003  EXEC-004
EXEC-005  EXEC-006  EXEC-007  EXEC-008  EXEC-009  EXEC-010  EXEC-011  EXEC-012  EXEC-013  EXEC-014  EXEC-015  EXEC-016
EXEC-017  EXEC-018  EXEC-019  EXEC-020  FA-001  FA-002  FA-003  FA-004  FA-005  FA-006  FA-007  FA-008
FA-009  FA-010  FA-011  FA-012  FA-013  FA-014  FA-015  FA-016  GEN-001  GEN-002  GEN-003  GEN-004
GEN-005  GEN-006  GEN-007  GEN-008  GEN-009  GEN-010  GEN-011  GEN-012  GEN-013  GEN-014  GEN-015  GEN-016
HEAL-G01  HEAL-G02  HEAL-G03  HEAL-G04  HEAL-G05  HEAL-G06  HEAL-G07  HEAL-G08  HEAL-M01  HEAL-M02  HEAL-N01  HEAL-N02
HEAL-N03  HEAL-N04  HEAL-N05  HEAL-N06  HEAL-N07  HEAL-N08  HEAL-N09  HEAL-N10  NOT-003  NOT-004  PERF-001  PERF-002
PERF-003  REG-003  REG-004  REG-005  REG-006  REG-007  REG-010  REG-011  REG-012  REL-001  REL-002  REL-003
REL-004  REL-005  REL-006  REL-007  RLS-006  SCH-006  SCH-007  SEC-G01  SEC-G02  SEC-G03  SEC-G04  SEC-G05
SEC-G06  SEC-G07  SEC-G08  SEC-G09  SEC-G10  SEC-G11  VIS-007
```

