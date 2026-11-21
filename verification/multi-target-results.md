# What QA NXT found on four applications of different shapes

Every number here was produced by `node test-lab/run-target.mjs <target>`, which drives the
product through its own API exactly as a team would: register the application, discover it,
design the deterministic form-level suite, authorize and run a security scan with several
identities, execute the suite in a real browser, then join every failure and finding back to
the defects planted in the target. AI is switched off throughout, so the figures are the
deterministic engines and nothing else.

The run that produced this file is recorded in `test-lab/multi-target-result.json`.

## Why four applications and not one

Meridian Freight — 137 screens, server-rendered, a sign-in form, POST for everything that
writes — was the only application the engines had ever been measured against. One
application can only expose the defects its own conventions reach, and that proved to be
the limit rather than a theory: **fourteen product defects came out of building three more
targets, and nine of them were the same mistake made in a second place.** A rule the engine
had learned and the worker had not. A URL joined correctly in one module and concatenated in
forty-three sites of another. An identity model implemented carefully and then undone by two
lines in a handler no test could reach. They are listed in
`verification/defects-found-by-measuring.md`, entries 13 to 26.

| Target | Built like |
| --- | --- |
| `freight-platform` | server-rendered, 137 screens, 13 domains, form sign-in |
| `clinic-spa` | 244-byte HTML shell; every screen, form and table built by JavaScript; History API routing; JSON API |
| `permits-legacy` | HTTP Basic challenge, state changes through `GET` links, no anti-forgery token, nested-table markup, integer ids in the query string |
| `token-api` | bearer token in a JSON body rather than a cookie, `X-CSRF-Token` header convention, one HTML page over a JSON API |

## Measured

| | clinic-spa | permits-legacy |
| --- | --- | --- |
| Pages discovered | 3 | 7 |
| Forms extracted | 3 | 2 |
| Tests designed and run | 151 | 202 |
| Passed | 126 | 170 |
| Failed | 16 | 28 |
| Skipped / blocked | 6 / 3 | 4 / 0 |
| Security checks run | 27 of 27 | 18 of 18 |
| Security findings | 14 | 22 |
| Defects correlated | 6 | 11 |
| Structural findings | 1 | 6 |
| Coverage gaps | 29 | 22 |
| **Planted defects detected on evidence** | **3 of 4** | **3 of 4** |

Discovery working at all on `clinic-spa` is the first result worth stating: the server sends
no content, and the form extractor still found all three forms, because discovery drives a
real browser rather than reading responses.

## The control group: the application the engines were built against

`freight-platform` was re-run after every change above, because a fix made for one shape of
application is worth nothing if it costs another. Before and after:

| | before this round | after |
| --- | --- | --- |
| Pages discovered | 152 | 150 |
| Forms extracted | 73 | 72 |
| Tests designed | 6,354 | 6,344 |
| Stopped because | the 900s budget | the 900s budget |
| Links discovery refused to follow | — | 0 |

Unchanged, and the small differences are the budget boundary rather than capability: both
runs stopped on the same 900-second exploration budget with pages still queued.

Two details worth stating, because they say *why* nothing changed. The link guard refused
nothing here: Meridian Freight changes state through POST forms and buttons, which were
always left alone, so the rule that stopped a permit register being approved costs this
application nothing. And its 150 pages carry 150 distinct route shapes — its identifiers are
`SH-1001` and `inv-0004`, never a bare number — so the visit-key fix changes nothing here
either. It only ever changes behaviour on an application that keys records by a numeric path
segment or a query string, which is precisely the case it was built for.

## The two that were not detected

Neither is counted, and neither is quietly dropped.

**PL_D01 — approving a permit is a `GET` any signed-in role may issue.** Reported as a
coverage gap, not a finding: *"The link "Approve" at /approve.asp?id=1, on /list.asp, says it
changes something, and a GET that changes something can be triggered by anyone who gets a
user to open the URL. Discovery did not follow it: mapping an application must not alter it.
Whether it really changes state, and whether it checks an anti-forgery token, was therefore
not established."* The remedy is named — authorize destructive testing, or open it once by
hand. Claiming the defect would be asserting what was not observed; saying nothing would
hide it.

Discovery refusing to follow that link is itself a fix from this round. A crawl approved all
three permits in the register before the rule existed.

**CS_D04 — cancel is hidden from a receptionist and the endpoint allows it.** Not detected
and not surfaced. The cancel endpoint is reached only by pressing a control that changes
state, which discovery correctly never presses, so the endpoint was never observed and the
scanner cannot test what it has not seen. The check that would settle it is the application's
own interface: a control one role is shown and another is not, with the endpoint accepting
both. That needs discovery to run separately as each identity, which the product does not
do.

