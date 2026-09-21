# Test Lab and Golden Verification plan

The purpose of this phase is a single, defensible claim: **AIRA works, and here is the
physical evidence.** Everything below exists to make that claim falsifiable by someone who
did not write it.

The chain being proven, end to end:

```
Real web application → Discovery → Application model → AI test generation → Review
→ Playwright execution → Evidence → Failure detection → AI root-cause analysis
→ Self-healing (and refusal to heal) → Quality report
```

Every arrow produces an artifact on disk with a SHA-256 hash.

---

## 1. Principles

1. **Real applications only.** Every lab application serves real HTML, runs real JavaScript,
   exposes real HTTP APIs and holds real (synthetic) state. No screenshots pretending to be
   applications, no fixtures pretending to be pages.
2. **Ground truth is written before measurement.** Each application declares what it
   contains. Discovery is then *scored* against that declaration — precision, recall, and
   the actual names of what was missed.
3. **A test passes only if it ran.** The action executed, the expected behaviour was
   observed, the assertion passed, and the evidence exists. Anything else is a failure or
   NOT VERIFIED, never a pass.
4. **The most important number is the false-healing rate.** A healer that always finds
   something is worse than no healer. Ten scenarios exist specifically to be refused.
5. **A failing golden test is a bug report first.** Reproduce twice, classify, then fix.
   Never edit a test to make it pass.
6. **Nothing existing is rewritten to make verification easier.** The lab is additive.

---

## 2. The lab

```
/test-lab
  /shared              fault engine, HTTP kit, session auth, seed data, ground-truth schema
  /banking-app         React SPA + JSON API          port 4300
  /ecommerce-app       server-rendered + client JS   port 4310
  /forms-app           every input type, validation  port 4320
  /dynamic-app         SPA built to be hostile       port 4330
  /failure-app         HTTP status and error matrix  port 4340
  /self-healing-app    locator-drift laboratory      port 4350
  /scripts             start/stop/health/reset
  /test-data           seed data shared by the apps
  README.md
```

All six run from one command (`test-lab/scripts/lab-ctl.sh start`), all bind to
`127.0.0.1`, and all answer `/health` with their fault state.

### 2.1 Fault injection

One engine in `/test-lab/shared/faults.js`, used by every application.

- Declared per application as a list of fault ids with descriptions and default `false`.
- Set three ways, in ascending precedence: environment (`FAULT_LOGIN_BUTTON_RENAMED=true`),
  the admin endpoint (`POST /__faults {"FAULT_X": true}`), and a reset
  (`POST /__faults/reset`).
- `GET /__faults` returns the full registry with current values — which is also how a test
  discovers the fault list rather than hard-coding it. (The last verification pass was
  contaminated exactly once by a hard-coded switch list; that mistake is not repeated.)
- No application source is edited to produce a fault.

The catalogue required by the brief, all independently settable:

| Fault | Effect |
| --- | --- |
| `FAULT_LOGIN_BUTTON_RENAMED` | "Login" becomes "Sign In"; test id changes too |
| `FAULT_LOGIN_BUTTON_REMOVED` | The submit control does not exist at all |
| `FAULT_API_500` | The login API returns HTTP 500 |
| `FAULT_API_TIMEOUT` | The login API delays past any sane timeout |
| `FAULT_WRONG_BALANCE` | The dashboard renders an incorrect balance |
| `FAULT_STATEMENT_FAILURE` | Statement generation fails |
| `FAULT_INVALID_VALIDATION` | A validation message states the wrong rule |
| `FAULT_DYNAMIC_LOCATOR` | Element identifiers change between sessions |
| `FAULT_SLOW_ELEMENT` | An element appears after a configurable delay |
| `FAULT_JS_ERROR` | A JavaScript error is thrown in the page |
| `FAULT_NETWORK_ERROR` | A request fails at the network layer |

### 2.2 Applications

**Banking (`AIRA Demo Bank`, React).** Nine routes — `/login`, `/dashboard`, `/accounts`,
`/accounts/:id`, `/transactions`, `/statements`, `/payments`, `/beneficiaries`, `/profile`.
Real client-side routing, asynchronous data loading with loading states, modals, tables,
pagination, dropdowns, form validation, session timeout, account lock after repeated bad
passwords. Some identifiers are deliberately generated per session so that fixed-id
automation is not enough.

**Commerce.** Login → search → product → cart → quantity → coupon → checkout → address →
payment simulation → confirmation, with delayed APIs, modals and pagination.

**Forms.** Text, number, date, date range, select, multi-select, checkbox, radio, file
upload, textarea, dependent fields, cross-field validation. Valid and invalid paths both
reachable. This is the generation-quality target.

**Dynamic.** Dynamic ids, elements that appear and disappear, asynchronous rendering,
nested components, dialogs, tabs, delayed content, infinite scrolling, a DOM hierarchy that
changes between renders. Its purpose is to make naive locators fail.

**Failure.** Deterministic HTTP 400/401/403/404/500, timeout, connection reset, JavaScript
error, wrong UI value, missing element — each on its own route so a classifier can be scored
per class.

**Self-healing.** The smallest possible application whose only job is locator drift:
a baseline control, a renamed control, a removed control, an ambiguous pair of equally
plausible controls, and a control whose meaning changed while its label stayed.

### 2.3 Ground truth

