# Running a scan

## Profiles

A profile bounds what a scan will attempt, regardless of what the scope permits. It is the
promise made to whoever approved the scan about what it was going to do.

| Profile | Passive | Active | State-changing | Destructive |
| --- | --- | --- | --- | --- |
| `passive` | yes | — | — | — |
| `standard` | yes | yes | yes | — |
| `regression` | yes | yes | yes | — |
| `deep` | yes | yes | yes | yes |
| `custom` | whatever the caller's policy names | | | |

The scope and the profile are both consulted, and both must permit. A `deep` profile against a
scope with `AllowDestructiveTesting: false` still refuses destructive requests.

`regression` runs only the checks derived from findings already confirmed on this application
— the fast one to put in a pipeline once a baseline exists.

The full matrix is verified by `SECF-001` through `SECF-012`.

## What a pipeline does with the result

The security gate produces PASS, REVIEW or FAIL. The mapping a pipeline should use:

| Outcome | Exit | What it means |
| --- | --- | --- |
| PASS | 0 | Scanned, adequately covered, nothing open above the thresholds |
| REVIEW | 0 with a marker | A person has to look. **Not** a silent pass |
| FAIL | non-zero | Stop |

REVIEW exiting zero is deliberate: a build that needs a person to look at a low-confidence
finding has not failed, and a pipeline that wants to stop on REVIEW keys off the outcome
rather than the exit code. What must never happen is REVIEW being reported as PASS, and the
summary text makes that impossible to do by accident — a not-scanned build says `NOT SCANNED`
in the first two words.

## In CI

The pattern that works is two jobs at different cadences:

**On every pull request** — the `regression` profile against the QA environment, with the
default policy. Fast, and it catches the thing that matters most: a flaw that was fixed coming
back.

**Nightly or weekly** — the `standard` profile, full check set. Slower, and it is where new
findings come from.

**Never against production** unless somebody with `security:production` has authorized that
specific run. Production security testing is disabled by default and three separate conditions
must hold; see [scope-and-authorization.md](scope-and-authorization.md).

## Verifying the capability itself

```bash
./scripts/verify-security                  # everything, including AIRA's own security
./scripts/verify-security --no-platform    # the lab only; no database or API needed
```

It starts the lab, audits it against its ground truth, runs the security unit tests and the
security golden suites, then produces:

- `verification/reports/SECURITY-VERIFICATION-REPORT.md`
- `verification/reports/security-verification-report.html`
- `verification/reports/SECURITY-TRACEABILITY.md`

Exits non-zero if any suite failed or any security requirement is unverified.

The `--no-platform` flag exists because the scanning and gate suites drive the scanner
directly against the lab and never call the platform. Requiring a database they do not use in
order to run a security scan was an obstacle rather than a check.
