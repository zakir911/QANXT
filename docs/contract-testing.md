# API contracts

A contract test asks a different question from a functional test. A functional test asks
whether the endpoint still works. A contract test asks whether it still answers the *same
shape* — because an endpoint can answer 200, pass every assertion, keep every screen
working, and still have broken every client that parses its response.

- [How it works](#how-it-works)
- [The inventory](#the-inventory)
- [Baselines](#baselines)
- [What a difference means](#what-a-difference-means)
- [Checking a release](#checking-a-release)
- [Quality gates](#quality-gates)
- [Acknowledging a change](#acknowledging-a-change)
- [From the CLI](#from-the-cli)
- [Limitations](#limitations)

## How it works

Three steps, none of which needs an OpenAPI document:

1. **Discovery observes the API.** While crawling the application, AIRA records every
   request the UI made: method, URL template, status, content type, and a masked sample of
   the response. That is the inventory.
2. **You accept a baseline.** AIRA infers the *shape* of each observed response — a flat map
   of JSON path to type — and stores it as the contract for that endpoint.
3. **Every run is compared against it.** When a run finishes, AIRA reads the responses that
   run observed out of its own evidence and compares each one's shape with the baseline.
   Every difference is classified by what it means for a caller.

Nothing in step 3 sends a request. A run already records every response it received, so the
check reads that record. That has three consequences worth knowing:

- It covers **API tests and the calls the UI made while being driven**, from the same
  evidence, with no second pass against the application.
- It costs nothing at run time.
- The check is **reproducible**: because the evidence is stored, the decision a quality gate
  made about a release stays explainable months later, when the application has moved on and
  running the comparison again would come out differently.

## The inventory

```bash
aira contract inventory --app <id>
```

```
METHOD  ENDPOINT                              SEEN  AUTH  BASELINE  TESTS  BREAKING
GET     /api/accounts                           12  auth  v2            1  —
GET     /api/accounts/{id}/transactions          9  auth  v1            1  —
GET     /api/dashboard                          14  auth  v1            0  —
POST    /api/payments                            3  auth  none          0  —

  14 endpoint(s) · 2 called by an API test · 12 with a contract baseline
  12 endpoint(s) have no API test. Generate some with "aira api-test generate --app <id>".
```

`TESTS` is read from what the stored API tests actually call, not from a tag. The gap it
shows is the point of the report: an endpoint the application depends on that nothing
checks is the thing worth knowing.

## Baselines

```bash
aira contract baseline --app <id>
```

A baseline is a **stored observation**, not a specification. It records what the application
answered, which is why contract testing works on an API that has no specification and never
will.

Baselines are **versioned rather than overwritten**. Accepting a changed contract is a
decision with a date and an author, and a table that keeps only the current shape cannot
answer when it moved. Replacing one therefore requires a reason:

```bash
aira contract baseline --app <id> --replace \
  --note "sortCode moved to the payments API in 2.4; the mobile client was updated first"
```

Without `--note`, the replace is refused.

### What a shape records

A flat map of path to type, in the same grammar the response assertions use:

```json
{
  "$": "object",
  "$.accounts": "array",
  "$.accounts[]": "object",
  "$.accounts[].id": "string",
  "$.accounts[].balance": "number",
  "$.accounts[].closedAt": "null|string"
}
```

Three decisions are built into that:

- **Array elements collapse.** Every element of an array folds into one `path[]` entry, so a
  response with two accounts and one with nine are the same contract. Anything else would
  report a breaking change every time the test data changed.
- **Disagreeing element types merge** rather than the last one winning. If one element has a
  string id and another a number, the field is `number|string`, and saying so is the honest
  answer: a caller parsing ids is already at risk.
- **Integers and fractions are both `number`.** An API that starts returning `1` instead of
  `1.0` has not changed its contract, and reporting that it has would train people to ignore
  contract changes.

## What a difference means

This classification is the whole value of the feature. A check that calls every change
breaking gets switched off within a week; one that calls a removed field safe is worse than
having none.

| Difference | Classified | Why |
| --- | --- | --- |
| A field is no longer returned | **breaking** | There is no reading of this that is safe for someone who was reading it |
| A field's type changed (`number` → `string`) | **breaking** | A caller parsing it as the old type fails |
| An object became an array, or vice versa | **breaking** | A caller reading through it does not find what it expects |
| A 2xx became a non-2xx | **breaking** | A caller that relied on it succeeding no longer works |
| A field can now be null | **potentially breaking** | Callers that null-check are fine; callers that do not are broken, and which of those a team has is not something AIRA can know |
| A field gained a second type | **potentially breaking** | A caller assuming one type fails on the other |
| A field only ever seen as null now has a type | **potentially breaking** | The baseline never recorded its real type, so this may not be a change at all |
| A new field appeared | **non-breaking** | Nobody was reading it |
| A field stopped being null | **non-breaking** | A caller that handled null still works |
| One success code became another (200 → 204) | **potentially breaking** | A caller that distinguishes them sees a different result |
| A non-2xx became a 2xx | **non-breaking** | It has started working |

Every difference carries a sentence about callers rather than a diff:

```
breaking  GET /api/accounts
    $.accounts[].sortCode: "accounts[].sortCode" was present as string and is now absent.
                           Any caller reading it will find nothing.

potentially breaking  GET /api/accounts
    $.accounts[].closedAt: "accounts[].closedAt" can now be null. A caller that reads it
                           without a null check will fail on the values where it is.
```

## Checking a release

The check runs **automatically when a run completes**, if the application has baselines. It
is skipped silently when it has none — a check with nothing to compare against would record
"no breaking changes", and that sentence would be read as an assurance rather than as an
absence of information.

To ask again, or to check a run that gained baselines afterwards:

```bash
aira contract check --run <id>
aira contract changes --run <id>        # what it found, without running it again
aira contract check --discovery <id>    # against what a crawl saw, instead
```

`--fail-on` decides what a pipeline does about it:

```bash
aira contract check --run "$RUN_ID" --fail-on breaking               # default
aira contract check --run "$RUN_ID" --fail-on potentially-breaking   # published clients
aira contract check --run "$RUN_ID" --fail-on none                   # report only
```

Exit 0 when nothing is above the threshold, 2 (QUALITY_GATE_FAILURE) when something is.
The right threshold is a team's decision: a team adopting contract checking on an API that
moves every week starts at `breaking`; one with published clients sets
`potentially-breaking` and means it.

## Quality gates

`contractBreakingChangeCount` is measured for a run **only when a contract check actually
ran against it**:

```json
{
  "name": "No breaking contract changes",
  "metric": "contractBreakingChangeCount",
  "operator": "equal",
  "threshold": 0,
  "action": "fail",
  "message": "An API this release publishes has changed in a way that breaks its callers."
}
```

A rule over a metric the run could not measure is never reported as satisfied — it comes
back as REVIEW saying so. That distinction is the difference between a gate that protects a
release and one that has never looked
([BUG-0021](../verification/bugs/BUG-0021/bug.md)).

This is where contract testing earns its place as a gate rather than a report: **every test
can pass and the release still stops**, because the endpoint answered 200 and lost a field.
Golden test CON-008 is exactly that scenario, executed.

## Acknowledging a change

```bash
# through the API; the CLI reports changes, a person accepts them
POST /api/v1/api-contracts/changes/{id}/acknowledge  { "note": "..." }
```

An acknowledgement needs a note of at least ten characters. A rubber stamp is what makes an
audit trail worthless, so a bare "ok" is refused.

An acknowledged change **still counts in its own run's gate** — that decision is already
made — but the same change on a later run comes back already acknowledged and stops failing
builds. Every acknowledgement is audited and logged as a warning.

## From the CLI

A pipeline that checks contracts as well as behaviour:

```yaml
- run: aira run --suite "$SUITE_ID" --report-dir artifacts     # exit 0/1/2/7
- run: aira contract changes --run "$RUN_ID" --fail-on breaking
  if: always()
```

The gate rule and `aira contract check` are two routes to the same finding. Use the gate
rule when contract health should be part of the run's own verdict; use the CLI step when you
want a separate, separately-reportable pipeline stage.

## Limitations

Stated rather than implied:

- **JSON only.** A response that is not JSON has no shape to infer, and an endpoint whose
  content type is not JSON is skipped at baseline time rather than baselined as empty. An
  endpoint that *used* to answer JSON and now does not is reported as breaking.
- **Response shapes, not request shapes.** Request schemas are stored when a sample exists
  but are not yet compared.
- **Bodies are compared as stored**, which means masked and truncated to 8000 bytes. A
  response longer than that is not compared at all rather than compared partially: an
  excerpt that stops mid-document would infer a shape missing every field after the cut, and
  report every one of them as removed.
- **The `responseSchemaMatches` assertion type is not evaluated by the executor.** Contract
  comparison happens in the control plane, where the baseline lives; the executor says so
  rather than answering "passed".
- **Semantics are not checked.** A field that keeps its type and changes its meaning —
  a status string whose values change, an amount that switches from pounds to pence — is
  not a shape change and is not found here. A functional assertion is what finds that.
- **One baseline per endpoint.** There is no per-environment or per-version baseline yet, so
  an API that intentionally differs between staging and production needs separate
  applications.
- **Matching is by method and path template.** A call that matches no template is reported
  as having no baseline rather than attached to the nearest one.

## See also

- [`docs/api-testing.md`](api-testing.md) — API tests, assertions and evidence
- [`docs/ci-cd.md`](ci-cd.md) — the exit-code contract
- `verification/evidence/CON-*/` — the executed evidence behind every claim here
- [`verification/bugs/BUG-0024`](../verification/bugs/BUG-0024/bug.md) — the masking defect
  contract testing found