## The big application's remaining misses, by reason

Seven classes of defect on Meridian Freight had never been detected. Working through them
produced one fix, one that was already covered and awaiting a verdict, and five limits worth
naming rather than rounding away. The useful output of this exercise was the reasons, not the
score.

**Fixed: FP_D15, going back in the booking wizard empties step two.** The retention test
existed and looked only at step one — the step that kind of bug spares — and read only text
fields, while the step that loses data holds numbers and a selector. Every step that can be
returned to now gets its own test, with numbers, dates and selects read back. Recorded as
product defect 27.

**Already covered, verdict pending: FP_D18, a search term over 500 characters returns 500
with a stack trace.** The input-validation battery now sends 5,000 characters to any
free-text field that declares no maximum, and the test
`Shipments: handles 5000 characters in Search` exists in the current suite. Whether it fires
is a matter for that run, not for a code change.

**FP_D01, a stock adjustment that drives on-hand below zero.** The form declares its own
range and the engine tests that range on both sides, in the browser and at the endpoint. The
defect is not a range: it is a rule about the *resulting* balance, which needs the on-hand
quantity and the arithmetic that relates it to the adjustment. Nothing on the page states
that rule.

**FP_D03, a weight entered in pounds stored as kilograms.** Reading the record back cannot
settle this, and the attempt would be worse than the miss. The corrected application shows
453.6 kg for 1,000 lb — the unit submitted appears nowhere, and neither does the number — so
an oracle demanding either back would report the *correct* application for losing data. What
would settle it is a differential: the same number under two units must produce two different
results. That needs the engine to know which selector qualifies which number, which is a
declared relationship the page does not carry.

**FP_D04, two invoices with the same reference.** The reference is generated by the server,
so the test cannot submit a duplicate and watch it be refused; it would have to create two
records and compare the identifiers the application assigned them, which means reading
identifiers out of a list and knowing which of them is meant to be unique.

**FP_D14, cancelling a shipment leaves its route stop active.** A rule between two entities,
stated in requirements and nowhere on either page.

**FP_D24, the approval modal is not announced and does not trap focus.** Reaching the modal
means pressing "Approve", which is a state-changing control that discovery correctly never
presses — the same limit as PL_D01 above, and for the same reason. Authorizing destructive
testing would reach it.

Two of the five (FP_D01, FP_D14) want a declared business rule. Two (FP_D03, FP_D04) want a
declared relationship between fields or records. One (FP_D24) wants permission to press a
control that changes state. None of them wants a cleverer pattern match, and an oracle built
without the declaration would report correct applications as broken — which is how the three
criticals, the escalation finding and the twelve header findings described below came to be
removed.

## False findings, which matter as much as true ones

A security tool that cries wolf is not used twice, so each class below was verified by hand
before being removed.

| Was reported | Why it was wrong | Now |
| --- | --- | --- |
| 3 criticals, "protected data is served to an unauthenticated caller" | about a 244-byte shell holding a script tag and nothing else; fifty routes would have given fifty | inconclusive, with the reason |
| "clerk can reach a route intended for inspector", high, confirmed | the route is the form clerks use; the check concluded escalation from "both roles got 200" | inconclusive unless the route names itself administrative, and then marked likely, not confirmed |
| 12 missing-header findings naming `/schedule/schedule` | measured on the 404 page, at URLs that do not exist | measured on the real pages |
| 23 of 43 test failures on the SPA | submissions the application had accepted and acted on | 16 failures, of which 2 are the planted defects |

The 16 that remain on `clinic-spa` were read one by one. Two are the planted defects. The
rest are real and were not planted: the application crashes with `found.body.map is not a
function` when its session expires, tells the user nothing when the network drops, and shows
a form error that assistive technology would not announce with the field.

## What this does not show

- **Firefox and WebKit are not verified.** The environment's network policy blocks the
  Playwright CDN, so only Chromium is available here. `EXEC-015` and `EXEC-016` say so.
- **One run each.** These numbers are a single run per target, not a distribution, so they
  carry nothing about flakiness.
- **The targets are synthetic.** They were written to have known defects in known places,
  which is what makes a detection rate measurable and also means they are kinder than real
  software: the defects are the ones somebody thought to plant.
- **100% is not reachable and is not claimed.** Two of the eight planted defects need either
  an authorization the scan is not given or a capability the product does not have, and both
  are stated above rather than rounded away.
