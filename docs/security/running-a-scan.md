# Running a scan

## Starting one

```bash
aira security scan --application-id <id> --wait
```

or `POST /api/v1/security/scans/start`, which needs `security:scan`.

AIRA queues a job, a worker consumes it and issues the requests, and the worker reports back
what it did. Four things are settled before the job exists, and all four refuse rather than
degrade:

| Refused when | Because |
| --- | --- |
| The application has no enabled scope carrying a written authorization | Nothing may be tested without somebody saying so in writing |
| The scope permits destructive testing and the caller lacks `security:scan:destructive` | Both are required and neither grants the other |
| The environment is production and the caller lacks `security:production` | Production security testing is off by default |
| Discovery has not walked the application | A scan with no targets issues no requests and would still be stored as a scan, which reads as a clean result |

The worker is handed the scope as authorized at that moment. It never looks one up, cannot
widen the one it is given, and the guard inside the engine refuses each out-of-scope request
besides — so both ends fail closed independently.

**A queued scan is not a result.** Until the worker reports, the scan's gate says `NOT SCANNED`
and the CLI exits 7, because "a scan has been queued" and "this build has been security tested"
are different statements and only one of them is true at that point.

`--checks a,b` narrows a run. The full implied set stays the denominator, so a narrowed run
reports as partial coverage and cannot pass the gate on it — narrowing the numerator and the
denominator together would let one check report as complete coverage.

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

## From the command line

```bash
aira security scope     --application-id <id>
aira security scan      --application-id <id> [--checks a,b] [--wait] [--timeout 600]
aira security scans     --application-id <id> [--take 10]
aira security findings  --application-id <id> [--status confirmed]
aira security gate      --scan-id <id>
aira security triage    --finding-id <id> --status falsePositive --reason "<what you checked>"
```

`aira security scan --wait` exits on the gate exactly as `aira security gate` does. Without
`--wait` it exits 7, because the scan it queued has not run: a pipeline step that exited 0 on
"a scan has been queued" would be reporting a build as security-tested at the moment nothing
had been tested. A wait that runs out also exits 7 rather than 0 — a scan nobody finished is a
scan nobody ran.

`aira security gate` is the one a pipeline runs:

| Exit | Meaning |
| --- | --- |
| 0 | PASS |
| 2 | FAIL — the gate blocked |
| 6 | A security policy refused the request |
| 7 | REVIEW — a person has to look |

**Exit 7 is not a pass.** It covers "no scan ran", "the scan covered a fifth of what it was
configured to", "the scope refused most of its requests" and "a low-confidence finding needs a
look". A pipeline that swallows 7 reintroduces exactly the green-build-nobody-scanned failure
the gate exists to prevent, which is why `.github/workflows/aira-security.yml` fails on it
unless `AIRA_SECURITY_ALLOW_REVIEW` is explicitly set.

`aira security triage` refuses a suppression with no reason before the request leaves the
machine, so an operator finds out from the CLI rather than from a 400.

Two smaller things the CLI does on purpose:

- `aira security scans` on an application with no scans says *"That is not a clean result.
  Nothing has been tested."* rather than printing an empty table.
- `aira security findings` with nothing to show says the result *"says nothing about whether
  the application has been scanned, or about what any scan covered"* — because "no findings"
  invites the reader to hear "secure", and the command has no idea whether anything was ever
  run.

## The GitHub Actions workflow

`.github/workflows/aira-security.yml` runs nightly rather than per-push. A security scan
issues real requests against a running environment; running one per commit teaches people to
ignore it.

It uses `AIRA_SECURITY_TOKEN`, separate from the functional `AIRA_TOKEN`. Security findings
are a working description of how to break the application, and the account that reads them
should be one somebody chose for that rather than whichever token was already in the
repository. For this workflow it needs `security:read` and nothing more.

If no scan has ever been recorded for the application, the job **fails** rather than skipping.
