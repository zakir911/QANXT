# API testing

QA NXT tests APIs the same way it tests screens: an API test is an ordinary test case whose
steps make HTTP requests instead of driving a browser. That is not a shortcut — it is the
design. Runs, retries, evidence, failure analysis, quality gates, reports, notifications
and the CLI already work on test cases, and they all work on API tests with nothing added.

- [What an API test is](#what-an-api-test-is)
- [Authoring one](#authoring-one)
- [Requests](#requests)
- [Authentication](#authentication)
- [Assertions](#assertions)
- [Chaining requests](#chaining-requests)
- [What the run records](#what-the-run-records)
- [Quality gates](#quality-gates)
- [What QA NXT refuses](#what-qanxt-refuses)
- [From a pipeline](#from-a-pipeline)
- [Limitations](#limitations)

## What an API test is

A test case of kind `api`, whose steps use the `apiRequest` verb. Each step holds a
**request descriptor** — method, path, query, headers, body, authentication, captures — and
the assertions that decide whether the response was right.

Two consequences worth knowing about:

**It appears everywhere a test appears.** The same run can contain UI and API tests. The
same report lists both. The same quality gate covers both, and can treat API failures
separately if you want it to. `qanxt run --suite <id>` runs whatever is in the suite.

**A pure API test opens no browser.** When every step in a test calls an API on its own
credentials, no page is created — the test runs in about the time the requests take. A test
that reuses a UI session does open one, because that is where the session comes from.

## Authoring one

`POST /api/v1/testcases/api-tests`, or through the CLI from a file:

```bash
qanxt api-test add --file api-tests.json
qanxt api-test list
qanxt api-test run
```

The file:

```json
{
  "applicationId": "…",
  "suiteName": "API — accounts",
  "tests": [{
    "name": "A signed-in customer can read their accounts",
    "objective": "The accounts endpoint answers for an authenticated session",
    "priority": "high",
    "tags": "smoke",
    "steps": [
      {
        "description": "Sign in through the API",
        "request": {
          "method": "POST",
          "path": "/api/session",
          "contentType": "application/json",
          "body": "{\"username\":\"alice\",\"password\":\"${secret:app_password}\"}",
          "auth": { "mode": "none" }
        },
        "assertions": [
          { "type": "httpStatusEquals", "expected": "200" },
          { "type": "responseJsonPathEquals", "subject": "user.username", "expected": "alice" }
        ]
      },
      {
        "description": "Read the accounts that session can see",
        "request": {
          "method": "GET",
          "path": "/api/accounts",
          "auth": { "mode": "none" },
          "capture": { "accountId": "accounts[0].id" }
        },
        "assertions": [
          { "type": "httpStatusEquals", "expected": "200" },
          { "type": "responseJsonPathExists", "subject": "accounts[0].balance" },
          { "type": "responseTimeUnderMs", "expected": "2000" }
        ]
      }
    ]
  }]
}
```

Each test in the file is sent separately and reported separately: a file of twelve tests
with one malformed entry saves eleven and tells you exactly what is wrong with the twelfth.
`qanxt api-test add` exits 3 (CONFIGURATION_ERROR) if any test was rejected.

## Requests

| Field | Meaning |
| --- | --- |
| `method` | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, `OPTIONS`. Nothing else. |
| `path` | Relative to the environment's API base URL (`/api/accounts`), or absolute. An absolute URL is checked against the application's allowed hosts when the test is saved as well as when it runs. |
| `query` | Appended to the path. Values may contain references. |
| `headers` | Sent as given. `Host`, `Content-Length`, `Connection` and `Transfer-Encoding` are refused — a test cannot override them. |
| `body` | Sent as given. `contentType` defaults to `application/json` when a body is present. |
| `timeoutMs` | Up to 300000. Defaults to the project's action timeout. |
| `failOnErrorStatus` | Defaults to **true**: a 4xx or 5xx fails the step. Set `false` for a negative test that asserts the error itself. |
| `capture` | `{ "name": "json.path" }` — see [chaining](#chaining-requests). |

The **environment** supplies the base URL. `apiBaseUrl` on the environment is where
relative paths resolve; if it is unset, the UI base URL is used, which is right when the
API is served from the same origin. An API base URL on another host is added to the run's
allowlist explicitly, so it is a configured origin rather than a widened guard.

## Authentication

`auth.mode` picks one. Each mode does exactly what its name says, which matters most for
the two that mean "nothing".

| Mode | What is sent |
| --- | --- |
| `inheritSession` | The cookies the browser holds. This is how "sign in through the UI, then call the API as that user" is expressed. Needs a page, so the test opens one. |
| `none` | No credentials from QA NXT. Cookies the test itself obtained from an earlier request in the same test still apply, as they would for any HTTP client. |
| `bearer` | `Authorization: Bearer <token>`. The token must be a `${secret:…}` reference. |
| `basic` | `Authorization: Basic …`. The password must be a reference. |
| `apiKeyHeader` | A header you name, with a referenced value. |
| `apiKeyQuery` | A query parameter you name, with a referenced value. |
| `oAuth2ClientCredentials` | Exchanges client credentials at `tokenUrl` for an access token, then sends it as a bearer. The token endpoint is checked against the same allowlist as everything else; the token is registered with the masker the moment it arrives and never stored. |

`inheritSession` requests go through the browser's own HTTP client. Every other mode goes
through a separate client that starts empty. That separation is what makes a negative test
honest: a step that says it sends no credentials cannot be quietly satisfied by a session
the UI established two steps earlier.

That separate client lasts for the whole test, not for one request, so an API-only sign-in
works:

```
POST /api/session  → 200, sets a cookie
GET  /api/accounts → 200, carries it
```

## Assertions

Every assertion is evaluated against the response. There are eight types, and there are
eight because these are the eight the executor can actually evaluate — a stored assertion
that nothing can check is a test that cannot fail.

| Type | `subject` | `expected` | Holds when |
| --- | --- | --- | --- |
| `httpStatusEquals` | — | `200` | the status is exactly that |
| `responseStatusIn` | — | `2xx`, `200,201,204`, `200-204` | the status matches any part |
| `responseTimeUnderMs` | — | `2000` | the response arrived sooner |
| `responseBodyContains` | — | text | the body contains it |
| `responseJsonPathExists` | `accounts[0].id` | — | the value is present and not null |
| `responseJsonPathEquals` | `user.username` | `alice` | the value equals it |
| `responseJsonPathMatches` | `accounts[0].id` | `^acc-\d+$` | the value matches the pattern |
| `responseHeaderEquals` | `content-type` | `application/json` | the header is exactly that |

`subject` is the JSON path, or the header name for `responseHeaderEquals`.

The **path grammar is deliberately small**: dotted names and numeric indexes,
`data.accounts[0].balance`, optionally prefixed `$.`. No wildcards, no recursive descent, no
filter expressions. A path with a filter in it produces a test whose behaviour nobody
reviewing it can predict, and a failure message that can no longer say which value was
wrong. It also cannot reach an inherited property: `toString` is not data the API returned.

Every failure says what was expected **and what was there**:

```
The first account is in US dollars: Expected "accounts[0].currency" to be USD but it was GBP.
Expected the response within 1ms but it took 4ms.
Expected header "content-type" to be "text/csv" but it was "application/json; charset=utf-8".
```

`isSoft` records a failure and lets the test continue. `negate` inverts the assertion, and
a negated assertion that holds says so explicitly rather than reporting a bare pass.

## Chaining requests

`capture` pulls values out of a response into the test's data, where later steps read them
as `${data:name}`:

```json
{ "method": "POST", "path": "/api/payments", "capture": { "paymentId": "payment.id" } }
{ "method": "GET",  "path": "/api/payments/${data:paymentId}" }
```

References are substituted **anywhere** in a path, a query value, a header value or a body —
not only when they are the whole field. An unknown name fails the step with a message
naming it, rather than sending the placeholder and producing a 404 that reads like a missing
route (that was [BUG-0022](../verification/bugs/BUG-0022/bug.md)).

## What the run records

For every request, whether it passed or failed:

- a **network event** carrying the method, URL, status, duration, request and response
  sizes, masked headers and a masked body excerpt — tagged with the step that made it, in
  the same log the browser's own calls go into. That shared log is what lets a report say
  "this UI step failed and here is the API call underneath it".
- an **exchange file** (`step-N-request.http.json`) in the execution's artifacts, so a
  failure can be read without the database.

A request that never completes — DNS, refused connection, TLS, timeout — is recorded too,
with the transport error, rather than leaving a gap where an attempt was.

Secrets never reach any of it. A referenced token is sent and then redacted in the record:
the evidence shows that the header was sent without showing what it was.

## Quality gates

`apiFailedCount` is measured for every run, so a rule can treat API failures as their own
concern:

```json
{
  "name": "No failing API tests",
  "metric": "apiFailedCount",
  "operator": "equal",
  "threshold": 0,
  "action": "fail",
  "message": "An API endpoint this release depends on is broken."
}
```

"The UI is fine but two endpoints are broken" and "two UI journeys are broken" are
different releases, and a gate should be able to say which it is looking at.

`contractBreakingChangeCount` is measured for the same run when a contract check ran against
it, so a release can be stopped by an API changing shape even though every test passed.
See [`docs/contract-testing.md`](contract-testing.md).

A rule over a metric this release could not measure is **never** reported as satisfied. It
comes back as REVIEW with an explanation saying the metric was not measured — see
[BUG-0021](../verification/bugs/BUG-0021/bug.md) for why that matters more than it sounds.

## What QA NXT refuses

At authoring time, with every problem named rather than the first one:

- **A test that asserts nothing.** A step with no assertions that also tolerates error
  statuses cannot fail whatever the application does.
- **A page assertion on an API step.** `visible` cannot be evaluated against a response.
  Storing it would be a check that never runs. The executor refuses it too, so a test
  written around the API is not silently green.
- **A credential written into the test.** A literal bearer token, a pasted
  `Authorization` header, a password in a body. Use `${secret:name}`.
- **A request outside the application's allowed hosts**, checked when the test is saved and
  again at the moment of the call. A discovered endpoint is not a licence to call it.
- **A header the engine owns**, or a header value containing a line break.
- **A JSON path it cannot evaluate predictably**, in an assertion or a capture.
- **An unsupported method.** The set is closed.

At run time:

- **A write where the environment forbids one.** `POST`, `PUT`, `PATCH` and `DELETE` are
  refused before the request is sent in any environment that does not permit destructive
  tests — which is every production environment unless someone says otherwise. The step
  fails with the reason, and nothing reaches the application.
- **Production without authorization.** A run pinned to a production environment is refused
  unless testing it has been authorized on that environment, with a note and an author on
  the record.

## From a pipeline

```yaml
- run: qanxt api-test add --file api-tests.json      # keep the tests in the repo
- run: qanxt api-test run --report-dir artifacts     # exit 0 / 1 / 2 / 7
```

`qanxt api-test run` uses the same exit-code contract as `qanxt run`: 0 PASS,
1 TEST_FAILURE, 2 QUALITY_GATE_FAILURE, 7 HUMAN_REVIEW_REQUIRED, 3 CONFIGURATION_ERROR,
4 AUTHENTICATION_ERROR, 5 INFRASTRUCTURE_ERROR. A project with no enabled API tests exits
3, not 0: "there were no tests" and "the tests passed" are different answers.

## Limitations

Stated rather than implied:

- **REST and JSON.** There is no GraphQL, gRPC or SOAP support. A GraphQL endpoint can be
  called as a `POST` with a JSON body, and its response asserted with JSON paths, but there
  is no query-aware handling.
- **Schema comparison is not an assertion.** The `responseSchemaMatches` assertion type
  exists in the enum, and the executor answers it honestly: "Schema comparison is performed
  by the contract check, not by the executor." Contract testing is implemented — see
  [`docs/contract-testing.md`](contract-testing.md) — but it runs in the control plane over
  the evidence a run produced, where the baseline lives, rather than inside a step.
- **No request retry inside a step.** The run-level retry applies to the whole test.
- **Bodies are stored as excerpts** — the first 8000 bytes, masked. A larger response is
  asserted on in full but not archived in full.
- **One assertion per response cannot be repeated with different subjects** in a single
  step's `expected` field; write one assertion per thing you are checking, which is what the
  list is for.

## See also

- [`docs/contract-testing.md`](contract-testing.md) — API contracts and breaking-change detection
- [`docs/ci-cd.md`](ci-cd.md) — the exit-code contract and pipeline configuration
- [`docs/user-manual.md`](user-manual.md) — the console, screen by screen
- `verification/evidence/API-*/` — the executed evidence behind every claim here
- `verification/bugs/BUG-0019`…`BUG-0023` — the defects found building it
