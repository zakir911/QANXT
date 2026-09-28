# The security gate

Turns a scan into PASS, REVIEW or FAIL.

Three outcomes rather than two, because "a person has to look at this" is a real answer and
folding it into either of the others loses information a release decision needs.

## The rules

Evaluated in order. Each records whether it was **measured**, because a threshold compared
against a value nobody measured reads as a guarantee and is not one.

| Rule | Outcome when it fails |
| --- | --- |
| A security scan ran | REVIEW — summary reads `NOT SCANNED` |
| Enough of the configured checks executed (≥80%) | REVIEW |
| The scan reached what it was aiming at (≤25% refused) | REVIEW |
| Every suppressed finding carries a justification and a name | **FAIL** |
| Every finding carries evidence | REVIEW |
| No previously resolved finding has reappeared | **FAIL** |
| No new finding at or above `failOnNewAtOrAbove` (default High) | **FAIL** |
| No open finding at or above `failOnExistingAtOrAbove` (default Critical) | **FAIL** |

## The rules that matter are about absence

**A build that was not scanned is not a build that passed.** It is REVIEW, and the summary
says `NOT SCANNED. No security tests were executed for this build, so nothing is known about
its security posture from QA NXT.` This is the single most important line in the file: a gate
that reports green when nothing ran is worse than no gate, because it produces a record saying
the build was checked.

**A partial scan does not pass.** One check out of five finding nothing describes a fifth of
an application.

**A scan whose own scope refused most of its requests does not pass.** The findings describe
the part the scan was allowed to reach.

**A suppression with no justification is counted as open.** Not warned about — counted as
open, and it fails the build. An unexplained suppression is indistinguishable from turning the
check off.

**A finding with no evidence is neither failed nor dismissed.** A claim nobody can check is
not a finding yet. It goes to REVIEW.

## Why a regression fails at any severity

A Low finding that was fixed and has come back means something that was repaired has been
undone. That is a different fact from a Low finding appearing for the first time, and the
severity is not the interesting part.

## Why a low-confidence finding does not fail

A gate that stops a release on one unreproduced indicator gets switched off within a month,
and then nothing is gated at all. New findings at or above the threshold but at Low confidence
go to REVIEW. `SECQ-008`.

## Why an old Critical still fails

"It was already there" is not a reason to ship it. The existing-finding threshold sits above
the new-finding one — Critical rather than High — so a team can carry a known High while it is
being worked, but a Critical stops the build whether it arrived today or last quarter.

## What a clean result may say

```
Within the configured scope and test coverage, no security findings were detected by the
executed QA NXT security tests (5 of 5 configured check(s), 200 request(s) issued). This is not
a statement that the application is secure or that no vulnerabilities exist.
Untested: DOM-based XSS (no browser was available for this scan); cloud metadata (off by default).
```

Three things are load-bearing: the scope qualifier, the explicit disclaimer, and the list of
untested areas. `SECQ-003` and `SECQ-010` assert all three, and assert that the forbidden
phrasings do not appear.

If findings were detected and then suppressed, the summary says so. "No findings were
detected" and "three were detected and a person set them aside" are different sentences, and a
reader deciding whether to ship needs the second.

## Policy

```
failOnNewAtOrAbove              High       new findings at or above this fail
failOnExistingAtOrAbove         Critical   pre-existing findings at or above this fail
failOnRegression                true       a regression fails at any severity
reviewLowConfidenceInsteadOfFailing  true  a single unreproduced indicator goes to review
minimumCheckCoverage            0.8        below this, the result is REVIEW
```

The defaults are the strict ones. Loosening any of them is a decision somebody signs for.

## The gate can pass

`SECQ-011` exists because eleven rules that produce REVIEW or FAIL prove only that the gate
says no to everything. A clean scan with full coverage is a PASS, with every rule satisfied.
