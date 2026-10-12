# Form-level testing

How QA NXT turns every discovered form into a test suite, runs it, and measures what it
covered. Everything here is deterministic: no model is consulted, and the platform behaves the
same with `AI_DISABLED=true`.

```text
discovery ── forms, fields, declared limits, options, wizard steps, probed dependencies
   │
   ▼
FormTestDesigner ── tests per category, gaps, human tasks, structural findings
   │
   ▼
FormTestingService ── stored by generation key; edits never overwritten; vanished checks deprecated
   │
   ▼
runs (all · failed · impacted · regression · selection)
   │
   ▼
form oracles in the worker ── refused / accepted / field invalid / error associated / requests / …
   │
   ▼
failures → DefectService (correlate by symptom and place) → confirmed → regression test
   │
   ▼
CoverageService ── per form, per category, per dimension, with every gap
```

## Discovery

`apps/browser-worker/src/discovery/form-extractor.ts` reads every `<form>` (and the controls
outside any form, as one implicit form) without the element extractor's limits: hidden fields
are kept, because a wizard's later steps and a conditional field are hidden at crawl time.

Per field: name, id, test id, label and whether it is programmatically associated, placeholder,
control type (refined from `inputmode` and `autocomplete`: card number, OTP, decimal), required,
read-only, disabled, visible, default value (never for passwords), every declared constraint
(`minlength`, `maxlength`, `min`, `max`, `step`, `pattern`, `accept`, `multiple`), options,
`aria-describedby` text, wizard group, and a locator with fallbacks.

`form-probe.ts` then changes each select, checkbox and radio group in turn and records which
fields appeared, disappeared, became required, or had their options rebuilt. It types nothing
and submits nothing, and it stops on a page the moment a change navigates or sends anything
other than a GET.

Forms are stored per page (`application_forms`) with a hash of their shape. A later discovery
that finds a different shape records when it changed, which is what *Run impacted* reads.

## The taxonomy

Every test has exactly one category — the one its oracle checks — so coverage can be counted
by category. `TestingTaxonomy` (`apps/api/src/QaNxt.Application/Forms/TestingTaxonomy.cs`) is the
single description the console, reports and generator share; `GET /api/v1/meta/testing-taxonomy`
serves it.

| Category | What is generated | Oracle |
|---|---|---|
| Smoke | Every field shown, submit enabled | visible, enabled |
| Functional | Complete valid submission; required fields only | accepted |
| Negative | Empty form; each required field alone; whitespace only; typed then cleared | refused |
| Validation | Email, URL, pattern violations, off-step numbers, wrong file type | refused |
| Boundary | min−1/min/min+1/max−1/max/max+1 for lengths, numbers, dates; zero, negative, very large, precision | refused / accepted / value length |
| Equivalence | Every option (first/middle/last above 25), both states of an optional box, a second valid value | accepted |
| Input handling | Spaces, tabs, line breaks, Unicode, emoji, HTML and encoded characters, malformed encoding, repeated, very long, null-like | no server error |
| Cross-field | Confirmation mismatch; reversed and equal ranges, inferred from field names | refused / accepted |
| Dynamic | Field shown by an answer, hidden again, required once shown; dependent options; no stale child | visible / hidden / refused / text |
| Multi-step | Next refused when incomplete, advances when complete, Previous keeps answers, last step enforced | field invalid / visible / value |
| Reliability | Rapid second press, refresh after submit, back after submit | request count |
| Error handling | Error on the field it concerns; network failure reported (script-submitted forms) | field invalid / refused |
| Recovery | Correct and resubmit; refresh a wizard part way | accepted / no server error |
| State transition | Empty → invalid → valid → submitted; reload partly filled; return after submit | refused, accepted, no server error |
| Exploratory | Session cleared before submit; repeated invalid submits; away and back; optional fields alone | no server error / refused |
| Security | Inert markup reflection probe; anti-forgery token; password masked | no markup injection / present / attribute |
| Accessibility | axe-core in normal and error states; error association per required field; tab order; keyboard submit | rules / association / focus / accepted |
| API | Valid submission reaches its endpoint carrying what was typed; server validates too | requests |
| Performance | Page load and submission response within budget | load time / request timing |
| Responsive | Each non-desktop viewport: no sideways scroll, every field shown | no horizontal scroll, visible |
| Compatibility | Valid submission per configured browser; skipped (not passed) in a run on another browser | accepted |
| Visual | Form, error state, mobile layout against baselines | visual comparison |
| Usability | Structural heuristics, reported as findings, never failures; a human review task | — |
| Data integrity | Human task: QA NXT cannot read the application's database | — |
| Workflow | Recorded journeys; business rules as a human task | — |
| Regression | Copies of the tests that caught confirmed defects | as the original |

