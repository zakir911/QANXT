# Accessibility checks

AIRA runs [axe-core](https://github.com/dequelabs/axe-core) against a page as a test step.

**Read this part first.** Automated checks find roughly a third of WCAG issues — that is
axe's own figure, not a hedge. A page with no violations has not been shown to be
accessible; it has been shown to have no violations a machine can find. AIRA never reports
a clean result as "accessible", and neither should anything built on top of it:

```
No violations found by wcag2a, wcag2aa, wcag21aa (21 rule(s) passed, 1 need a person
to check). Automated checks find roughly a third of accessibility problems.
```

The wording is deliberate and is pinned by a test. A tool that reports "no violations" as a
clearance does real harm, because a team reads it as one and stops looking.

## As a step

```json
{
  "action": "checkAccessibility",
  "description": "Check the checkout page for accessibility violations",
  "value": "{\"failOn\":\"serious\",\"standards\":[\"wcag2a\",\"wcag2aa\",\"wcag21aa\"]}"
}
```

| | |
| --- | --- |
| `standards` | axe tag names. Defaults to `wcag2a`, `wcag2aa`, `wcag21aa`. |
| `failOn` | Fail the step at this impact or worse. Defaults to `serious`. `null` measures and never fails. |
| `include` | A CSS selector to confine the scan to. |
| `exclude` | Selectors to leave out. Recorded in the result. |
| `ignoreRules` | Rule ids to skip, each **with a reason**. |

`best-practice` is available and **not** on by default. It is axe's own advice rather than
a WCAG requirement, and failing a build on advice nobody agreed to is how a check gets
switched off.

The default threshold is `serious`, not `minor`, for the same reason. A step that fails on
every minor finding is a step a team disables in week two, and a disabled check finds
nothing at all.

## Measuring before enforcing

`"failOn": null` scans, records everything, and never fails the step.

That is how you adopt this on an application that already has findings: the numbers go into
the report from day one, the trend is visible, and the build starts failing when the team
chooses rather than on the day somebody added the step.

The findings are stored either way. A failure that says "7 violations" and drops the list
is half a report, and a passing report-only scan that stored nothing would be no better
than not running.

## Suppressing a rule

```json
{"ignoreRules": [{"rule": "color-contrast", "because": "Brand palette sign-off pending, ticket QUAL-412"}]}
```

A reason is required. An unexplained suppression outlives whoever added it, and nobody can
tell later whether it was a considered decision or a way to get a build green.

`exclude` is the same idea for regions. The honest use is a third-party widget nobody here
can fix; the dishonest use is the part of the page that fails. Exclusions are recorded in
the result either way, so a reader can see what was not looked at.

## The quality gate

```
metric: accessibilitySeriousCount
operator: equal
threshold: 0
action: fail
```

Critical and serious together, because that is the band a team acts on. A metric that moved
on advisory findings would make the rule noise.

**A run with no accessibility step reports the metric as unmeasured, not as zero.** The rule
is sent for review rather than treated as satisfied:

```
The number of critical or serious accessibility violations was not measured for this
run, so this rule could not be evaluated. It is reported for review rather than
treated as satisfied.
```

A rule that passed because nothing looked reads as a guarantee that the page is accessible.
That is the failure this exists to prevent.

The step's threshold and the gate are separate decisions. A scan with `failOn: null` passes
its step and still moves the gate metric — measuring and enforcing are different things.

## Violations and incompletes

axe returns three kinds of answer, and AIRA keeps them distinct:

- **Violations** — definitely wrong. These are what the threshold acts on.
- **Incomplete** — a check a machine cannot decide, which a person must. Reported as a
  count, never as a pass and never as a violation.
- **Passes** — rules that ran and found nothing. Reported so that a clean result is
  readable as "these rules ran" rather than "nothing was checked".

A dangling `aria-describedby` is a good example of the middle one: axe reports it as
*incomplete* rather than a violation, because the target element might be added by script
after the scan. AIRA does not promote it, because failing a build on something the tool
cannot know would be wrong, and it does not drop it, because a page with twelve things
needing a human is not clean. The lab has a fault for exactly this case.

## Verification

```bash
node verification/golden-tests/run.mjs --suite accessibility
```

Six tests (ACC-001…ACC-006) against `test-lab/forms-app`, whose accessibility faults each
name the axe rule they are built to trip, recorded in its `ground-truth.json`:

| Fault | Rule | Outcome |
| --- | --- | --- |
| `FAULT_A11Y_MISSING_LABEL` | `label` | violation (critical) |
| `FAULT_A11Y_MISSING_ALT` | `image-alt` | violation (critical) |
| `FAULT_A11Y_LOW_CONTRAST` | `color-contrast` | violation (serious) |
| `FAULT_A11Y_EMPTY_BUTTON` | `button-name` | violation (critical) |
| `FAULT_A11Y_DANGLING_ARIA` | `aria-valid-attr-value` | **incomplete**, not a violation |

Precision and recall both matter. ACC-002 requires each fault to produce exactly the rule
its ground truth names — "the scanner found something" is not evidence it finds the right
things — and ACC-001 requires a clean page to report clean, because a scanner that reports
violations on a good page is as broken as one that reports none on a bad one.

The fifth row was arrived at by measuring rather than assuming: a duplicated ARIA-referenced
id was tried first and axe 4.13 reports *that* as incomplete too. Both are in the record.
