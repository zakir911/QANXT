# Measuring QA NXT against Meridian Freight

Generated 2026-11-18 04:01 from `discovery-measurement.json`
and `ground-truth.json`. Every figure below traces to one of those files.

## What was measured, and what was not

**Measured:** discovery. The real crawler — `apps/browser-worker/src/discovery/crawler.ts`,
compiled, the same class the worker runs when the control plane queues a job — in a real
Chromium, signed in as a real user, against the running application. Three times, once per
interaction mode, with an identical budget.

**Not measured:** test generation, execution, failure analysis and the security scan. Those
live in the .NET control plane, and the container this ran in has no .NET SDK and no network
path to install one. That is an environment limit, not a product one: the full pipeline runs
on a machine with the SDK.

This matters less than it sounds, for one structural reason: **everything downstream of
discovery works from the model discovery builds.** Generation plans against discovered pages
and elements, execution drives what generation planned, the scanner attacks the discovered
surface. A defect on a screen discovery never reached is invisible to all of them, however
good they are. So discovery coverage is a ceiling on everything else, and it is the stage
that was failing in the field anyway.

## Ground truth

| | |
| --- | --- |
| Screens behind the sign-in | **134** |
| &nbsp;&nbsp;linked (reached by an `<a href>`) | 97 |
| &nbsp;&nbsp;routed (client-side router, no anchor anywhere) | 37 |
| Enclosed surfaces (modals, drawers, tabs — no URL at all) | 16 |
| Anonymous screens, held out of the denominator | 3 |
| Planted defects | 32 |
| End-to-end journeys | 6 |

The anonymous screens are held out because a crawl authenticates and then explores from the
dashboard; it never returns to the sign-in page, so counting them as missed would measure its
starting point rather than its reach.

## Result

| Mode | Screens reached | Linked | Routed | Pages mapped | Elements | Time | Finished |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `links` | **90/134** (67.2%) | 87/97 (89.7%) | 3/37 (8.1%) | 147 | 7,123 | 229s | yes |
| `navigation` | **103/134** (76.9%) | 85/97 (87.6%) | 18/37 (48.6%) | 150 | 7,306 | 905s | **no** — partiallyCompleted |
| `interactive` | **88/134** (65.7%) | 77/97 (79.4%) | 11/37 (29.7%) | 117 | 5,854 | 906s | **no** — partiallyCompleted |

### By domain

| Domain | Shape | `links` | `navigation` | `interactive` |
| --- | --- | ---: | ---: | ---: |
| admin | routed | 0/11 | 1/11 | 1/11 |
| billing | linked | 11/11 | 11/11 | 11/11 |
| carriers | linked | 8/10 | 8/10 | 5/10 |
| claims | routed | 3/8 | 5/8 | 3/8 |
| customers | linked | 5/10 | 5/10 | 3/10 |
| customs | linked | 10/10 | 8/10 | 8/10 |
| dashboard | linked | 8/8 | 8/8 | 8/8 |
| fleet | routed | 0/10 | 6/10 | 1/10 |
| orders | linked | 11/11 | 11/11 | 9/11 |
| reports | linked | 9/9 | 9/9 | 9/9 |
| routes | routed | 0/8 | 6/8 | 6/8 |
| shipments | linked | 11/14 | 11/14 | 11/14 |
| warehouse | linked | 14/14 | 14/14 | 13/14 |

## What the numbers say

### 1. Link-following cannot see a client-side router, as expected

In `links` mode the crawler reached 87 of 97 linked screens (89.7%) and 3 of 37 routed ones (8.1%).

The 3 routed screens it did reach came in through cross-domain
`<a href>` links from linked pages — the "Raise claim" anchors on the exception lists —
not through the routed navigation. Worth knowing: a deep link from elsewhere in the
application pulls a routed screen into reach, so coverage of a routed domain depends on
whether anything outside it happens to link in.

This is the shape that reduces a crawl to a handful of pages on a real admin application,
and it is the default mode.

### 2. Navigation mode reaches routed screens, and runs out of budget doing it

Turning on clicking took routed coverage from 8.1% to 48.6% — real improvement, and the mechanism works. But:

- it did **not finish** (`partiallyCompleted`), stopping on the 905s budget
- linked coverage went **down**, 87 to 85, because budget went to clicking
- cost per page rose from 1.6s to 6s

The queue grew faster than it drained: at 110 pages mapped there were still 582 queued. So
on an application this size the mode that fixes the routed problem does not complete, and
**what it misses is decided by sidebar order rather than by importance.** `admin` is last in
the sidebar and scored 1/11 — not a logic failure, a queue that never got there.

That is the finding a team would actually trip over. "Set it to navigation mode" is not a
complete answer on an application of this size; the budget has to be raised with it, and
nothing in the product tells you that.

### 3. Interactive mode

`interactive` reached 88/134 (65.7%) in 906s, status `partiallyCompleted`, at 7.7s per page.

Clicking more did not reach more: the extra actions went to inert controls while the budget drained.

### 4. Routed detail screens are nearly out of reach

10 routed screens need an identifier — `/claims/:id/settle`, `/fleet/vehicles/:id`,
`/admin/users/:id`, `/routes/:id/stops` and the rest. Reaching one means clicking a row
control inside a view that was itself client-rendered: two clicks deep, with no URL to
shortcut to. How many each mode reached:

- `links`: 1 of 10
- `navigation`: 2 of 10
- `interactive`: 2 of 10

