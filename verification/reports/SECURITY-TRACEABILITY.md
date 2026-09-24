# Security testing — requirements and the tests that verify them

Each requirement names the golden tests that verify it, and traceability.mjs checks this file against what actually ran: a requirement with no test, a test id that does not exist, and a named test that did not pass are all failures.

Two requirements are deliberately not on this list because nothing here verifies them, and adding a row that points at no evidence would be worse than the gap. Detection against an application AIRA has not seen is not measurable in a lab whose flaws were written alongside the checks (SECN-003). Browser-driven DOM XSS is not implemented (SECN-002). Both are recorded as NOT VERIFIED in the golden results rather than omitted.

SEC-R43 to SEC-R49 are about AIRA itself rather than the applications it tests. A security testing tool that is not itself secure is a liability, and its own tenancy, credential handling and target policy are verified by the same kind of test as everything else here.

Checked against golden run `SEC-2026-09-24T01-47-11Z`.

**58 of 58 requirements verified.**

| Requirement | Verified by | Status |
| --- | --- | --- |
| **SEC-R01** Security testing runs only against an application somebody has explicitly authorized in writing. | SECG-001, SECG-003, SECG-002 | VERIFIED |
| **SEC-R02** Security scope is never unrestricted: an empty allowlist permits nothing and an unlisted host is refused. | SECG-004, SECG-005 | VERIFIED |
| **SEC-R03** Arbitrary URLs are never testable, and cloud metadata and link-local addresses are refused whatever the scope says. | SECG-005, SECG-006, SECG-007, SECG-008, SECG-022 | VERIFIED |
| **SEC-R04** A security check cannot bypass the scope guard; the declared risk can be raised by the HTTP verb and never lowered. | SECG-013, SECG-012, SECE-003 | VERIFIED |
| **SEC-R05** Destructive testing is off by default and needs both a scope that permits it and a caller who may run it. | SECG-012, SECF-008, SECF-012 | VERIFIED |
| **SEC-R06** Security scanning never performs a load or denial-of-service test; every volume probe is bounded and says so. | SECD-007, SECD-014, SECD-025 | VERIFIED |
| **SEC-R07** Production security testing is disabled by default and refused unless authorized for that run. | SECG-016, SECG-017, SECG-018 | VERIFIED |
| **SEC-R08** The security lab uses only synthetic identities and synthetic data; no real credential is used anywhere. | SECD-001, SECD-006, SECE-002 | VERIFIED |
| **SEC-R09** Secrets never appear in the evidence a report links to, and redaction does not destroy the evidence. | SECE-002, SECE-004 | VERIFIED |
| **SEC-R10** No vulnerability is reported without a reproducible request/response exchange behind it. | SECE-001, SECQ-009 | VERIFIED |
| **SEC-R11** A finding's severity is computed from stored factors and is reproducible, never assigned by a model. | SECM-001, SECM-018, SECM-034 | VERIFIED |
| **SEC-R12** Broken object level authorization is detected, with a control proving the owner can read what the intruder cannot. | SECD-001, SECP-001, SECM-001 | VERIFIED |
| **SEC-R13** Broken function level authorization and privilege escalation are detected. | SECD-002, SECD-003, SECP-002, SECP-003 | VERIFIED |
| **SEC-R14** Missing authorization and unverified tokens are detected. | SECD-004, SECD-005, SECP-004, SECP-005 | VERIFIED |
| **SEC-R15** Authentication weaknesses are detected: user enumeration, missing lockout, session survival after sign-out, excessive session lifetime and reset-token reuse. | SECD-006, SECD-007, SECD-008, SECD-009, SECD-010 | VERIFIED |
| **SEC-R16** API security flaws are detected: mass assignment, missing input validation, unsafe methods, missing rate limiting and excessive data exposure. | SECD-011, SECD-012, SECD-013, SECD-014, SECD-015 | VERIFIED |
| **SEC-R17** Reflected and stored XSS are detected, and reflection alone is never reported as XSS. | SECD-016, SECD-017, SECS-003, SECS-004 | VERIFIED |
| **SEC-R18** SQL, NoSQL, command and template injection are detected by indicator, with nothing extracted or executed. | SECD-018, SECD-019, SECD-020, SECD-021 | VERIFIED |
| **SEC-R19** CSRF and missing origin validation are detected, with a control that the legitimate request succeeds. | SECD-022, SECD-023, SECP-022, SECP-023 | VERIFIED |
| **SEC-R20** File upload restrictions are tested without uploading anything executable, and path traversal in a filename is detected. | SECD-024, SECD-025, SECD-026 | VERIFIED |
| **SEC-R21** Open redirect is detected by reading the Location header and never by following it. | SECD-027, SECP-027 | VERIFIED |
| **SEC-R22** SSRF is detected without probing cloud metadata by default. | SECD-028, SECP-028, SECS-009 | VERIFIED |
| **SEC-R23** Passive checks detect missing security headers, insecure cookie attributes, dangerous CORS, directory listings, exposed source maps and verbose errors. | SECD-029, SECD-030, SECD-031, SECD-032, SECD-033, SECD-034 | VERIFIED |
| **SEC-R24** A permissive CORS policy without credentials is not reported as a vulnerability. | SECS-007 | VERIFIED |
| **SEC-R25** Every detector is silent against the corrected application; false positives are measured, not assumed. | SECR-001, SECP-001, SECP-016, SECP-029 | VERIFIED |
| **SEC-R26** Endpoints that behave correctly produce no finding even while the rest of the application is vulnerable. | SECS-001, SECS-002, SECS-005, SECS-006, SECS-008 | VERIFIED |
| **SEC-R27** Scan profiles bound what a scan will do, and each profile refuses the risk levels above it. | SECF-002, SECF-008, SECF-010, SECF-011 | VERIFIED |
| **SEC-R28** What a scan was refused is recorded, so coverage can be read from what it did not do. | SECE-003, SECQ-005 | VERIFIED |
| **SEC-R29** Areas a scan cannot decide are reported as untested, never as clean. | SECX-001, SECQ-010 | VERIFIED |
| **SEC-R30** A build with no security scan is never reported as passing a security gate. | SECQ-001 | VERIFIED |
| **SEC-R31** A partial scan does not pass a security gate however clean its findings were. | SECQ-004, SECQ-005 | VERIFIED |
| **SEC-R32** New findings at or above the configured severity block a build; the gate can also pass. | SECQ-002, SECQ-011 | VERIFIED |
| **SEC-R33** A security regression fails the gate at any severity. | SECQ-007, SECB-004 | VERIFIED |
| **SEC-R34** A suppressed finding with no written justification and no named decision-maker is counted as open. | SECQ-006, SECT-001, SECT-002, SECT-003, SECT-004, SECT-005 | VERIFIED |
| **SEC-R35** A finding's status history is appended to, never overwritten, so the decisions form an audit trail. | SECT-006 | VERIFIED |
| **SEC-R36** A false positive suppresses one finding and never the same class elsewhere. | SECT-007 | VERIFIED |
| **SEC-R37** Nothing automated can mark a security finding resolved or suppressed; self-healing cannot hide a regression. | SECT-008, SECB-002, SECB-003 | VERIFIED |
| **SEC-R38** A finding absent from a scan is never recorded as fixed on absence alone. | SECB-002, SECB-003 | VERIFIED |
| **SEC-R39** Findings have a stable identity across runs that survives rewording and severity revision. | SECB-001, SECB-005 | VERIFIED |
| **SEC-R40** No report claims an application is secure or that it has zero vulnerabilities. | SECQ-003, SECQ-010 | VERIFIED |
| **SEC-R41** A low-confidence finding goes to review rather than stopping a release. | SECQ-008 | VERIFIED |
| **SEC-R42** Security scanning, triage and authorization are permission-gated, and none is available to a read-only user. | SECG-015, SECG-011 | VERIFIED |
| **SEC-R43** AIRA's own API refuses unauthenticated and forged-token requests on every data endpoint. | SEC-G01, SEC-G02 | VERIFIED |
| **SEC-R44** AIRA isolates tenants: one organization cannot read or act inside another's data by knowing an identifier. | SEC-G03, SEC-G04 | VERIFIED |
| **SEC-R45** AIRA stores injection payloads as data and never executes them. | SEC-G05 | VERIFIED |
| **SEC-R46** AIRA refuses to point its own crawler or scanner at targets that are never legitimate. | SEC-G06, SEC-G11 | VERIFIED |
| **SEC-R47** Credentials AIRA stores for an application under test are never returned by its API. | SEC-G07 | VERIFIED |
| **SEC-R48** AIRA's own artifact paths cannot be turned into a traversal, and arbitrary script execution needs an explicit opt-in. | SEC-G08, SEC-G09 | VERIFIED |
| **SEC-R49** AIRA sets the browser security headers it claims to. | SEC-G10 | VERIFIED |
| **SEC-R50** The security controls permit an authorized scan as well as refusing an unauthorized one; they are not a refusal of everything. | SECG-024, SECF-001, SECF-005, SECQ-011 | VERIFIED |
| **SEC-R51** A security scope is stored with the written authorization, the person who gave it and when, and cannot be enabled without one. | SECPL-001, SECPL-002, SECPL-003, SECPL-005 | VERIFIED |
| **SEC-R52** Destructive testing and production can never be authorized together, refused where somebody configures it rather than one request at a time. | SECPL-004 | VERIFIED |
| **SEC-R53** A scan cannot be recorded against an application with no enabled scope, and a finding with no evidence is refused rather than stored. | SECPL-006, SECPL-014 | VERIFIED |
| **SEC-R54** A stored finding's first sighting is Potential; reproduction across scans is what makes it Confirmed. | SECPL-007, SECPL-008 | VERIFIED |
| **SEC-R55** Stored findings have a stable identity: the same flaw reported again updates its row and keeps the new severity. | SECPL-008 | VERIFIED |
| **SEC-R56** Triage through the API refuses a suppression with no justification or one too short to be one, and records the decision in the audit log. | SECPL-009, SECPL-010, SECPL-011 | VERIFIED |
| **SEC-R57** A resolved finding detected again becomes a regression, its disposition does not survive, and the stored scan's gate reads FAIL. | SECPL-012, SECPL-013 | VERIFIED |
| **SEC-R58** Security findings, scans and scopes are invisible to another tenant. | SECPL-015 | VERIFIED |

