# BUG-0035 — Two suites shared test ids, and a certification gate went green on the wrong suite

| | |
| --- | --- |
| **ID** | BUG-0035 |
| **Title** | The release-quality suite (CQ-9d) reused `REL-001`…`REL-007`, already owned by the reliability suite; the Reliability certification gate then reported **PASS** in a run containing no reliability test |
| **Severity** | **HIGH** |
| **Found by** | CQ-10: reading the gate line of the first full `verify-continuous-quality` run, which showed `Reliability=PASS` for a run whose suite list does not include reliability |
| **Environment** | See `verification/environment.md` |
| **Build** | `72e2987` |
| **Component** | `verification/golden-tests/suites/release.mjs`, `verification/golden-tests/report.mjs`, `verification/golden-tests/harness.mjs` |
| **Reproduction rate** | 3 of 3 |
| **Status** | Fixed and re-verified |

## What happens

```
$ grep -oE "id: '[A-Z]+-[0-9]+'" verification/golden-tests/suites/release.mjs | sort -u | tr '\n' ' '
id: 'REL-001' id: 'REL-002' id: 'REL-003' id: 'REL-004' id: 'REL-005' id: 'REL-006' id: 'REL-007'

$ grep -oE "id: '[A-Z]+-[0-9]+'" verification/golden-tests/suites/reliability.mjs | sort -u | tr '\n' ' '
id: 'REL-001' id: 'REL-002' id: 'REL-003' id: 'REL-004' id: 'REL-005' id: 'REL-006' id: 'REL-007'
```

`REL-001` names two different tests:

```
$ node -e "…filter(testId === 'REL-001')…"
2026-09-21T14-41-46Z | Reliability     | A deterministic test gives the same verdict ten times running
2026-09-22T19-37-03Z | Release quality | A test that passed before and fails now is reported as newly failing
```

## Why it matters

A test id is three things at once, and the collision broke all three.

**It is the certification gate's selector.** `report.mjs` builds gates with
`suiteOf('REL-')`, so the Reliability gate measured whichever suite happened to be in the
run. The first `verify-continuous-quality` run printed:

```
gates: … Security=FAIL Reliability=PASS Failure detection=FAIL
```

Reliability PASS, in a run whose twelve suites do not include reliability. Every other
unmeasured gate correctly showed as not green. This one was green because seven
release-quality tests were standing in for it. **That is a false green on a certification
gate** — the single worst failure mode this verification system can have, and the one the
brief is most explicit about.

**It is the evidence namespace.** Both suites write to
`verification/evidence/REL-001/<RUN_ID>/`. No run has yet contained both suites, so nothing
has actually been overwritten — checked, not assumed:

```
$ node -e "…count runs containing both suites…"
runs containing both suites: 0
```

But `run.mjs --all` runs both, and `scripts/verify-product` calls it. The next full product
verification would have mixed two suites' artifacts into one directory silently.

**It is the traceability key.** `traceability.mjs` keys results by test id, so a requirement
citing `REL-003` for release quality could have been satisfied by a reliability test.

## Root cause

Mine, in CQ-9d. I chose `REL-` for "release" without checking that `REL-` was already
reliability's, and nothing in the harness objected — test ids were validated for presence,
never for uniqueness.

## Fix

Three parts, because the rename alone would only fix today's instance.

1. The release suite's ids are now `RLS-001`…`RLS-007`. Updated in `release.mjs`,
   `verification/continuous-quality-requirements.json` and `docs/release-quality.md`.

2. `harness.mjs` now refuses a duplicate id, naming both suites:

   ```js
   if (seenIds.has(test.id)) {
     throw new Error(
       `Duplicate golden test id ${test.id}: declared in suite "${seenIds.get(test.id)}" and again in `
       + `"${state.suite}". Test ids are the evidence namespace and the certification gates' `
       + 'selector, so they must be unique across every suite.');
   }
   ```

   Verified by executing a two-suite probe that declares `DUP-001` twice:

   ```
   ── Suite A ──
   PASS  DUP-001  o — d
   ── Suite B ──
   GUARD FIRED: Duplicate golden test id DUP-001: declared in suite "Suite A" and again in "Suite B". …
   ```

3. `report.mjs` gates now have three states rather than two — `PASS`, `FAIL` and
   `NOT_MEASURED` — so a gate with no tests in the run can no longer be confused with either
   outcome. This is the same rule the product itself enforces on quality gates (ACC-005,
   API-011: a metric that was not measured is never reported as satisfied); the report had
   been held to a lower standard than the thing it reports on. The overall verdict is
   correspondingly `PASS` / `FAIL` / `INCOMPLETE`, exiting 0, 1 and 3.

## Re-verification

The release suite re-run under the new ids, then the report rebuilt on the corrected
results:

```
7 passed, 0 failed, 0 not verified of 7 golden tests in 21s   (RLS-001…RLS-007)

Golden test report for run CQ10-2026-09-23T02-21-33Z
  109 passed, 0 failed, 0 not verified of 109
  gates: Functional=NOT MEASURED Discovery=NOT MEASURED AI=NOT MEASURED Self-healing=NOT MEASURED
         Security=NOT MEASURED Reliability=NOT MEASURED Failure detection=NOT MEASURED Evidence=PASS
  overall: INCOMPLETE
  7 gate(s) had no tests in this run: … — not measured, not failed.
```

Reliability now reads NOT MEASURED, which is the true statement about this run. The stale
`REL-00x` rows and evidence directories for this run were removed rather than left to be
counted twice.

## The historical record

Two earlier release-quality runs (`2026-09-22T19-31-14Z`, `2026-09-22T19-37-03Z`) had
already written evidence under `REL-00x/`. Leaving it there would have made the reliability
directories contain release artifacts and the result rows point at paths no reader could
interpret, so those fourteen rows and their evidence directories were moved to `RLS-00x`.
Nothing was deleted and no verdict was changed; only the id and the path each record
carries. Re-checked afterwards:

```
distinct executed ids: 239  remaining cross-suite clashes: 0
dangling RLS evidence paths: 0
```

The reliability directories now hold only reliability runs, and the release ones only
release runs.
