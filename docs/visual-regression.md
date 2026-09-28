# Visual regression

QA NXT captures the page and compares it with a baseline somebody agreed to.

The hard part is not comparing pixels. It is that **most visual differences are
intentional** — somebody changed the design — and a check that fails the build on every
deliberate change is one a team switches off within a fortnight. So the default verdict for
a difference is **review**, not fail. A person looks, and either accepts the new appearance
or files a defect.

```json
{
  "action": "checkVisual",
  "description": "Compare the checkout page with its baseline",
  "value": "{\"name\":\"checkout\",\"fullPage\":true,\"mask\":[\"[data-testid=\\\"cart-total\\\"]\"]}"
}
```

| | |
| --- | --- |
| `name` | What this baseline is of. Defaults to the step's description. |
| `viewport` | Capture size. Defaults to 1280×720. Part of the baseline's identity. |
| `fullPage` | Capture the whole scrollable page. Defaults to false. |
| `selector` | Confine the capture to one element. |
| `mask` | Selectors painted over before comparing. |
| `maxDifferencePercent` | Difference tolerated. Defaults to 0.1. |
| `pixelThreshold` | How different one pixel must be to count, 0–1. Defaults to 0.1. |
| `onDifference` | `review` (default), `fail`, or `ignore`. |
| `updateBaseline` | Accept this capture as the new baseline. |

## Four verdicts, not two

| | |
| --- | --- |
| `match` | Within the threshold. |
| `differs` | Over it. Three images are stored: baseline, capture, diff. |
| `sizeChanged` | The page is a different size. Images of different dimensions cannot be compared pixel by pixel, and scaling one to fit the other would hide the change. |
| `newBaseline` | There was nothing to compare against, so this capture became the baseline. |

`newBaseline` is **not** reported as a pass. "Nothing to compare against" and "identical to
the baseline" are different statements, and a first run reported as a pass is a green tick
for a check that did not happen.

## The threshold is not zero, and that is deliberate

Anti-aliasing differs between machines and browser versions, and real pages contain things
that change: a timestamp, a session id, a chart of live data.

The forms lab renders a live "Generated at" timestamp on purpose, so the noise is present
and measurable. Its ground truth records the floor:

```
0.0026% to 0.0039% (56 to 85 pixels) across three unchanged captures
```

A zero threshold would report a difference on every run of an unchanged page, which teaches
its readers that diffs are meaningless — the same outcome as having no check.

## Masking

```json
{"mask": ["[data-testid=\"generated-at\"]"]}
```

The region is painted over in both images before comparing, so it cannot differ. With the
timestamp masked, repeated captures differ by **exactly zero pixels**.

Masked selectors are **recorded in the result**. Masking the region that keeps failing is
the obvious way to make a visual check useless while appearing to run it, so what was
hidden is on the record.

Two things are worth knowing:

- Masking paints over rather than removes. Removing an element reflows the page, and the
  comparison would then report every pixel below it as different.
- The region must exist in the baseline too. Masking something the baseline never had adds
  a magenta block where the baseline has content — a bigger difference than the one you
  were hiding. Measured while building this: masking an element present in only one of the
  two images took the difference from 1.05% to 2.93%.

## A baseline's identity

Test case, name, browser, viewport — all four. A baseline taken in Chromium at 1280 wide
says nothing about Firefox at 375, and comparing across either would report a difference on
every run.

Name the baseline explicitly if you can. The default is the step's description, and
renaming a step orphans its baseline.

**Baselines are never updated by a run.** `updateBaseline` is set by a person approving a
change. A run that updates its own baselines cannot regress, because it agrees with itself
every time.

A baseline records who approved it and when. The first capture has neither — it became the
baseline because there was nothing to compare against, which is a different thing from
anybody deciding the page should look that way.

## Determinism

A screenshot taken twice of an unchanged page has to be the same screenshot. Each of these
is a named source of difference, dealt with rather than slept through:

- Animations and transitions are zeroed, and scroll behaviour made instant.
- The text caret is made transparent, so a focused field does not blink.
- Lazy images are switched to eager loading, so a full-page capture cannot catch one
  part-decoded.
- `document.fonts.ready` is awaited — a web font arriving after the shot changes every
  glyph in it.
- Focus is blurred, so a focus ring does not depend on what the previous step did.

`settleMs` exists for what is left — a transition with no event to wait for. It is a blunt
instrument and is off by default, because a delay on every visual step is a slow suite.

## The quality gate

```
metric: visualDifferenceCount
operator: equal
threshold: 0
action: review
```

Counts `differs` and `sizeChanged`. `newBaseline` is not counted: nothing was compared, so
nothing changed.

**A run with no visual step reports the metric as unmeasured, not zero** — a rule that
passed because nothing looked reads as "the page is unchanged".

## Verification

```bash
node verification/golden-tests/run.mjs --suite visual
```

Seven tests (VIS-001…VIS-007) against three lab changes of measured magnitude:

| Fault | Measured | Verdict |
| --- | --- | --- |
| `FAULT_VISUAL_TINY` | 0.022% | `match` — real, below the threshold |
| `FAULT_VISUAL_OBVIOUS` | 0.294% | `differs` — colour only, so layout does not move |
| `FAULT_VISUAL_TALLER` | 1280×1881 vs 1280×1694 | `sizeChanged` |

VIS-006 is the one that matters most: two masked captures must differ by **exactly** zero
pixels. The unmasked floor is 0.0026%–0.0039%, so anything above zero would mean the mask
was not applied.

Building this found a gap before commit: the API dropped the `viewport` from the stored
comparison, so a result could not be reconciled with the baseline it used. VIS-007 caught
it — the behaviour was right and the record was incomplete.
