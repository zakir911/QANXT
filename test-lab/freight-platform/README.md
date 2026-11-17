# Meridian Freight

A synthetic enterprise logistics platform. **137 screens, 13 domains, 6 end-to-end journeys,
32 planted defects.**

It exists for one measurement: what a testing platform reaches, and misses, on an application
of realistic size and shape. The other labs in this directory are small and uniformly
navigable, which makes them good detector tests and poor predictors of anything. The security
report says so itself, as `SECN-003`: *"Detection rate against an application AIRA has not
seen — not measured, and not measurable here."* This lab narrows that gap.

```bash
node test-lab/freight-platform/server.js          # port 4400, defects on
node test-lab/freight-platform/selftest.mjs       # 54 checks: the lab itself works
node test-lab/freight-platform/journeys.mjs       # 6 journeys on the corrected build
node test-lab/freight-platform/journeys.mjs --dirty   # and on the shipped build
node test-lab/freight-platform/build-ground-truth.mjs # regenerate ground-truth.json
```

Sign in with any of `ops.lead`, `warehouse`, `finance`, `customs`, `driver.ops`, `admin`,
`readonly` and the password `Freight!2026`. `suspended` exists and is refused.

## The three navigation shapes

This is the part that makes the lab worth building. An enterprise application is not one
shape; it is all three at once, because it was built over eight years by four teams.

| Shape | Screens | How a person reaches it | How a crawler reaches it |
| --- | ---: | --- | --- |
| **Linked** | 100 | Clicks a link | Follows the `href` |
| **Routed** | 37 | Clicks a sidebar button | Only by clicking, or by being given the URL |
| **Enclosed** | 16 surfaces | Clicks a tab, modal or drawer | Only by clicking. There is no URL |

`fleet`, `routes`, `claims` and `admin` are routed: their nav control is a `<button>` that
calls `history.pushState`, and the body is fetched from `/api/view`. A deep link works, so the
screens are genuinely addressable — there is simply no anchor anywhere in the DOM that points
at them. That is exactly the shape that reduces a link-following crawl to the landing page.

Building the whole thing in shape 1 would flatter any crawler; building it all in shape 2
would condemn every crawler. Neither result transfers to a real application. What transfers is
"it reached 94% of linked screens, 0% of routed screens and 0% of enclosed screens".

## The defects

32, on by default, because a real application you point a tool at has its bugs switched on.

| Category | Count | Category | Count |
| --- | ---: | --- | ---: |
| security | 5 | accessibility | 4 |
| validation | 3 | calculation | 3 |
| authorization | 3 | errorHandling | 3 |
| businessRule | 2 | stateTransition | 2 |
| responsive | 2 | boundary | 1 |
| crossField | 1 | multiStep | 1 |
| reliability | 1 | performance | 1 |

By severity: 13 major, 11 minor, 8 security.

**They were written before any QA NXT generator was read, and not adjusted afterwards.** The
list came from what goes wrong in freight software: unit confusion between kilograms and
pounds, a surcharge applied to the wrong base, a cancellation that orphans a route stop, an
authorization check that lives in the UI and not in the handler. Some of these a testing
platform will certainly catch. Some it will certainly miss. The ones it misses are the useful
output, and arranging the list so that everything is findable would have destroyed that.

`ground-truth.json` carries all 32 with the symptom each one produces.

To measure false positives, clear them:

```bash
curl -s localhost:4400/__faults | jq '{faults: [.faults[].id]}' \
  | jq '.faults | map({key:., value:false}) | from_entries' \
  | curl -s -X POST localhost:4400/__faults -H 'content-type: application/json' -d @-
```

A scan of that build should report nothing.

## The journeys

Six flows that cross domains, because 137 screens that do not connect are a screen gallery
rather than an application. Each step asserts its consequence in a *different* domain from the
one the action happened in.

| | Journey | Domains | Steps | Shipped build |
| --- | --- | --- | ---: | --- |
| J1 | Order to cash | orders → customers → shipments → routes → billing | 10 | breaks on `FP_D06` |
| J2 | Procure to dispatch | orders → warehouse | 7 | completes |
| J3 | Carrier onboarding to first booking | carriers → shipments | 6 | breaks on `FP_D07` |
| J4 | Exception to claim settlement | shipments → dashboard → claims → admin | 8 | breaks on `FP_D19` |
| J5 | Customs hold to release | customs → shipments | 5 | breaks on `FP_D08` |
| J6 | User onboarding to audit trail | admin → claims | 6 | breaks on `FP_D27` |

All six complete on the corrected build; five break on the shipped one. **If the corrected
build cannot complete all six, the lab is broken and nothing measured against it means
anything** — `journeys.mjs` exits non-zero in that case, deliberately.

## What the data is

Deterministic: a fixed-seed generator, so every boot produces byte-identical data. A lab whose
data moves cannot tell a regression from a Tuesday.

Synthetic: documentation-reserved patterns throughout. Sort code `00-00-00`, account numbers in
the `000001xx` range, `203.0.113.x` addresses, `.test` domains, invented company names. The HS
codes are real chapter numbers against invented goods. Nothing here resembles a real freight
operation and no address resolves to a real building.

12 customers · 8 carriers · 4 warehouses · 40 shipments · 26 sales orders · 18 purchase orders ·
16 routes · 30 invoices · 24 declarations · 14 claims · 14 vehicles · 12 drivers · 120 audit entries.

## Files

```
server.js              bootstrap, screen inventory at /__screens, defects at /__defects
core.js                request plumbing; definePage registers one screen for all three shapes
defects.js             the 32 planted defects, with provenance
data/seed.js           deterministic synthetic data
ui/chrome.js           layout, the three navigation shapes, component builders
domains/*.js           13 domain modules
selftest.mjs           54 checks that the lab itself works
journeys.mjs           the 6 end-to-end journeys, corrected and shipped
build-ground-truth.mjs regenerates ground-truth.json from the running application
ground-truth.json      generated; the inventory a measurement reads
```

Nothing here is part of the product and nothing in the product depends on it.

## One honest limitation

The defects were written by the same author who then measures a tool against them. That is
better than the existing labs, where the defects were written alongside the checks that find
them, but it is not the same as a third-party application nobody wrote for the test. A
measurement against this lab is evidence about shape and coverage; it is not a detection rate
that transfers to arbitrary software. The only thing that produces that number is pointing the
tool at applications this repository has never seen.