`/test-lab/<app>/ground-truth.json`, one schema across all six:

```json
{
  "application": "AIRA Demo Bank",
  "baseUrl": "http://localhost:4300",
  "pages":    [{ "path": "/login", "title": "...", "requiresAuth": false, "elements": [...] }],
  "elements": [{ "testId": "username", "role": "textbox", "name": "Username", "page": "/login" }],
  "workflows":[{ "id": "WF-BANK-01", "name": "Sign in and read the balance", "steps": [...] }],
  "expectedApiCalls": [{ "method": "POST", "path": "/api/session" }],
  "knownFaults":      [{ "id": "FAULT_LOGIN_BUTTON_RENAMED", "affects": ["/login"] }],
  "expectedFailures": [{ "fault": "FAULT_API_500", "classification": "applicationError" }]
}
```

Discovery is scored against `pages`, `elements` and `expectedApiCalls`; generation against
`workflows`; failure classification against `expectedFailures`.

---

## 3. The golden suite

```
/verification/golden-tests
  /discovery      15+   pages, elements, forms, APIs, navigation, precision/recall
  /generation     15+   requirement → test → executes and asserts something real
  /execution      20+   every action type, three engines, waits, retries, uploads
  /assertions     10+   text, value, visibility, URL, negation, soft assertions
  /failure-analysis 10+ detection and classification per failure class
  /self-healing   10+   positive, negative, ambiguity, threshold, policy, audit
  /api             5+   the platform's own API behaviour under a golden lens
  /authentication  5+   lab auth flows: lock, timeout, invalid credentials
  /security        5+   unauthorized access, tenant isolation, JWT, injection, SSRF
  /reliability     5+   repeatability, flakiness, AI failure modes, recovery
  /browser-compatibility  Chromium / Firefox / WebKit parity
```

Each test is a declaration plus a function:

```js
{
  id: 'HEAL-Gold-004',
  objective: 'A removed control is not healed to an unrelated one',
  preconditions: ['self-healing app running', 'FAULT_LOGIN_BUTTON_REMOVED enabled'],
  input: 'The unchanged baseline test',
  expected: 'Run fails; no healing event; candidates recorded with the reason',
  evidence: ['result.json', 'screenshot.png', 'ai-analysis.json'],
  severity: 'critical'
}
```

`severity: critical` is what `--exit-non-zero-on-critical` keys off, and what the quality
gates read.

### 3.1 Evidence

`/verification/evidence/<TEST-ID>/<RUN-ID>/` — never overwritten, always containing
`metadata.json` (test id, timestamp, build commit, browser, application version, result,
duration) plus whatever the test declared. Hashes go into the evidence index.

### 3.2 Metrics

| Metric | Definition |
| --- | --- |
| Discovery precision | discovered ∩ ground truth ÷ discovered |
| Discovery recall | discovered ∩ ground truth ÷ ground truth |
| Generation yield | generated tests that execute and assert ÷ generated |
| Healing success rate | correct heals ÷ healing opportunities |
| **False-healing rate** | incorrect heals ÷ healing opportunities — **target 0%** |
| False-pass rate | runs reported passed that should have failed — target 0% |
| False-negative rate | runs reported failed that should have passed — target 0% |
| Flakiness | verdict variance across 20 repetitions |

The healing figure is always reported as four counts — correct heals, correct rejections,
incorrect heals, incorrect rejections — so a single percentage can never hide a wrong heal.

---

## 4. Running it

```
scripts/run-golden-tests --suite discovery|generation|execution|healing|security|--all
scripts/run-product-demo        the twelve-step demonstration, recorded
scripts/verify-product          infrastructure → lab → AIRA → suite → evidence → reports → certification
```

`verify-product` exits non-zero unless every critical gate passes.

Reports: `verification/reports/golden-test-report.{html,json}` and
`GOLDEN-TEST-REPORT.md`, plus `verification/reports/AIRA-CERTIFICATION.md` answering the ten
certification questions with a test id, a result and an evidence path each.

A **Verification Center** page in the console reads the JSON report and shows the gates:
functional, discovery, AI, self-healing, security, reliability, evidence. Overall status is
green only if every critical gate is green.

---

## 5. Milestones

| # | Deliverable | Done when |
| --- | --- | --- |
| M1 | This plan and the current-state assessment | Committed |
| M2 | Shared kit, fault engine, banking app, its ground truth | The app serves, faults toggle, health reports state |
| M3 | Commerce, forms, dynamic, failure, self-healing apps + ground truth | All six run from one command |
| M4 | Golden harness, evidence system, runner; discovery + execution suites | Suites execute against the lab and produce evidence |
| M5 | Generation, assertions, failure analysis, healing, security, reliability | 100+ tests executing |
| M6 | Reports, dashboard, demo, certification, `verify-product` | One command produces the certification |

At every milestone: build, run, test, collect evidence, fix, re-test, document. A milestone
is not complete because the code exists.

---

## 6. What this plan does not promise

- It does not promise 100% pass on first run. Findings are the point; each becomes a bug
  report under `verification/bugs/`.
- It does not promise CI/CD execution — no runner is reachable from this environment. That
  stays NOT VERIFIED and is stated as such in the certification.
- It does not promise performance numbers beyond what is measured here, on this machine,
  with this hardware recorded alongside.
