# AIRA — security verification report

**AIRA's security testing behaved as specified against its own lab in this run.**

Run `SEC-2026-09-24T06-42-53Z` · 222 security test(s) · 219 passed, 0 failed, 3 not verified

> What this report is, and is not
> 
> This report describes AIRA's security *testing*. It says that the checks detect the flaws
> planted in the security lab, stay quiet on the endpoints that are correct, refuse everything
> the scope does not authorize, and record what they could not reach.
> 
> It is not a security assessment of any application. It does not say that AIRA is secure, that
> the lab is secure, or that any application AIRA scans is secure. No scan can support those
> claims, and nothing here should be quoted as though it did.
> 
> The detection rate below is measured against a lab whose flaws were written alongside the
> checks that find them. That is the right way to test a detector and the wrong way to estimate
> how it will do against an application nobody has seen. The number describes this lab.

## What was measured

| | |
| --- | --- |
| Flaws planted in the lab | 35 |
| Detection scenarios run | 34 |
| Planted flaws this scan cannot decide | 1 — see "What was NOT tested" |
| Flaws detected | 34 |
| False positives on the corrected application | 0 |
| Endpoints the ground truth calls correct | 8 |
| Findings reported against those endpoints | 0 |
| Evidence files recorded | 223 |
| Evidence files whose hash still matches | 223 |

## Results by family

| Family | Passed | What it establishes |
| --- | --- | --- |
| Detection | 34/34 | The flaw is switched on alone and the check reports it |
| Precision | 34/34 | The flaw is switched off and the check reports nothing |
| Classification | 34/34 | CWE, OWASP category and severity band match the ground truth |
| False positives | 9/9 | Endpoints the ground truth calls correct stay quiet |
| Scope guard | 24/24 | What security testing refuses to do, and the one thing it allows |
| Evidence | 4/4 | Findings without evidence are refused; secrets are redacted |
| Scan profiles | 12/12 | Each profile refuses the risk levels above it |
| Security gate | 11/11 | What stops a build, and what a clean result is allowed to say |
| Regression | 5/5 | What changed since the last scan, and what absence does not prove |
| Triage | 8/8 | Suppression needs a reason and a name |
| Coverage honesty | 1/1 | What this scan cannot decide |
| Measured rates | 1/1 | Detection and false positives, as measured |
| Stored scans | 31/31 | Scopes, scans, findings and triage through AIRA's own API |
| AIRA itself | 11/11 | Tenancy, credentials, target policy and headers in the platform |

## Requirements

73 of 73 security requirements verified in this run. The full matrix, including which test verifies each one, is in `SECURITY-TRACEABILITY.md`.

## What was NOT tested

Distinguishing tested coverage from untested areas is a requirement, not a courtesy. These are
recorded in the golden results as NOT VERIFIED rather than omitted, so they survive into every
report generated from that run.

| Test | What it would have established | Why it did not run |
| --- | --- | --- |
| `SECN-001` | Security scanning against a production environment | Not executed. Production security testing is disabled by default and no production environment exists here. The refusal path is verified by SECG-016 and SECG-017; the permitted path is not exercised anywhere and is NOT VERIFIED. |
| `SECN-002` | Browser-driven DOM XSS detection | Not implemented. SECX-001 records DOM XSS as not testable by this scan rather than as absent. Until a browser-driven security scan exists, DOM-based XSS is an untested area of coverage. |
| `SECN-003` | Detection rate against an application AIRA has not seen | Not measured, and not measurable here. Every flaw in the lab was written alongside the check that finds it. The rate in SECR-001 describes this lab and nothing else. |

### Known limitations

- **DOM-based cross-site scripting is not detected.** The source never reaches the server and
  the sink runs in the browser, so a response-only scan cannot see it. `SECX-001` records it as
  not testable rather than absent. A browser-driven security scan would reach it; none exists.
- **Cloud metadata endpoints are never probed by default.** SSRF detection uses loopback and
  private-range destinations. That area is untested, not clean.
- **Production scanning has never been exercised in its permitted form.** Only its refusal is
  verified (`SECG-016`, `SECG-017`).
- **The detection rate does not generalise.** Every flaw in the lab was written alongside the
  check that finds it.
