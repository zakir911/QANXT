# BUG-0041 — A generated scenario states an expectation it never checks

| | |
| --- | --- |
| **ID** | BUG-0041 |
| **Title** | The "Reject an invalid filter range" scenario declares "A validation message explains that the range is invalid" on all three of its assertion tiers, including the two that assert nothing of the kind |
| **Severity** | **HIGH** |
| **Found by** | Report-only QA pass of the console against the demo bank (`/qa-only`, ISSUE-001) |
| **Environment** | See `verification/environment.md` |
| **Build** | `8f8aa91` |
| **Component** | `apps/api/src/QaNxt.Infrastructure/Ai/Providers/LocalTestPlanner.cs` |
| **Reproduction rate** | 3 of 3 generated cases, on every generation |
| **Status** | Fixed and re-verified |

## What happens

`ListScenarios` closes the invalid-range scenario with one of three assertions, chosen by what
discovery observed on the page:

1. a validation element is present → assert it becomes visible;
2. no validation element but an empty-state element → assert the empty state becomes visible;
3. neither → assert the records table is hidden.

Those three check different things. The scenario's `name`, `objective` and `expectedResults`
were emitted once, outside the branch that picks the assertion, so all three shipped as:

```
name:            Reject an invalid filter range on {title}
objective:       An impossible filter range is refused rather than silently returning nothing.
expectedResults: A validation message explains that the range is invalid.
```

Tier 3 asserts `assertHidden` on the records table. That assertion is satisfied precisely when
the application silently returns nothing — the behaviour the objective names as the failure.
The test passes against an application with no range validation at all, and reports that pass
as evidence the range was refused.

## Why it is not a rare branch

Discovery records a page in its pre-interaction state. A validation message rendered in
response to the submit this scenario performs is therefore never in the element set, so
tier 1 cannot fire for any server-rendered form. Against the shipped demo bank:

```
$ curl -b <session> "http://localhost:4200/accounts/acc-1003?from=2030-12-31&to=2020-01-01"
<div class="error" role="alert" data-testid="filter-error">The "from" date must be on or before the "to" date.

$ curl -b <session> "http://localhost:4200/accounts/acc-1003"
(no alert element)
```

and in the stored model for that page, across 25 distinct elements:

```sql
select count(*) from application_elements e
 where e.aria_role in ('alert','status') or e.test_id ilike '%error%';
-- 0 on every /accounts/* page
```

The one alert element anywhere in the model is on `/activity`, where the banner is rendered
unconditionally. Tier 1 works; it is simply unreachable for validation that appears on submit.
The lower tiers are the normal path, not the exception.

## Evidence

The platform's own captured `final.png` for the passing execution shows the demo bank's
validation message in red — the behaviour the test declared it was checking and never did.
See `.gstack/qa-reports/screenshots/19-execution-evidence.jpg` and `20-evidence-tab.jpg`.

## Relationship to BUG-0016

BUG-0016 was the same function shipping an assertion that could not fail. Its fix made the
three assertions falsifiable. It did not reconcile them with the declared expectation, so the
scenario went on promising a check it does not make. Falsifiable and truthful are separate
properties, and a generated test case needs both: the assertion is what runs, the declared
expectation is what a reviewer reads when deciding whether a green run means anything.

## Fix

The name, objective and expected results are decided by the same branch that chooses the
assertion. Only tier 1 claims a validation message. Tiers 2 and 3 describe what they check and
state plainly what they do not:

```
The list of records is not displayed. Whether the range was refused with a validation message
is not checked: discovery observed no element that reports one on this page.
```

## Regression test

`apps/api/tests/QaNxt.UnitTests/Ai/GeneratedScenarioHonestyTests.cs` — six cases driving the
generator through `LocalProvider` for each tier. Four of the six fail against the unfixed
generator; all six pass against the fix. The last is stated as an invariant rather than three
examples, so a fourth tier added later is covered without anybody extending the file:

