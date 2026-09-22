# Release quality

A run answers "is it broken now". A release decision needs "what changed".

They are different questions, and conflating them is expensive in both directions. Twelve
failing tests are not a reason to stop a release if the same twelve failed last week and
somebody already knows why — block on those and the gate gets switched off within a month.
One test that used to pass *is* a reason, and it is invisible in a summary that just says
"13 failed".

```bash
aira release compare --run <id>                       # against the run before it
aira release compare --run <id> --fail-on-new-failures
aira release quality --build v2.4.1
```

## What a comparison says

Every test in either run falls into one of six:

| | |
| --- | --- |
| **Newly failing** | Passed before, fails now. The list a release decision is made from. |
| **Fixed** | Failed before, passes now. Evidence that a fix worked. |
| **Still failing** | Failing in both. Known. Context, not news. |
| **Still passing** | Passing in both. |
| **Added** | Ran this time, did not run before. |
| **Removed** | Ran before, did not run this time. |

Comparison is **by test case, not by position**. Runs select different tests — that is the
point of `aira regression` — and a positional diff would report everything as moved the
moment a selection changed.

**Removed is not collapsed.** A test that quietly stopped being selected is coverage
nobody decided to drop, and it is invisible unless something says so.

## Gating a pipeline on regressions

```bash
aira release compare --run "$RUN_ID" --fail-on-new-failures --markdown "$ARTIFACTS/changed.md"
```

Exit 1 only when a test that used to pass now fails. A failure somebody already knows about
does not stop the build, so the gate keeps meaning something.

This complements the quality gate rather than replacing it. The gate enforces a standard
("95% must pass"); this enforces a direction ("nothing got worse"). A team that cannot yet
meet the standard can still hold the line with this one.

## A release, not a run

A release is usually tested by several runs across several days — a smoke run on deploy, a
full regression that night, a re-run after a fix. `aira release quality --build v2.4.1`
treats all of them as one thing to decide about, keyed on the build reference a pipeline
passes with `--app-build`.

It reports the union of what was covered, what is failing in the most recent run, and one
list that neither headline covers:

**Tests that both passed and failed within the same build.** Which result you get depends
on which run you look at. Shipping on the strength of whichever run happened to be last is
how an intermittent defect reaches production, and neither "12 passed" nor "1 failed"
mentions it.

It also compares against the previous build, so the report answers "what changed in this
release" and not only "what is broken".

## When there is nothing to compare against

Refused, with an explanation:

```
400  There is no earlier finished run in this project to compare against.
     A first run has nothing to have changed from.
```

Reporting zeros would be worse than useless. "0 newly failing" reads as an assurance that
nothing regressed, and the truth is that nobody looked. The same applies to a build with no
earlier build: the report says so in its summary rather than omitting the section, because
a missing comparison section reads as "nothing changed".

## Verification

```bash
node verification/golden-tests/run.mjs --suite release
```

Seven tests (REL-001…REL-007) against real pairs of runs whose results genuinely differ —
made to differ by **injecting a fault into the deployment between them**, not by editing
the tests. A comparison that only ever sees identical runs proves nothing about the thing
it exists to detect.

REL-003 and REL-007 are the pair that matter: a failure present in both runs must be
`stillFailing` and must not fire the gate, or `--fail-on-new-failures` is just
`--fail-on-failures` with extra steps.

Building this found a defect in the CLI before it was committed: the API emits enum values
and dictionary keys in camelCase, and the CLI read them as PascalCase. `counts.NewlyFailing`
on a camelCase payload is `undefined`, `undefined > 0` is false — so the gate reported no
regressions and every headline read "nothing changed". The only symptom was silence, which
is why REL-007 checks the exit code rather than the output.
