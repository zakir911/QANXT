# How the security capability is verified

Nothing here is verified by reading it. Every claim below is tied to a test that executed, and
the report is generated from the execution ledger rather than written by hand.

## The shape of the evidence

| Family | Count | What it establishes |
| --- | --- | --- |
| `SECD-*` | 34 | With the flaw on **alone**, the check reports it |
| `SECP-*` | 34 | With the flaw off, the check reports nothing |
| `SECM-*` | 34 | CWE, OWASP category and severity band match the ground truth, and the severity recomputes from the stored factors |
| `SECS-*` | 9 | The endpoints the ground truth calls correct stay quiet, with the lab fully vulnerable |
| `SECG-*` | 24 | Every rung of the scope guard refuses what it should — and one case it must allow |
| `SECE-*` | 4 | Evidence-free findings refused, secrets redacted without eating the evidence, blocked requests recorded |
| `SECF-*` | 12 | The profile × risk matrix |
| `SECQ-*` | 11 | The gate: what stops a build, what a clean result may say, and that it can pass |
| `SECB-*` | 5 | Regression comparison and finding identity |
| `SECT-*` | 8 | The triage workflow's refusals |
| `SECX-*` | 1 | DOM XSS reported as untestable by a response-only scan, never as absent |
| `SECR-*` | 1 | The measured detection and false-positive rates |
| `SEC-G*` | 11 | AIRA's own tenancy, credentials, target policy and headers |

Plus 82 C# unit tests over the pure functions where the controls actually live: 38 on the
scope guard, 13 on the severity model, 19 on the security gate and 12 on the RBAC matrix.
`./scripts/verify-security` runs 165 unit tests in total under the `Security` filter, which
also covers the secret masker, the target-URL guard and the error-code vocabulary.

## Three results that are deliberately NOT VERIFIED

Recorded in the ledger rather than omitted, so they survive into every report:

- **`SECN-001`** — production scanning's permitted path. Only its refusal is exercised.
- **`SECN-002`** — browser-driven DOM XSS, from the scanning suite. Implemented, but in the
  worker rather than the engine, so this suite cannot exercise it: `SECW-013` and `SECW-014`
  measure its detection and precision against the same lab.
- **`SECN-003`** — detection against an application AIRA has not seen. Not measurable in a lab
  whose flaws were written alongside the checks.

A test that leaves no trace when it does not run is indistinguishable from one that never
existed, which is why `notVerified` writes a record rather than printing a warning.

## The eighteen constraints

`docs/security/constraints.md` maps each rule the brief ends with to the requirement that
states it and the tests that hold it. `verify-security` checks that map on every run and fails
if a constraint names no requirement, names a requirement that does not exist, or names a test
that did not run or did not pass.

Checked rather than maintained, for the same reason as the traceability matrix: a table like
that is true the day it is written and rots quietly afterwards, and this one carries the most
load-bearing claim in the security documentation.

Two constraints are held by an absent code path rather than a check — self-healing has no
route to a security finding, and no model output becomes a finding — and the map says which and
why rather than citing a test that does not exist.

## Traceability

`verification/security-requirements.json` holds 50 requirements. Each names the tests that
verify it, and `traceability.mjs` checks the file against what actually ran. Four ways it can
be wrong, all of them failures:

- a requirement naming no test;
- a requirement naming a test id that does not exist;
- a requirement whose tests did not all pass in the run being reported;
- a test that exists and no requirement claims (reported, not failed — a test can legitimately
  cover a defect no requirement anticipated).

A matrix maintained by hand agrees with reality on the day it is written and never again.

## Defects found by running it

Every one of these was found by executing something, not by reading it. They are listed
because a verification document that reports only successes is describing intentions.

| What | Why it mattered |
| --- | --- |
| `/__faults/reset` quietly repaired the planted vulnerabilities | Every detection test would have been meeting a correct application |
| The severity scale maxed at 19 while the bands were calibrated to 13 | BOLA came out Critical instead of High |
| The engine crashed on `ECONNREFUSED` | A scan dying on the first unreachable endpoint is indistinguishable from one that found nothing |
| Rate pacing ran *after* the scope guard | A 15-request check came back as 15 refusals, which in a report looks like an endpoint that was never reached |
| `labScope({...})` silently ignored its overrides | An unused first parameter swallowed them; the caller got a refusal it could not account for |
| Enumeration compared response bodies byte for byte | Would have flagged any application returning a nonce or echoing the username |
| The lab's password-reset endpoint enumerated accounts by response shape | While its own ground truth called it non-enumerating |
| A missing origin check was filed under OWASP A05 | It is A01 — the same failure as the missing CSRF token beside it |
| A stack trace was reported as generic sensitive data | A report could not tell "returns a password hash" from "returns a stack trace" |
| A cookie missing `HttpOnly` scored High | The model had not been told that reading it needs an XSS the attacker does not have yet |
| `requireEnvironment` demanded the platform API for suites that never call it | A security scan could not run because a database it does not use was down |
| The gate's clean summary omitted suppressed findings | "No findings were detected" read very differently from "one was detected and set aside" |

## What the report does and does not say

`SECURITY-VERIFICATION-REPORT.md` opens with a disclaimer that is not decoration:

> This report describes AIRA's security *testing*. It is not a security assessment of any
> application. It does not say that AIRA is secure, that the lab is secure, or that any
> application AIRA scans is secure.

The detection rate in it — 34 of 34, 0 false positives — describes a lab whose flaws were
written alongside the checks that find them. That is the right way to test a detector and the
wrong way to estimate how it will do against an application nobody has seen. The report says
so, twice.