> a generated test case may promise a validation message only when a step asserts on one

## Noticed while verifying — not fixed here

`AiOrchestrator` caches responses by `(organization, promptHash, provider, model)` for
`CacheTtlHours` (default 168). The local provider's model string is the constant
`qanxt-rules-v1`, so changing the rules does not change the key. Regenerating with an
unchanged prompt replayed the pre-fix response and the API log said so:

```
[04:19:45 INF] Reusing a cached AI response for prompt b5f9a15cb229
```

A deployment that upgrades the rule engine keeps serving the old rules' output to any
organization that already generated from the same model, for up to a week. Verification here
was completed by changing the prompt so the hash differed. Raised separately.

---

## The rest of the QA pass

The remaining fourteen findings from the same report were fixed alongside this one. They are
listed here rather than as records of their own because none needed an investigation: the
report already carried the reproduction and the evidence.

| ID | Fix | Verified by |
| --- | --- | --- |
| ISSUE-002 | `.card` and `.table-wrap` take `min-w-0`, and the wrap scrolls (`overflow-x-auto`) instead of clipping | At 375px the document no longer scrolls sideways (750 → 375) and the last column moves from x=728 to x=333 when the table is scrolled |
| ISSUE-003 | The evidence copy names what is masked (DOM, accessibility tree, console and network logs) and what is not (screenshot, trace, video); the column reads "no" rather than an em dash | Card and column now agree: network log "yes", the other three "no" |
| ISSUE-004 | The insight context carries `testsRunMoreThanOnce`; with none, the answer says stability cannot be judged yet and sets `insufficientEvidence` | Both branches exercised: 0 repeated → "nothing to judge stability from yet"; 10 repeated → "all 10 test(s) … produced a consistent result" |
| ISSUE-005 | The tile counts distinct kinds among the records shown; the catalogue size moved into the hint | "ACTION KINDS IN THIS PAGE 6" against 7 matching records |
| ISSUE-006 | `LastDiscoveredAt` comes from the newest **completed** run's `CompletedAt`, not the newest run's `CreatedAt` | Card during a run: "Running", zeroes, and no "last explored" claim |
| ISSUE-007 | The nav measures its own overflow and fades the side that has more | At 1280px one right fade; scrolled to the end it becomes a left fade and Settings is fully visible |
| ISSUE-008 | `useDisclosedPanel` names the panel as a region and moves focus to its first field; the trigger carries `aria-expanded`/`aria-controls`. Not `aria-modal`: these panels are inline, and the rest of the page is not inert | Focus moves from `<body>` to the first input; panel labelled by its own heading |
| ISSUE-009 | `tidyForLog` strips ANSI codes and the multi-line call-log trailer; a download link is reported as one rather than as a load failure | Log is clean; "Did not open …: it serves a file download, not a page." |
| ISSUE-010 | The card maps the strategy to the words the form uses | "Authentication: Form login" |
| ISSUE-011 | `key={mode}` remounts the login form on a tab switch | All four fields empty after switching tabs |
| ISSUE-012 | The correlation-id field is sized for a correlation id | 350px, placeholder no longer clipped |
| ISSUE-013 | A real not-found page inside the layout; `ErrorNotice` takes an `action` so a missing record offers a way back | "That page does not exist" naming the path; "Back to test runs" beside "Try again" |
| ISSUE-014 | A visit marks the URL it landed on as visited, not only the one it asked for | `/dashboard` mapped once, was twice |
| ISSUE-015 | Registration sets `LastLoginAt`, because it issues a session. Not in `IssueAsync`, which the refresh path also uses | Settings reads "just now" for the account that just registered |

Regression test added for `tidyForLog` (`apps/browser-worker/test/exploration-log.test.ts`),
because an earlier draft of it type-checked, returned the right answer for the common case,
and silently stopped collapsing whitespace. The other thirteen are changes whose evidence is
the behaviour above; none of them had a seam worth a unit test that the existing suites and
the end-to-end walk do not already cover.