## Tests claimed by no requirement

327 test(s). A test nobody can connect to a requirement is either verifying something undocumented or verifying nothing. This is reported rather than failed, because a test can legitimately exist to cover a defect no requirement anticipated. 324 of them belong to suites this matrix does not cover — they are the product certification's, not this document's — and 3 are continuous-quality tests that no requirement above names.

464 test id(s) are known to exist: 264 written as literals in a suite, 200 built at run time and proven by having executed.

```
ACC-001  ACC-002  ACC-003  ACC-004  ACC-005  ACC-006  AIF-001  AIF-002  AIF-003  AIF-004  AIF-005  AIF-006
AIF-007  AIF-008  AIF-009  API-001  API-002  API-003  API-004  API-005  API-006  API-007  API-008  API-009
API-010  API-011  API-012  API-013  API-014  ASRT-001  ASRT-002  ASRT-003  ASRT-004  ASRT-005  ASRT-006  ASRT-007
ASRT-008  ASRT-009  ASRT-010  AUD-001  AUD-002  AUD-003  AUD-004  AUD-005  AUD-006  AUD-007  AUD-008  CI-001
CI-002  CI-003  CI-004  CI-005  CI-006  CI-007  CI-008  CIS-001  CIS-002  CIS-003  CIS-004  CIS-005
CIS-006  CIS-007  CIS-008  CIS-009  CIS-010  CIS-011  CIS-012  CON-001  CON-002  CON-003  CON-004  CON-005
CON-006  CON-007  CON-008  CON-009  CON-010  CON-011  CON-012  CON-013  CON-014  COR-001  COR-002  COR-003
COR-004  COR-005  COR-006  COR-007  DAT-001  DAT-002  DAT-003  DAT-004  DAT-005  DAT-006  DAT-007  DAT-008
DET-001  DET-002  DET-003  DET-004  DET-005  DET-006  DET-007  DET-008  DET-009  DET-010  DET-011  DET-012
DISC-001  DISC-002  DISC-003  DISC-004  DISC-005  DISC-006  DISC-007  DISC-008  DISC-009  DISC-010  DISC-011  DISC-012
DISC-013  DISC-014  DISC-015  EXEC-001  EXEC-002  EXEC-003  EXEC-004  EXEC-005  EXEC-006  EXEC-007  EXEC-008  EXEC-009
EXEC-010  EXEC-011  EXEC-012  EXEC-013  EXEC-014  EXEC-015  EXEC-016  EXEC-017  EXEC-018  EXEC-019  EXEC-020  FA-001
FA-002  FA-003  FA-004  FA-005  FA-006  FA-007  FA-008  FA-009  FA-010  FA-011  FA-012  FA-013
FA-014  FA-015  FA-016  GEN-001  GEN-002  GEN-003  GEN-004  GEN-005  GEN-006  GEN-007  GEN-008  GEN-009
GEN-010  GEN-011  GEN-012  GEN-013  GEN-014  GEN-015  GEN-016  HEAL-G01  HEAL-G02  HEAL-G03  HEAL-G04  HEAL-G05
HEAL-G06  HEAL-G07  HEAL-G08  HEAL-M01  HEAL-M02  HEAL-N01  HEAL-N02  HEAL-N03  HEAL-N04  HEAL-N05  HEAL-N06  HEAL-N07
HEAL-N08  HEAL-N09  HEAL-N10  ISO-001  ISO-002  ISO-003  ISO-004  ISO-005  ISO-006  ISO-007  NOT-001  NOT-002
NOT-003  NOT-004  NOT-005  NOT-006  NOT-007  NOT-008  OBS-001  OBS-002  OBS-003  OBS-004  OBS-005  PERF-001
PERF-002  PERF-003  REG-001  REG-002  REG-003  REG-004  REG-005  REG-006  REG-007  REG-008  REG-009  REG-010
REG-011  REG-012  REL-001  REL-002  REL-003  REL-004  REL-005  REL-006  REL-007  RLS-001  RLS-002  RLS-003
RLS-004  RLS-005  RLS-006  RLS-007  SCH-001  SCH-002  SCH-003  SCH-004  SCH-005  SCH-006  SCH-007  SECF-003
SECF-004  SECF-006  SECF-007  SECF-009  SECG-009  SECG-010  SECG-014  SECG-019  SECG-020  SECG-021  SECG-023  SECM-002
SECM-003  SECM-004  SECM-005  SECM-006  SECM-007  SECM-008  SECM-009  SECM-010  SECM-011  SECM-012  SECM-013  SECM-014
SECM-015  SECM-016  SECM-017  SECM-019  SECM-020  SECM-021  SECM-022  SECM-023  SECM-024  SECM-025  SECM-026  SECM-027
SECM-028  SECM-029  SECM-030  SECM-031  SECM-032  SECM-033  SECN-001  SECN-002  SECN-003  SECP-006  SECP-007  SECP-008
SECP-009  SECP-010  SECP-011  SECP-012  SECP-013  SECP-014  SECP-015  SECP-017  SECP-018  SECP-019  SECP-020  SECP-021
SECP-024  SECP-025  SECP-026  SECP-030  SECP-031  SECP-032  SECP-033  SECP-034  VIS-001  VIS-002  VIS-003  VIS-004
VIS-005  VIS-006  VIS-007
```

