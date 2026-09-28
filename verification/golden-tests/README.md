# The golden test suite

A hundred-odd tests that try to prove QA NXT works, and are built so that they can fail.

Every one of them drives the product from the outside — its HTTP API, its worker, a real
browser, a real application — and compares what happened against something written down in
advance. None of them calls an internal method, reads a private field or asserts on a mock.
If the platform is broken these tests go red; that is the only property that makes a green
result worth anything.

## Running them

```bash
./scripts/run-golden-tests --all              # everything, then the reports
./scripts/run-golden-tests --suite discovery  # one suite
node verification/golden-tests/run.mjs --list # what suites exist
```

Both the platform and the test lab must be running:

```bash
scripts/services-ctl.sh start        # API, worker, console, Postgres, Redis
test-lab/scripts/lab-ctl.sh start    # the six applications under test
```

The runner refuses to start if either is missing, naming what it could not reach. A suite
that cannot run is never reported as one that passed.

## What a golden test is

A declaration and a function:

```js
await golden({
  id: 'HEAL-N03',
  objective: 'A removed control is never healed to a different control',
  preconditions: ['The self-healing app is running', 'FAULT_CONTROL_REMOVED is on'],
  input: { fault: 'removed', policy: 'auto', threshold: 75 },
  expected: 'The run fails and the browser never reaches /welcome',
  evidence: ['run.json', 'healing-events.json'],
  severity: 'critical',
  run: async () => { /* … */ return { pass, detail, metrics, evidence }; }
});
```

The harness enforces what is easy to fake:

| Rule | Why |
| --- | --- |
| A test that throws is a **failure**, never a skip | An error is evidence of something, and silence is the most common way a suite lies. |
| Declared evidence that never appears **fails the test** | A result nobody else can check is not a result. |
| Evidence is written to `evidence/<TEST-ID>/<RUN-ID>/` | Runs never overwrite each other, so a regression can be compared with the run before it. |
| Every artifact is hashed (SHA-256) and the hash stored beside the verdict | The evidence index can detect an artifact that was altered after the fact. |
| A capability that cannot be exercised here is recorded `NOT_VERIFIED` | Distinct from PASS and from FAIL, and it never counts towards a passing gate. |

`PASS` means all four of: the action executed, the expected behaviour was observed, the
assertion held, and the evidence exists.

## The suites

| Suite | IDs | Count | What it establishes |
| --- | --- | --- | --- |
| Discovery | `DISC-` | 15 | A real single-page application is crawled into a model, measured for recall and precision against hand-written ground truth. |
| AI test generation | `GEN-` | 16 | A sentence in English becomes tests that execute, reach across the application, and fail when it breaks. |
| Browser execution | `EXEC-` | 20 | Every action and assertion type, on a real browser, with screenshots, traces and logs. |
| Assertions | `ASRT-` | 10 | Each assertion type holds when it should and fails when it should not. |
| Failure detection | `DET-` | 12 | Eleven failure classes on identically shaped pages, plus a control where nothing is broken. |
| Failure analysis | `FA-` | 16 | Classification accuracy measured against the lab's own expectations; an analysis never overturns a verdict. |
| Self-healing | `HEAL-` | 20 | Two heals that should happen, ten refusals that must happen, and the metrics that separate them. |
| Security | `SEC-G` | 11 | Tenant isolation, credential handling, prompt injection, target policy — against local applications only. |
| Reliability | `REL-` | 7 | Ten identical runs, twenty against a genuinely unstable application, ten started at once. |
| Performance baseline | `PERF-` | 3 | Discovery, a twelve-step run and one generation, timed several times each. Measurements, not targets: no gate depends on them. |

The lab itself is checked before it is trusted: `node test-lab/scripts/lab-selftest.mjs`
(34 checks — every application serves, every declared fault sets and resets, an unknown
fault id is refused, the seeded data is unchanged, and the ground truth still matches).

`HEAL-N01`…`HEAL-N10` are the negative self-healing tests. Each one requires **two**
things: the run fails, *and* the browser never reaches the signed-in page. A run that fails
for the wrong reason — or one that "fails" while the healer clicked something it should not
have — does not satisfy both.

## The metric that matters

`HEAL-M01` computes the **false-healing rate**: incorrect heals ÷ healing opportunities.
The target is zero, and the report never folds it into a success rate, because a healer
that repairs nine locators correctly and silently clicks the wrong button once is worse
than one that repairs nothing. `HEAL-M02` reports the confidence margin between the lowest
score the healer accepted and the highest it gave a wrong target: a positive margin is what
makes the threshold meaningful rather than lucky.

## Output

| File | What it is |
| --- | --- |
| `verification/reports/golden-results.jsonl` | One line per test per run, appended, never rewritten. |
| `verification/reports/golden-test-report.json` | The last run: totals, metrics, gates, every verdict. |
| `verification/reports/golden-test-report.html` | The same, self-contained, no external resources. |
| `verification/reports/GOLDEN-TEST-REPORT.md` | The same, readable in a terminal or a diff. |
| `verification/reports/EVIDENCE-INDEX.md` | Every artifact, its size and its hash. |
| `verification/reports/QA-NXT-CERTIFICATION.md` | Ten questions, each answered only by tests that ran. |
| `verification/evidence/<TEST-ID>/<RUN-ID>/` | The artifacts themselves, plus `metadata.json`. |

The console reads `golden-test-report.json` and renders it at **Verification** — and
re-checks the gates in the browser, so a report claiming to be green while a gate is red
still renders red.

## When a golden test fails

Do not edit the test. The process is written down in `docs/test-lab-plan.md` and followed
in `verification/bugs/`: reproduce it twice, write the bug up with steps, expected and
actual, fix the product, re-run the reproduction, re-run the suite, and only then close it.
Eleven defects found this way are recorded as `BUG-0007` to `BUG-0017`; each directory
contains a script that reproduces the original failure against an unfixed build.

One of them, `BUG-0016`, was a test in this suite passing for the wrong reason. It is
written up with the same detail as the product defects, because a verification suite that
cannot be wrong is not a verification suite.
