# Security testing in QA NXT

QA NXT can test an application for security flaws in the same way it tests it for functional
ones: deterministic checks, evidence for every claim, and a verdict a pipeline can act on.

Before anything else, the two sentences that shape everything in this directory:

> **QA NXT never tests an application nobody has authorized it to test.** Authorization is a
> written statement by a named person against a named application and environment. The
> absence of a restriction is not permission, and every default in the system refuses.

> **QA NXT never reports that an application is secure.** It reports what was tested, what was
> found, and what was not reached. No scan can support the stronger claim, and a tool that
> makes it teaches its readers to stop looking.

## The documents

| | |
| --- | --- |
| [scope-and-authorization.md](scope-and-authorization.md) | What a security scope is, how authorization is recorded, and every rung of the guard that enforces it |
| [what-qanxt-will-not-do.md](what-qanxt-will-not-do.md) | The things security testing refuses, and why each refusal exists |
| [checks.md](checks.md) | Every check, what it probes, and what it needs to see before it reports |
| [findings.md](findings.md) | The finding model: severity, confidence, CWE and OWASP mapping |
| [evidence.md](evidence.md) | What is recorded for each finding, and how secrets stay out of it |
| [false-positives.md](false-positives.md) | Why precision matters more than recall here, and how a finding is set aside |
| [security-gate.md](security-gate.md) | What stops a build, what a clean result may say, and why "not scanned" is not a pass |
| [regression.md](regression.md) | Comparing scans, finding identity, and why absence never means fixed |
| [attack-surface.md](attack-surface.md) | What discovery found that is worth testing, which checks a change calls for, and security in a release decision |
| [running-a-scan.md](running-a-scan.md) | Profiles, the CLI, and CI/CD |
| [the-security-lab.md](the-security-lab.md) | The seven deliberately vulnerable applications and their ground truth |
| [constraints.md](constraints.md) | The eighteen rules this was built against, each mapped to the tests that hold it |
| [verification.md](verification.md) | How the security capability is verified, and what is not verified |
| [limitations.md](limitations.md) | What QA NXT's security testing cannot do, stated plainly |

## The shortest possible tour

1. Somebody with `security:authorize` writes a **security scope** for an application: which
   hosts, which paths, which risk levels, which environment, and a note saying they authorize
   it. Nothing can be scanned without one.
2. A scan runs under a **profile** — passive, standard, deep or regression — which bounds what
   it will attempt regardless of what the scope permits.
3. Every request goes through the **scope guard**. There is no other way to issue one.
4. Checks produce **findings**, each carrying the request and response that establish it. A
   finding with no exchange is refused rather than recorded.
5. The **security gate** turns findings and coverage into PASS, REVIEW or FAIL. A build that
   was not scanned is REVIEW, never PASS.
6. The next scan is compared to the last. A finding that has come back is a **regression** and
   fails at any severity.

## Verifying it

```bash
./scripts/verify-security
```

Starts the security lab, audits it against its ground truth, runs the unit tests and the
security golden suites, and produces `verification/reports/SECURITY-VERIFICATION-REPORT.md`
and `SECURITY-TRACEABILITY.md`.

What that script proves is that QA NXT's security *testing* works. It is not a statement about
the security of anything.