2 planted defect(s) live on those screens: `FP_D11_VIEWER_CAN_SETTLE_CLAIM` (security), `FP_D19_OVERSIZE_UPLOAD_CRASHES` (minor).
A lot of an enterprise application's write operations live behind a row click like that.

### 5. The enclosed surfaces were never in scope

None of the 16 enclosed surfaces have a URL, so no crawl can enumerate them and
nothing in the discovery model represents them. Every modal form, tab panel and drawer in
this application is invisible to the platform: the approval dialog, the payment form, the
exception modal, all sixteen. They are reported here as a known gap rather than a score.

## Detection ceiling

Of the 32 planted defects, this is how many sit on a screen each mode reached.
It is a **ceiling, not a rate**: whether the platform would then find them needs generation
and execution, which this container cannot run. But a defect below the ceiling cannot be
found by anything.

| Mode | Defects on reached screens | Ceiling |
| --- | ---: | ---: |
| `links` | 25/32 | **78.1%** |
| `navigation` | 26/32 | **81.3%** |
| `interactive` | 20/32 | **62.5%** |

Even in the best mode (`navigation`), 6 defect(s) sit on screens no crawl reached:

| Defect | Severity | Screen | Shape |
| --- | --- | --- | --- |
| FP_D11_VIEWER_CAN_SETTLE_CLAIM | security | `/claims/:id/settle` | routed |
| FP_D13_LEGACY_API_KEY_FULL_SCOPE | security | `/admin/api-keys` | routed |
| FP_D17_RELEASE_REJECTED_DECLARATION | major | `/customs/declarations/:id/release` | linked |
| FP_D19_OVERSIZE_UPLOAD_CRASHES | minor | `/claims/:id/evidence` | routed |
| FP_D27_AUDIT_LOG_SLOW | minor | `/admin/audit` | routed |
| FP_D31_STACK_TRACE_LEAKED | security | `/api/shipments/:id` | enclosed-or-api |

By severity, in the best mode:

- **major**: 12 of 13 on reachable screens
- **minor**: 9 of 11 on reachable screens
- **security**: 5 of 8 on reachable screens

## Journeys

The 6 end-to-end journeys were driven by `journeys.mjs`, not by QA NXT — the platform
cannot drive them without the control plane. They are recorded here because which ones the
shipped build breaks is ground truth a future measurement should be held to.

| | Journey | Domains | Shipped build |
| --- | --- | --- | --- |
| J1 | Order to cash | orders → customers → shipments → routes → billing | breaks on `FP_D06_SURCHARGE_ON_GROSS` |
| J2 | Procure to dispatch | orders → warehouse | completes |
| J3 | Carrier onboarding to first booking | carriers → shipments | breaks on `FP_D07_RATE_BAND_BOUNDARY` |
| J4 | Exception to claim settlement | shipments → dashboard → claims → admin | breaks on `FP_D19_OVERSIZE_UPLOAD_CRASHES` |
| J5 | Customs hold to release | customs → shipments | breaks on `FP_D08_DUTY_EXCLUDES_FREIGHT` |
| J6 | User onboarding to audit trail | admin → claims | breaks on `FP_D27_AUDIT_LOG_SLOW` |

## Three bugs this measurement found in the lab, not the product

Recorded because they are the reason to distrust a first run of anything:

1. **35 screens had no inbound anchor.** The sidebar had 13 items and no second level, so a
   third of the "linked" screens were reachable only by typing a URL. The first run scored
   65/100 linked and was measuring missing links, not link-following. Fixed → 89.7%.
2. **Clicking a routed domain did nothing.** The router loaded only on routed pages, so the
   sidebar's `data-route` buttons were inert on every linked page. The first navigation run
   scored **0/37 routed** entirely because of this. A person could not reach Fleet from the
   dashboard either.
3. **Every modal was a full-screen overlay eating clicks.** `.modal{display:flex}` beats the
   `hidden` attribute on specificity.

All three passed the HTTP self-test, which could only assert that the markup *said* `hidden`
and that a button *existed*. `selftest-browser.mjs` now asserts the client-side claims by
clicking, in a real browser. If I had reported the first run as a product result, two of
these would have been published as QA NXT failures.

## What this does not establish

- **A detection rate.** Generation and execution did not run. The ceiling is an upper bound.
- **That QA NXT works on arbitrary applications.** One application, one afternoon, and the
  defects were written by the same author who then measured the tool against them. Better
  than defects written alongside the checks that find them, not the same as software nobody
  wrote for the test.
- **Anything about Firefox or WebKit.** Chromium only.
- **Anything about load.** Single crawler, single browser, local application.
- **That the budgets used here are the right ones.** They were set generously on purpose, to
  measure reach rather than what a budget allowed to finish. Two of the three runs still
  exhausted them.

## Reproducing it

```bash
node test-lab/freight-platform/server.js            # port 4400
node test-lab/freight-platform/selftest.mjs         # 54 checks over HTTP
cd apps/browser-worker && pnpm build                # the crawler, compiled
node ../../test-lab/freight-platform/selftest-browser.mjs      # 17 checks in a browser
node ../../test-lab/freight-platform/measure-discovery.mjs --mode links --budget 600
node ../../test-lab/freight-platform/measure-discovery.mjs --mode navigation --budget 900
node ../../test-lab/freight-platform/measure-discovery.mjs --mode interactive --budget 900
cd ../../test-lab/freight-platform && node analyse-reachability.mjs && node report.mjs
```
