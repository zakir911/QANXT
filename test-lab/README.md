# The QA NXT test lab

Six real web applications with known behaviour, controlled faults and hand-written ground
truth. They exist so that claims about QA NXT can be *measured* rather than asserted: if the
platform says it discovered nine pages, there is a file here that says how many there are.

Nothing in this directory is part of the product. Nothing in the product depends on it.

```
test-lab/
  shared/            HTTP kit, fault engine, session store, page furniture
  test-data/         seeded synthetic data (identical on every run)
  banking-app/       React single-page bank + JSON API        127.0.0.1:4300
  ecommerce-app/     shop, basket, coupon, checkout           127.0.0.1:4310
  forms-app/         every input type, real validation        127.0.0.1:4320
  dynamic-app/       built to defeat brittle locators         127.0.0.1:4330
  failure-app/       one page per failure class               127.0.0.1:4340
  self-healing-app/  one control, eight ways                  127.0.0.1:4350
  notification-sink/ a receiver, so delivery can be observed      127.0.0.1:4360
  ci-simulation/     a CI pipeline, with no CI system
  scripts/           start, stop, smoke, audit
```

`notification-sink/` is not an application under test either. It is an HTTP server that
accepts QA NXT's notification deliveries and keeps them, so that "QA NXT sent the message" is
something a test observes rather than infers from the sending code. It is deliberately not
a mock of Slack: it does not pretend to be any particular service, and nothing it records
licenses a claim about how a real service would respond.

`ci-simulation/` is not an application under test. It is a pipeline that drives QA NXT
against the applications above, so that the CI integration is something that has been run
rather than something that has been written. See its own README.

## Running it

```bash
pnpm --filter @qa-nxt/test-lab build      # builds the React bank (once)
bash test-lab/scripts/lab-ctl.sh start  # starts all six
bash test-lab/scripts/lab-ctl.sh status
bash test-lab/scripts/lab-ctl.sh reset  # every fault off, every application's state cleared
bash test-lab/scripts/lab-ctl.sh stop
```

Every application answers `GET /health` with its name, version and current fault state, and
`POST /__reset` puts it back to a known state.

## Faults

A fault is a named, independently settable deviation from correct behaviour. No application
source is edited to produce one — the same build serves both the healthy and the broken
case, which is what makes "the defect was injected into the application that just passed" a
true statement.

```bash
curl localhost:4300/__faults                     # the catalogue, with current values
curl -X POST localhost:4300/__faults  -d '{"FAULT_LOGIN_BUTTON_RENAMED":true}' \
     -H 'content-type: application/json'
curl -X POST localhost:4300/__faults/reset       # everything off
FAULT_API_500=true node test-lab/banking-app/server.js   # or from the environment
```

Ask the application what it can be asked to do rather than keeping a list elsewhere: a
hard-coded list silently stops covering a fault the moment one is added.

`test-lab/scripts/smoke-faults.mjs` proves every declared fault actually changes the
banking application. It is run as part of the lab's self-test.

## Ground truth

Each application ships `ground-truth.json`: the pages it has, the elements on them, the
workflows it supports, the API calls it makes, the faults it can exhibit and — for each
fault — whether healing it would be correct or dangerous.

Ground truth is **written by hand**. Deriving it from the application, or worse from the
product's own discovery output, would make every measurement circular.

Because a wrong yardstick is worse than none, it is audited against the running
applications before anything is scored:

```bash
node test-lab/scripts/audit-ground-truth.mjs test-lab/*/ground-truth.json
```

That visits every declared page in a real browser and looks for every declared element.

## What each application is for

| Application | What it proves |
| --- | --- |
| **banking-app** | The main subject: discovery, generation, execution and evidence against a realistic React SPA with asynchronous data, modals, pagination and validation. |
| **ecommerce-app** | A multi-step journey where each step depends on the last, plus a silent-failure case (a coupon that is accepted and never applied). |
| **forms-app** | Whether generated tests find the *rules* — dependent fields, a cross-field date rule, a file size limit — rather than only the fields. |
| **dynamic-app** | Whether locators survive regenerated ids, a changing hierarchy, lazy panels, late content and infinite scroll. |
| **failure-app** | Whether each failure class is detected and classified correctly: 400/401/403/404/500, timeout, dropped connection, JavaScript error, wrong value, missing element. |
| **self-healing-app** | Whether healing happens when it should and — the part that matters — is refused when it should not: a removed control, two equally plausible controls, a control whose meaning changed, and a decoy. |

## Data

`test-data/bank.js` generates 480 transactions across four accounts from a fixed seed. The
running balance is walked forward in date order, so the newest transaction's balance is the
account balance and a statement's lines tie out against its totals. Every run sees the same
numbers.

None of it is real. The names, sort codes, account numbers and amounts are invented, and no
external system is involved.