## Oracles

`apps/browser-worker/src/execution/form-oracles.ts`. None passes on an absence of evidence.

- **assertFormRejected** — the form is still there, a field is marked invalid (aria-invalid, or
  browser validation when the form uses it) or an error message is shown, and no confirmation
  appeared. A form that refuses silently fails, with "nothing told the user what was wrong".
- **assertFormAccepted** — a confirmation appeared or the form gave way, with no error and no
  server failure since the test's last navigation.
- **assertFieldInvalid / assertFieldValid / assertErrorAssociated** — whether a field is marked,
  and whether its error is tied to it for assistive technology.
- **assertRequests** — counts, status, timing and payload of the requests since the last
  navigation, after waiting for every request in flight to come back. Duplicate-submission
  checks count only submissions the server did not refuse.
- **assertNoServerError** — no 5xx, no uncaught script error, no stack trace or SQL error on the page.
- **assertNoMarkupInjection**, **assertLoadTimeUnder**, **assertNoHorizontalScroll**,
  **assertFocused**, **assertPresent**, **assertValueLength**.

## Values

`ValueSynthesizer` produces values that meet every declared constraint at once, and checks
them against the constraints before using them. Patterns are generated by a small generator for
the regular expressions HTML patterns are written in, and verified against the real pattern; a
pattern it cannot satisfy is a gap, not a guess. A sign-in form uses the application's
configured credentials (`${secret:app_username}`, `${secret:app_password}`); without them, no
test that expects a successful sign-in is generated.

## Gaps, human tasks and findings

A **gap** is something the engine could not test, with what is missing, why and what to do:
*not covered*, *partially covered*, *unknown* (an undeclared limit), *human required* or
*unsupported* (load testing, a network failure the browser handles). Gaps count against coverage
except *human required* and *unsupported*, which are reported separately.

A **human verification task** has a reason, steps and an expected result, and records a person's
verdict, comments and evidence. Regeneration never resets a verdict.

A **finding** is read from structure — a placeholder used as a label, a password on a GET form,
card data without an autocomplete purpose — and is kept apart from test failures.

## Regeneration and the repository

A generated test keeps its **generation key** (form, category, technique, field), so
regenerating after a new discovery updates the same test rather than adding another. A test a
person has edited is never overwritten; one whose field or rule has gone is **deprecated**,
not deleted. Every edit snapshots the previous version (`test_case_versions`), and two versions
can be compared.

Lifecycle decides what runs: only **Active** tests are part of *Run all*. Imported tests start
as **Draft**.

## Coverage

`CoverageService` counts everything from stored tests and their latest executions. Per form and
category: generated, executed, passed, failed, blocked, open gaps and human tasks. A category's
coverage is executed ÷ (generated + open gaps); a form's score is the weighted mean over the
categories that apply. A category that does not apply is **N/A**; one the configuration left
out is **not selected**; neither counts. Pass rate is reported beside coverage, never instead of
it.

Dimensions: pages, forms, fields, validation rules, boundaries (with unknown ones), APIs,
testing types, browsers, viewports, security controls, accessibility checks, states, workflows.

## Defects

`DefectService.CorrelateAsync` runs when a failure is recorded. Only failures the classifier
attributes to the application, or failures of an oracle, propose a defect; locator, environment,
network and authentication problems do not. The signature is the symptom and its place — the
same 5xx from the same endpoint, the same accepted-invalid behaviour on the same field and rule
— never the test, so many failing tests become one defect with every test attached. A proposed
defect becomes a regression test only after a person confirms it.

## Verification

`./scripts/verify-complete-manual-testing` proves all of this end to end, with AI disabled,
against the golden form lab (`test-lab/form-lab`: twenty forms, fourteen deliberate defects,
ground truth generated from the same declarations the server validates with). It writes
`verification/manual-testing-coverage-report.md` from what it counted.
