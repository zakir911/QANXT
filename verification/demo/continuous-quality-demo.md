# Continuous quality — one release cycle

Recorded 2026-09-23T12:36:29.462Z. Every number here came from the run that produced it;
the faults are real faults in the banking lab, switched on through its own API.

## 01. Check the platform, the application and the notification sink are up

    A demonstration that starts its own dependencies hides whether they work.
    AIRA healthy · AIRA Demo Bank 1.0.0 healthy · notification sink healthy

## 02. Set up a team: an organization, a project, a staging environment

    project G6LBK17 · application 81fa90e4 · environment staging
    The environment carries the authorization boundary: AIRA will not open a URL outside it.

## 03. Discover the application

    A real crawl, not a fixture.
    11 page(s) discovered

## 04. Tell somebody when things break

    A run that fails at 2am and tells nobody did not happen.
    webhook configured (201); failures and blocked gates are sent, green runs are not

## 05. Set the bar

    The gate is the thing that decides, and it is written down before the release.
    2 rules: "No failing tests" and "No breaking API changes", both blocking

## 06. The suite a team would actually have

    3 test(s): 2 browser journeys and 1 API test, in one suite and one engine

## 07. Release 1.0 goes out

    The green run everything afterwards is measured against.
    run passed: 3 passed, 0 failed
    14 contract baseline(s) captured from responses the application actually gave
      GET http://localhost:4300/api/accounts/acc-1002 → status 200, 11 field(s)
      GET http://localhost:4300/api/accounts/acc-1003/transactions?page={v}&pageSize={v} → status 200, 15 field(s)
      GET http://localhost:4300/api/accounts → status 200, 12 field(s)
      POST http://localhost:4300/api/session → status 200, 5 field(s)
      GET http://localhost:4300/api/accounts/acc-1001/transactions?page={v}&pageSize={v} → status 200, 15 field(s)
      GET http://localhost:4300/api/accounts/acc-1003 → status 200, 11 field(s)
      GET http://localhost:4300/api/accounts/acc-1001 → status 200, 11 field(s)
      GET http://localhost:4300/api/accounts/acc-1002/transactions?page={v}&pageSize={v} → status 200, 15 field(s)
      GET http://localhost:4300/api/session → status 200, 5 field(s)

## 08. A developer changes the accounts API

    Two things at once, the way a real change arrives: a field disappears, and a balance is wrong.
    FAULT_API_FIELD_REMOVED: the accounts API stops returning sortCode — breaking for any caller reading it
    FAULT_WRONG_BALANCE: the dashboard renders a total that does not match the accounts

## 09. Teach it what the code touches

    Change impact needs a map from paths to what they affect. Without one, every change runs everything.
    src/api/accounts/** → route /accounts (200)
    src/pages/dashboard/** → route /dashboard (200)

## 10. Regression selection: what does this change reach?

    Running everything on every commit is how a suite stops being run at all.
    2 of 3 test(s) selected, mode impacted
      TC-0001 scored 50: This test exercises /dashboard, which the change affects.
      TC-0002 scored 50: This test exercises /accounts, which the change affects.
      not selected: TC-0003 scored 10

## 11. The pipeline runs

    The same command a CI job would run, against the changed build.
    run failed: 2 passed, 1 failed

## 12. The contract check finds what moved

    1 contract change(s), 1 of them breaking, against the Release 1.0 baseline
      GET http://localhost:4300/api/accounts [? → ?] $.accounts[].sortCode: "accounts[].sortCode" was present as string and is now absent. Any caller reading it will find nothing.

## 13. The quality gate blocks the build

    Written down before the release, applied without discussion.
    gate outcome: FAIL
      No failing tests: measured 1 against 0 — The number of failed tests was 1, which fails being at most 0.
      No breaking API changes: measured 1 against 0 — The number of breaking API contract changes was 1, which fails being at most 0.

## 14. The team is told

    And the platform can show that it told them.
    3 delivery record(s) on the platform
    3 request(s) actually arrived at the receiving end
      QualityGateBlocked — signed sha256=e6dd3402dafd1…
      RunFailed — signed sha256=b32a1dd0886da…
      BreakingContractChange — signed sha256=dff926061bdff…

## 15. What changed since the release we shipped?

    The question a release decision is actually made on — not "what is broken", but "what got worse".
    newly failing 1 · fixed 0 · still failing 0 · still passing 2
    1 test(s) that used to pass now fail.

## 16. Who asked for all this?

    The governance record, readable through the product.
    16 audit record(s) · 10 distinct action(s)
    including: testRunStarted, configurationChanged, testCaseCreated, qualityGateChanged, integrationConfigured, discoveryStarted

## 17. Fix it

    The same suite, unedited, against a corrected build.
    run passed: 3 passed, 0 failed
    gate outcome: PASS
    contract: 0 breaking change(s) remain against the Release 1.0 baseline
    against the broken build: fixed 1, newly failing 0

## 18. Keep watching

    Regression that happens when nobody commits.
    "Nightly regression" — 0 2 * * * (Europe/London)
    next: 2026-09-24T02:00:00+01:00, 2026-09-25T02:00:00+01:00, 2026-09-26T02:00:00+01:00
    Three consecutive failures disable it, with the reason recorded — a schedule that stopped
    running is worse than no schedule, because it looks armed.

## What this demonstrates

A change landed, and without anybody deciding what to check: the tests it reached were
selected and scored, the pipeline ran them, the contract check named the field that
disappeared, the gate blocked the build against a rule written before the release, the
team was told and the delivery was recorded, and the release comparison said exactly what
got worse rather than what was broken. Then it was fixed, the gate opened on the same
unedited suite, and a schedule took over watching.