- **There is no security surface in the console.** Scopes, scans, findings and triage are
  persisted and verified end to end through the API (`SECPL-001` to `SECPL-015`), but nothing
  is reachable by clicking. The screens and the trend queries are NOT IMPLEMENTED.
- **The scanner does not run inside the worker.** The engine is driven by the golden suites and
  the API records what it found, so `POST /api/v1/security/scans` is an ingestion endpoint
  rather than the far end of a "start a scan" button.

### The OWASP taxonomy

- `owasp-api-top10.json` — edition 2023, **not verified against the published source**: outbound network access was blocked in the environment where it was written, so the categories were recorded from knowledge and flagged. `scripts/refresh-owasp-taxonomy` fetches and replaces them, and fails loudly rather than silently keeping the unverified copy.
- `owasp-web-top10.json` — edition 2021, **not verified against the published source**: outbound network access was blocked in the environment where it was written, so the categories were recorded from knowledge and flagged. `scripts/refresh-owasp-taxonomy` fetches and replaces them, and fails loudly rather than silently keeping the unverified copy.

## Every security test in this run

| Test | Result | Objective | Evidence |
| --- | --- | --- | --- |
| `SEC-G01` | PASS | Every data endpoint refuses an unauthenticated request | 1 file(s) |
| `SEC-G02` | PASS | A forged or tampered token is refused | 1 file(s) |
| `SEC-G03` | PASS | One tenant cannot read another's data by knowing its identifier | 1 file(s) |
| `SEC-G04` | PASS | One tenant cannot start work inside another's project | 1 file(s) |
| `SEC-G05` | PASS | SQL and script payloads in user input are stored as data, not executed | 1 file(s) |
| `SEC-G06` | PASS | The platform refuses targets that are never legitimate, whatever it is configured to allow | 1 file(s) |
| `SEC-G07` | PASS | A stored credential is never returned by the API | 1 file(s) |
| `SEC-G08` | PASS | Artifact identifiers cannot be turned into a path traversal | 1 file(s) |
| `SEC-G09` | PASS | A test cannot run arbitrary JavaScript in the browser unless the project allows it | 1 file(s) |
| `SEC-G10` | PASS | The API sets the browser security headers it claims to | 1 file(s) |
| `SEC-G11` | PASS | Loopback and private addresses are treated consistently with the deployment's configuration | 1 file(s) |
| `SECB-001` | PASS | A finding reported twice gets the same fingerprint, and a different one does not | 1 file(s) |
| `SECB-002` | PASS | A finding absent from a scan is never recorded as resolved on absence alone | 1 file(s) |
| `SECB-003` | PASS | A check that ran and did not reproduce a finding says so, and still does not resolve it | 1 file(s) |
| `SECB-004` | PASS | A resolved finding detected again is marked as a regression | 2 file(s) |
| `SECB-005` | PASS | A triage decision carries forward but the severity does not | 1 file(s) |
| `SECD-001` | PASS | A user reading another user's object by identifier is reported as BOLA | 1 file(s) |
| `SECD-002` | PASS | A customer reaching an administrator route is reported as broken function level authorization | 1 file(s) |
| `SECD-003` | PASS | A read-only account performing a write is reported as privilege escalation | 1 file(s) |
| `SECD-004` | PASS | Protected data served to an unauthenticated caller is reported as missing authorization | 1 file(s) |
| `SECD-005` | PASS | A bearer token the application never issued being accepted is reported | 1 file(s) |
| `SECD-006` | PASS | A sign-in endpoint that distinguishes an unknown account from a wrong password is reported | 1 file(s) |
| `SECD-007` | PASS | Repeated failed sign-ins that are never throttled are reported, from a bounded probe | 1 file(s) |
| `SECD-008` | PASS | A token that still authenticates after sign-out is reported | 1 file(s) |
| `SECD-009` | PASS | A session lifetime far above the threshold is reported, as declared rather than witnessed | 1 file(s) |
| `SECD-010` | PASS | A password-reset token accepted twice is reported | 1 file(s) |
| `SECD-011` | PASS | A caller setting a privileged field on their own object is reported | 1 file(s) |
| `SECD-012` | PASS | A field accepting any type, an empty value and an oversized value is reported | 1 file(s) |
| `SECD-013` | PASS | An unauthenticated DELETE succeeding is reported, against an object the check created | 1 file(s) |
| `SECD-014` | PASS | An endpoint with no threshold below fifteen requests is reported, from a bounded probe | 1 file(s) |
| `SECD-015` | PASS | Password hashes and tokens in a response are reported, by field name and never by value | 1 file(s) |
| `SECD-016` | PASS | Input reflected unencoded into an HTML response is reported as reflected XSS | 1 file(s) |
| `SECD-017` | PASS | A marker stored once and rendered unencoded on a later read is reported as stored XSS | 1 file(s) |
| `SECD-018` | PASS | A parameter concatenated into a query is reported, by error signature and widened result set | 1 file(s) |
| `SECD-019` | PASS | An operator object accepted where a string belongs is reported | 1 file(s) |
| `SECD-020` | PASS | A value reaching a shell is reported from one metacharacter, with nothing executed | 1 file(s) |
| `SECD-021` | PASS | A parameter evaluated as a template is reported, against a measured baseline | 1 file(s) |
| `SECD-022` | PASS | A state-changing request succeeding with no anti-CSRF token is reported | 1 file(s) |
| `SECD-023` | PASS | A cross-origin state-changing request being accepted is reported | 1 file(s) |
| `SECD-024` | PASS | An executable extension with a mismatched content type being accepted is reported | 1 file(s) |
| `SECD-025` | PASS | A declared size far above the limit being accepted is reported, as declared not transferred | 1 file(s) |
| `SECD-026` | PASS | A filename stored with its relative path intact is reported | 1 file(s) |
| `SECD-027` | PASS | A redirect to an arbitrary host is reported, with the Location read and never followed | 1 file(s) |
| `SECD-028` | PASS | An unvalidated fetch destination is reported, without probing cloud metadata | 1 file(s) |
| `SECD-029` | PASS | A missing Content-Security-Policy on an HTML response is reported | 1 file(s) |
| `SECD-030` | PASS | A session cookie with no HttpOnly, Secure or SameSite is reported | 1 file(s) |
| `SECD-031` | PASS | An arbitrary origin reflected while credentials are allowed is reported — both together | 1 file(s) |
| `SECD-032` | PASS | A directory index is reported | 1 file(s) |
| `SECD-033` | PASS | A served JavaScript source map is reported | 1 file(s) |
| `SECD-034` | PASS | A stack trace naming source paths, host and framework version is reported | 1 file(s) |
| `SECE-001` | PASS | A finding with no exchange is refused rather than recorded | 1 file(s) |
| `SECE-002` | PASS | Secrets are removed from sanitized evidence and non-secrets survive it | 1 file(s) |
| `SECE-003` | PASS | Blocked requests are recorded, so coverage can be read from what a scan did not do | 1 file(s) |
| `SECE-004` | PASS | Evidence is written in both raw and sanitized form, and hashed | 1 file(s) |
| `SECF-001` | PASS | The passive profile permits a passive probe | 1 file(s) |
| `SECF-002` | PASS | The passive profile refuses a active probe | 1 file(s) |
| `SECF-003` | PASS | The passive profile refuses a state-changing probe | 1 file(s) |
| `SECF-004` | PASS | The passive profile refuses a destructive probe | 1 file(s) |
| `SECF-005` | PASS | The standard profile permits a passive probe | 1 file(s) |
| `SECF-006` | PASS | The standard profile permits a active probe | 1 file(s) |
| `SECF-007` | PASS | The standard profile permits a state-changing probe | 1 file(s) |
| `SECF-008` | PASS | The standard profile refuses a destructive probe | 1 file(s) |
| `SECF-009` | PASS | The regression profile permits a active probe | 1 file(s) |
| `SECF-010` | PASS | The regression profile refuses a destructive probe | 1 file(s) |
| `SECF-011` | PASS | The deep profile permits a state-changing probe | 1 file(s) |
| `SECF-012` | PASS | The deep profile permits a destructive probe | 1 file(s) |
| `SECG-001` | PASS | The scope guard refuses no scope at all | 1 file(s) |
| `SECG-002` | PASS | The scope guard refuses scope disabled | 1 file(s) |
| `SECG-003` | PASS | The scope guard refuses no written authorization | 1 file(s) |
| `SECG-004` | PASS | The scope guard refuses empty domain allowlist | 1 file(s) |
| `SECG-005` | PASS | The scope guard refuses a host nobody authorized | 1 file(s) |
| `SECG-006` | PASS | The scope guard refuses cloud metadata, despite an allowlist that names it | 1 file(s) |
| `SECG-007` | PASS | The scope guard refuses GCP metadata by name | 1 file(s) |
| `SECG-008` | PASS | The scope guard refuses a non-http scheme | 1 file(s) |
| `SECG-009` | PASS | The scope guard refuses a blocked path | 1 file(s) |
| `SECG-010` | PASS | The scope guard refuses a path outside the allowlist | 1 file(s) |
| `SECG-011` | PASS | The scope guard refuses active testing when the scope permits passive only | 1 file(s) |
| `SECG-012` | PASS | The scope guard refuses a DELETE under an ordinary scope | 1 file(s) |
| `SECG-013` | PASS | The scope guard refuses a POST declared passive | 1 file(s) |
| `SECG-014` | PASS | The scope guard refuses the passive profile asked for an active probe | 1 file(s) |
| `SECG-015` | PASS | The scope guard refuses an account without permission for active scans | 1 file(s) |
| `SECG-016` | PASS | The scope guard refuses production, unauthorized | 1 file(s) |
| `SECG-017` | PASS | The scope guard refuses production, allowed by the scope but not authorized for this run | 1 file(s) |
| `SECG-018` | PASS | The scope guard refuses a different environment from the one authorized | 1 file(s) |
| `SECG-019` | PASS | The scope guard refuses over the rate limit | 1 file(s) |
| `SECG-020` | PASS | The scope guard refuses over the concurrency limit | 1 file(s) |
| `SECG-021` | PASS | The scope guard refuses past the scan duration | 1 file(s) |
| `SECG-022` | PASS | The scope guard refuses a URL that is not absolute | 1 file(s) |
| `SECG-023` | PASS | The scope guard refuses no HTTP method | 1 file(s) |
| `SECG-024` | PASS | The scope guard allows the scan it was written to allow | 1 file(s) |
| `SECM-001` | PASS | The bola finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-002` | PASS | The vertical finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-003` | PASS | The readonly-write finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-004` | PASS | The missing-authz finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-005` | PASS | The unverified-token finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-006` | PASS | The enumeration finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-007` | PASS | The lockout finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-008` | PASS | The session-logout finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-009` | PASS | The session-lifetime finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-010` | PASS | The reset-reuse finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-011` | PASS | The mass-assignment finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-012` | PASS | The input-validation finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-013` | PASS | The unsafe-method finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-014` | PASS | The rate-limit finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-015` | PASS | The excessive-data finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-016` | PASS | The reflected-xss finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-017` | PASS | The stored-xss finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-018` | PASS | The sql-injection finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-019` | PASS | The nosql-injection finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-020` | PASS | The command-injection finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-021` | PASS | The template-injection finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-022` | PASS | The csrf-token finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-023` | PASS | The origin-validation finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-024` | PASS | The upload-type finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-025` | PASS | The upload-size finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-026` | PASS | The upload-traversal finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-027` | PASS | The open-redirect finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-028` | PASS | The ssrf finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-029` | PASS | The no-csp finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-030` | PASS | The weak-cookie finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-031` | PASS | The reflected-cors finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-032` | PASS | The directory-listing finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-033` | PASS | The source-map finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECM-034` | PASS | The verbose-error finding carries the CWE, OWASP category and severity it should | 1 file(s) |
| `SECN-001` | **NOT_VERIFIED** | Security scanning against a production environment | 0 file(s) |
| `SECN-002` | **NOT_VERIFIED** | Browser-driven DOM XSS detection | 0 file(s) |
| `SECN-003` | **NOT_VERIFIED** | Detection rate against an application AIRA has not seen | 0 file(s) |
| `SECP-001` | PASS | The bola check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-002` | PASS | The vertical check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-003` | PASS | The readonly-write check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-004` | PASS | The missing-authz check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-005` | PASS | The unverified-token check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-006` | PASS | The enumeration check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-007` | PASS | The lockout check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-008` | PASS | The session-logout check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-009` | PASS | The session-lifetime check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-010` | PASS | The reset-reuse check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-011` | PASS | The mass-assignment check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-012` | PASS | The input-validation check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-013` | PASS | The unsafe-method check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-014` | PASS | The rate-limit check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-015` | PASS | The excessive-data check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-016` | PASS | The reflected-xss check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-017` | PASS | The stored-xss check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-018` | PASS | The sql-injection check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-019` | PASS | The nosql-injection check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-020` | PASS | The command-injection check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-021` | PASS | The template-injection check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-022` | PASS | The csrf-token check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-023` | PASS | The origin-validation check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-024` | PASS | The upload-type check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-025` | PASS | The upload-size check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-026` | PASS | The upload-traversal check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-027` | PASS | The open-redirect check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-028` | PASS | The ssrf check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-029` | PASS | The no-csp check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-030` | PASS | The weak-cookie check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-031` | PASS | The reflected-cors check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-032` | PASS | The directory-listing check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-033` | PASS | The source-map check reports nothing once the flaw is corrected | 1 file(s) |
| `SECP-034` | PASS | The verbose-error check reports nothing once the flaw is corrected | 1 file(s) |
| `SECPL-001` | PASS | An application with no security scope returns 404, not an empty permissive scope | 1 file(s) |
| `SECPL-002` | PASS | A scope cannot be enabled without a written authorization | 1 file(s) |
| `SECPL-003` | PASS | A scope cannot be enabled with an empty domain allowlist | 1 file(s) |
| `SECPL-004` | PASS | Destructive testing and production can never be authorized together | 1 file(s) |
| `SECPL-005` | PASS | A valid authorization is stored, stamped with who gave it and when | 1 file(s) |
| `SECPL-006` | PASS | A finding with no evidence is refused rather than stored | 1 file(s) |
| `SECPL-007` | PASS | A scan is recorded with its findings, and the first sighting is Potential, not Confirmed | 1 file(s) |
| `SECPL-008` | PASS | The same flaw found again updates its row rather than arriving as a new finding | 2 file(s) |
| `SECPL-009` | PASS | A false positive with no justification is refused | 1 file(s) |
| `SECPL-010` | PASS | A justification too short to be one is refused | 1 file(s) |
| `SECPL-011` | PASS | A properly justified decision is accepted and recorded against the person who made it | 2 file(s) |
| `SECPL-012` | PASS | A resolved finding detected again becomes a regression, and its disposition does not survive | 1 file(s) |
| `SECPL-013` | PASS | A regression makes the stored scan's gate decision FAIL | 1 file(s) |
| `SECPL-014` | PASS | A scan cannot be recorded against an application nobody has authorized | 1 file(s) |
| `SECPL-015` | PASS | Another tenant cannot read this tenant's security findings | 1 file(s) |
| `SECPL-016` | PASS | The platform's gate and the JavaScript mirror produce the same decision and the same words | 1 file(s) |
| `SECPL-017` | PASS | A trend carries the coverage each point was measured at | 1 file(s) |
| `SECPL-018` | PASS | A scan that covered materially less than the one before it is flagged as not comparable | 1 file(s) |
| `SECPL-019` | PASS | An application with no scans is described as untested, not as clean | 1 file(s) |
| `SECPL-020` | PASS | A finding a scan could not reproduce goes to NeedsReview, and is never resolved on absence | 1 file(s) |
| `SECPL-021` | PASS | A finding reproduced after a scan missed it becomes Confirmed and loses the stale note | 1 file(s) |
| `SECPL-022` | PASS | An undiscovered application has no attack surface, and says that is about discovery | 1 file(s) |
| `SECPL-023` | PASS | The first caveat on any attack surface is that it is what discovery walked | 1 file(s) |
| `SECPL-024` | PASS | A change matching no discovered surface selects nothing and refuses to imply safety | 1 file(s) |
| `SECPL-025` | PASS | A change-impact result carries the caveats, so a narrowed run cannot be read as full coverage | 1 file(s) |
| `SECPL-026` | PASS | A release with no security scan is reported as NOT SECURITY TESTED, never omitted | 1 file(s) |
| `SECPL-027` | PASS | The engine and the platform name every security check identically | 1 file(s) |
| `SECPL-028` | PASS | A new Critical finding and a regression each notify, and neither message carries evidence | 1 file(s) |
| `SECPL-029` | PASS | A Critical resting on one unreproduced indicator does not interrupt anybody | 1 file(s) |
| `SECPL-030` | PASS | The main dashboard carries security, and names what has never been scanned | 1 file(s) |
| `SECPL-031` | PASS | A project nobody has scanned gets a security section saying so, not no section | 1 file(s) |
| `SECQ-001` | PASS | A scan that did not run is REVIEW, never a pass | 1 file(s) |
| `SECQ-002` | PASS | Two real findings from a real scan block the build | 2 file(s) |
| `SECQ-003` | PASS | A clean scan never claims the application is secure | 1 file(s) |
| `SECQ-004` | PASS | A partial scan does not pass, however clean it was | 1 file(s) |
| `SECQ-005` | PASS | A scan whose scope refused most of its requests does not pass | 1 file(s) |
| `SECQ-006` | PASS | A suppression with no written justification is counted as open and fails the build | 1 file(s) |
| `SECQ-007` | PASS | A regression fails at any severity | 1 file(s) |
| `SECQ-008` | PASS | A single unreproduced indicator goes to review rather than stopping the release | 1 file(s) |
| `SECQ-009` | PASS | A finding with no evidence is neither failed nor dismissed | 1 file(s) |
| `SECQ-010` | PASS | Untested areas appear in the summary of a clean result | 1 file(s) |
| `SECQ-011` | PASS | The gate can pass — a clean scan with full coverage is a PASS, not a REVIEW | 1 file(s) |
| `SECR-001` | PASS | The measured detection and false-positive rates are recorded, not claimed | 1 file(s) |
| `SECS-001` | PASS | A collection that returns only the caller's own objects produces no BOLA finding | 1 file(s) |
| `SECS-002` | PASS | An object endpoint that enforces ownership produces no BOLA finding | 1 file(s) |
| `SECS-003` | PASS | HTML-escaped reflection produces no XSS finding — reflection alone is not XSS | 1 file(s) |
| `SECS-004` | PASS | Reflection into a JSON body produces no XSS finding — it is not an HTML context | 1 file(s) |
| `SECS-005` | PASS | A page with every header set produces no header finding | 1 file(s) |
| `SECS-006` | PASS | A fully attributed session cookie produces no cookie finding | 1 file(s) |
| `SECS-007` | PASS | A wildcard origin with no credentials on public data produces no CORS finding | 1 file(s) |
| `SECS-008` | PASS | An endpoint that answers identically for a known and an unknown account produces no enumeration finding | 1 file(s) |
| `SECS-009` | PASS | A fetch endpoint that accepts only its own origin produces no SSRF finding | 1 file(s) |
| `SECT-001` | PASS | Triage refuses a false positive with no justification | 1 file(s) |
| `SECT-002` | PASS | Triage refuses a false positive with no named decision-maker | 1 file(s) |
| `SECT-003` | PASS | Triage refuses a justification too short to be one | 1 file(s) |
| `SECT-004` | PASS | Triage refuses an accepted risk with no justification | 1 file(s) |
| `SECT-005` | PASS | Triage refuses an unknown status | 1 file(s) |
| `SECT-006` | PASS | A properly justified decision is accepted and appended to the history, never overwriting it | 1 file(s) |
| `SECT-007` | PASS | A false positive suppresses that finding and not the same class elsewhere | 1 file(s) |
| `SECT-008` | PASS | Self-healing cannot mark a security finding resolved | 1 file(s) |
| `SECX-001` | PASS | DOM-based XSS is reported as not tested by a response-only scan, never as absent | 1 file(s) |

---

Generated from `verification/reports/golden-results.jsonl` for run `SEC-2026-09-24T06-42-53Z`. Every figure is derived from a recorded execution; nothing in this report is asserted.
