# BUG-0020 — Every stored console and network event was orphaned from the step that produced it

| | |
| --- | --- |
| **ID** | BUG-0020 |
| **Title** | `ConsoleEvent.TestActionId` and `NetworkEvent.TestActionId` were never written, so no stored evidence could be attributed to a step |
| **Severity** | **HIGH** |
| **Found by** | Golden test API-003, asserting that an API test's request is recorded against the step that made it |
| **Environment** | See `verification/environment.md` |
| **Build** | `585c679` |
| **Component** | `apps/api/src/Aira.Application/Testing/ExecutionIngestService.cs`, `apps/api/src/Aira.Api/Controllers/TestRunsController.cs` |
| **Reproduction rate** | 2 of 2 |
| **Status** | Fixed and re-verified |

## What happens

The worker tags every console message and every network request with the order of the
action that was running when it happened. `ConsoleEventPayload` and `NetworkEventPayload`
both carry `actionOrder`. `ConsoleEvent` and `NetworkEvent` both have a `TestActionId`
column to hold the link.

`RecordEventsAsync` never set it. Every event ever stored had `TestActionId = null`, and
the two read endpoints did not return the field at all, so nothing downstream could even
notice.

The first run of API-003 reported it plainly:

```
FAIL  API-003  2 exchange(s) recorded: step undefined POST /api/session → 200 in 4ms;
                                       step undefined GET /api/accounts → 200 in 3ms
```

Both requests were there, with their status, duration and body. Neither knew which step
had made it.

## Why it matters

"This step failed, and here is the request underneath it" is the single most useful
sentence a test report can contain, and it was unavailable. A 500 from the API and a UI
assertion failing one action later were two unrelated rows in two lists that happened to
share a timestamp.

It also silently blocked work built on top of it. The architecture assessment for this
phase recorded `NetworkEvent.ActionOrder` as the *existing* join that UI/API correlation
would be built on. It was a column, not a join: nothing had ever populated it.

The same omission applied to console events, so a JavaScript error could not be attributed
to the click that caused it either.

## Root cause

`RecordArtifactsAsync`, immediately above, loads the execution's actions and maps
`payload.ActionOrder` to an action id — exactly the right thing. `RecordEventsAsync`, added
alongside it, does not. Nothing failed, because a null foreign key is valid and no test
asserted on the field.

The read endpoints then projected an explicit column list that omitted `TestActionId`,
which is why the gap survived every manual look at the evidence: the field was not
missing from the response, it was absent from the query.

## Expected

Every stored console and network event carries the id of the action it happened during,
and both read endpoints return that id and the step number beside it.

## Reproduction

```bash
bash test-lab/scripts/lab-ctl.sh start
node verification/bugs/BUG-0020/reproduce.mjs
```

Runs a two-request API test and reports how many of its recorded exchanges know which
step made them. Before the fix: 0 of 2. After: 2 of 2.

## Fix

- `RecordEventsAsync` loads the execution's actions into an order → id map once, and sets
  `TestActionId` on both console and network events from the payload's `actionOrder`. The
  actions are already saved by the time it runs, as `RecordArtifactsAsync` relies on too.
- `GET /testruns/{id}/console` and `GET /testruns/{id}/network` return `testActionId` and
  an `actionOrder` alongside it. The order is included deliberately: an id alone means a
  reader of the log needs a second lookup to answer "which step was this?".

## Re-verification

| | Before | After |
| --- | --- | --- |
| API-003 | FAIL — `step undefined` for both exchanges | **PASS** — `step 1 POST /api/session → 200 in 3ms; step 2 GET /api/accounts → 200 in 3ms` |
| `reproduce.mjs` | 0 of 2 attributed | **2 of 2** |
| Product test suites | pass | pass (57 integration, 216 unit, 99 worker) |
