# Change impact and regression selection

Running every test on every commit is safe and slow. Running a subset is fast and, done
carelessly, produces a green pipeline that did not run the test which would have caught the
defect — and nobody finds out until production.

So this is built to fail towards running more rather than fewer, and to explain every
decision it makes. A team that cannot see why a test was skipped has no way to tell a good
selection from a broken one.

- [How it decides](#how-it-decides)
- [Impact rules](#impact-rules)
- [The score](#the-score)
- [When it cannot tell](#when-it-cannot-tell)
- [From the CLI](#from-the-cli)
- [In a pipeline](#in-a-pipeline)
- [Limitations](#limitations)

## How it decides

1. **What changed.** A list of repository-relative paths, from `git diff --name-only` or
   supplied directly.
2. **What those changes affect.** Each path is matched against the project's impact rules;
   paths no rule covers are matched by name against the routes and endpoints discovery has
   observed, and those matches are reported as *inferred* rather than declared.
3. **Which tests reach it.** Each test's routes and API paths are read from its steps — what
   the test does, not what a tag says it does.
4. **A score per test**, with every component named and every contribution explained.
5. **A selection**, plus the tests left out and their scores, so the boundary is visible.

## Impact rules

QA NXT does not know how anybody's source tree is laid out, and guessing is how change impact
analysis becomes a plausible-sounding way to skip the test that would have caught the bug.
So a team says what its files affect:

```bash
POST /api/v1/regression/rules?projectId=…
{
  "pathPattern": "src/pages/accounts/**",
  "kind": "route",
  "value": "/accounts",
  "notes": "The accounts screens."
}
```

| `kind` | `value` | Means |
| --- | --- | --- |
| `route` | `/accounts` | Files matching this pattern affect that page |
| `apiEndpoint` | `/api/accounts/{id}` | …that endpoint, placeholders and all |
| `tag` | `payments` | …the tests carrying that tag |
| `testCase` | `TC-0042` | …that one test. The blunt instrument, for what a pattern cannot express |
| `everything` | — | …everything. For shared code, where narrowing is a guess dressed up as an optimisation |

`notes` is carried into the selection report beside the tests the rule caused to run, so the
reasoning is the team's own words rather than a pattern.

The glob is deliberately small: `*` matches within a segment, `**` crosses them, `?` matches
one character. A pattern language rich enough to surprise someone is a liability in the
thing that decides which tests to skip. A rule saved with a blank pattern is refused —
it would match nothing and be a no-op nobody ever noticed.

### Without rules

QA NXT still matches changed paths against what it has discovered, by name:
`app/screens/payments/PaymentsScreen.tsx` is taken to affect `/payments`. Those mappings are
returned with `isDeclared: false` and a reason ending "Inferred, not declared", and the
result carries a note saying how many there were.

"Probably" is exactly the word a team needs to see next to a decision about which tests to
skip.

## The score

Out of 100, from five components. The weights are ordinary judgements, stated rather than
buried, and **nothing here is learned or tuned**: a selector whose weights drift on its own
cannot be reproduced, and a release decision that cannot be reproduced is not a decision.

| Component | Max | What it measures |
| --- | --- | --- |
| **impact** | 40 | Whether the change reaches this test. The largest, because it is the only component about *this change* rather than about *this test*. A route or endpoint match scores the full 40; a tag match scores 30, because a tag says the team associates the test with the area while a route says the test goes there. |
| **risk** | 20 | Priority and risk level. What it costs to be wrong here. |
| **history** | 20 | Failed last time (10), unstable results (5), a failure rate above 20% (5). Instability is information, not noise. A test that has never run scores 10: never executed is the state in which least is known, not the state in which nothing is wrong. |
| **staleness** | 10 | Nothing under a day, rising to the full 10 at a fortnight. A test nobody has run for two weeks is the one most likely to have quietly rotted. |
| **always** | 10 | Tagged `smoke`, `critical` or `always`. These run whatever changed. |

The default bar is **40** — the impact weight — so a test the change reaches is selected on
that alone, and a test it does not reach needs a real argument from its own risk, history and
staleness.

Every component is returned with its points, its maximum and a sentence:

```
→ TC-0001 Accounts list opens                                              70
      impact         40/40  This test exercises /accounts, which the change affects.
      risk           10/20  Priority medium, risk medium.
      history        10/20  This test has never run, so nothing is known about it.
      staleness      10/10  It has never been run.
      always             —  Not part of the always-run set.
```

Only the components that contributed become *reasons*. "history: 0, this test has never
failed" is noise dressed as transparency.

## When it cannot tell

Three fallbacks, each loud:

| Situation | What happens |
| --- | --- |
| The change maps to nothing | The whole suite runs, `fellBackToFull: true`, and the note says a narrowed run here would be a guess. |
| A rule marks the change as affecting everything | The whole suite runs, with the rule's reason. |
| The change maps to something but nothing scores above the bar | The smoke set runs. If there is no smoke set, the whole suite runs and the note says to tag one. |
| A tag filter matches no tests | **Refused**, 400: "a regression run with nothing in it would report success without testing anything." |

The last is the important one. An empty selection is not "no tests needed" — it is "QA NXT
does not know", and a pipeline reads an empty run as a pass.

## From the CLI

```bash
qanxt regression impact --since origin/main            # what the change affects
qanxt regression select --since origin/main --explain  # what would run, and why
qanxt regression run    --since origin/main            # select, then run, then the verdict
```

```
--since <ref>          Compare against this git ref
--changed <path>       A changed path; repeat (instead of --since)
--changed-file <path>  Read changed paths from a file, one per line
--mode <mode>          impacted (default) | smoke | full
--max <n>              Run at most n tests, highest-scoring first
--min-score <n>        Leave out tests scoring below this (default 40)
--include-tag / --exclude-tag
--explain              Print every component and its reason
--dry-run              Select and report; execute nothing
--selection-out <path> Write the selection as JSON, for the pipeline's artifacts
```

`--since` shells out to git, because a pipeline already has the repository. If the checkout
is shallow the diff will fail, and the error says so rather than silently selecting nothing.

`qanxt regression run` uses the same exit-code contract as `qanxt run`: 0 PASS,
1 TEST_FAILURE, 2 QUALITY_GATE_FAILURE, 7 HUMAN_REVIEW_REQUIRED, 3 CONFIGURATION_ERROR.

## In a pipeline

```yaml
- run: git fetch --no-tags --depth=50 origin main     # a shallow clone has no diff
- run: qanxt regression run --since origin/main --report-dir artifacts
```

`--report-dir` writes `regression-selection.json` beside the JUnit, JSON and HTML reports,
so the record of what was chosen — and what was not — is an artifact of the build rather
than a line in a log that scrolls away.

On the default branch, or nightly, run everything:

```yaml
- run: qanxt regression run --mode full --report-dir artifacts
```

## Limitations

- **A test's routes come from its steps' URLs.** A test that navigates by clicking rather
  than by URL contributes fewer routes, and may be selected only by tag or by its own risk
  and history. Tagging such tests is the fix.
- **Inference is by name only.** There is no import graph, no call graph and no coverage
  data. A file whose name resembles nothing maps to nothing, and the selection falls back
  accordingly.
- **Rules are per project, not per branch.** A repository whose layout differs between
  branches needs rules that cover both.
- **No history-based learning.** The selector does not notice that changes to one directory
  have historically broken one suite. That would be genuinely useful and is not implemented;
  saying so is better than a weight that drifts.
- **Selection is not a gate.** Running fewer tests does not change what the quality gate
  measures. A narrowed run that passes means the selected tests passed, which is a weaker
  statement than a full run passing — and the selection artifact is what makes the
  difference legible.

## See also

- [`docs/ci-cd.md`](ci-cd.md) — the exit-code contract and pipeline configuration
- [`docs/quality-gates.md`](quality-gates.md) — what decides whether a run blocks
- `verification/evidence/REG-*/` — the executed evidence behind every claim here
