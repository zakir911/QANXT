# Change impact

Which tests a change reaches, and why.

```bash
qanxt regression impact --since origin/main      # what the change was found to affect
qanxt regression select --since origin/main --explain
qanxt regression run --since origin/main
```

## Two sources, kept apart

A mapping from a changed file to a test comes from one of two places, and QA NXT always says
which:

**Rules a team wrote.** Explicit, and trusted:

```json
{"pathPattern": "src/checkout/**", "impacts": "route", "value": "/checkout", "weight": 100}
```

**Inference from names.** QA NXT splits paths and test names into words and looks for
overlap — `src/payments/refund.ts` reaches a test called "Refund a payment". Useful, and
guesswork.

The two are never merged into one confident-looking number. `--explain` labels every
mapping as declared or inferred, because a team deciding whether to trust a selection needs
to know which kind it is looking at.

## Scoring

Each candidate test scores out of 100:

| | | |
| --- | --- | --- |
| `impact` | 40 | Does the change reach this test at all |
| `risk` | 20 | What it costs to be wrong about this area |
| `history` | 20 | Recent failures and instability — a test that has been failing is worth running again |
| `staleness` | 10 | How long since it last ran |
| `always` | 10 | Tagged `smoke`, `critical` or `always` |

The default cut is 40. `--min-score` moves it; `--max` caps how many run.

## When it cannot tell

Three cases fall back loudly rather than quietly selecting nothing:

- **No changed files** — nothing to reason from, so everything is selected.
- **No mapping matched** — the change reaches nothing QA NXT knows about, so everything is
  selected.
- **A file nothing covers** — reported, because a change with no test is the finding.

Selecting nothing is never the answer to "I could not work it out". A run that tested
nothing and reported a pass is worse than a slow run.

## Modes

| | |
| --- | --- |
| `impacted` | Only what the change reaches. The default. |
| `smoke` | Everything tagged smoke or critical. |
| `full` | Everything. |

A nightly should be `full` or close to it. Impact analysis is for the commit path, where
the alternative is a two-hour wait; the thing it cannot do is find a defect in code nobody
touched, which is what [scheduled regression](scheduling.md) is for.

## The selection is an artifact

```bash
qanxt regression run --since origin/main --selection-out artifacts/regression-selection.json
```

"Why did that test not run?" has an answer on the build page, with the score and the
reasoning, rather than in somebody's memory.

## See also

[Regression selection](regression-selection.md) — the full reference ·
[Scheduled regression](scheduling.md) · [Release quality](release-quality.md)
