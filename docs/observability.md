# Observability

When a run fails, three questions follow in order: *what happened*, *who asked for it*, and
*where did it go wrong*. AIRA answers them with three different records, deliberately kept
apart — logs say what happened, the audit trail says who asked, and evidence says where.
Mixing them produces a system where the only way to reconstruct an incident is to read
everything.

## The correlation id

Every request through the API is given a correlation id, and that id is the thread the other
two records hang from.

```bash
curl -i "$AIRA_API_URL/api/v1/projects" -H "authorization: Bearer $AIRA_TOKEN" | grep -i correlation
# x-correlation-id: 5f4d3c2b1a0947e8b6c5d4e3f2a19087
```

`CorrelationMiddleware` accepts an inbound `X-Correlation-Id` if the caller supplied one and
it is 64 characters or shorter, and mints a new one otherwise. Either way the value is
echoed on the response, pushed onto the Serilog `LogContext` alongside the ASP.NET
`RequestId`, and carried on the execution job written to Redis. The worker reads it off the
job and attaches it to every line its own logger writes, so a single id spans:

```
CLI → API request log → audit record → queue job → worker log → execution row → evidence
```

The CLI does not mint correlation ids of its own; it surfaces the one the API returns. When
an API call fails, the id comes back inside the problem body and the CLI prints it with the
error, which is the id to search on:

```
Run could not be started: the platform returned an unexpected error. (correlation 5f4d3c2b…)
```

That is intentional. An id invented by a client that never reaches the server is a worse
diagnostic than no id, because it looks authoritative.

## Logs

The API logs through Serilog to the console as a structured line per event, enriched with
`Service=aira-api`, the correlation id and the request id. The verbosity is configuration,
not code:

```jsonc
// appsettings.json, or Logging__MinimumLevel in the environment
{ "Logging": { "MinimumLevel": "Debug" } }
```

`Microsoft.AspNetCore` and EF Core's command logger are held at `Warning` regardless, because
at `Debug` they bury everything else under routing and SQL. Request logging is a single
summary line per request — `GET /api/v1/projects responded 200 in 12.4ms` — rather than the
default four-line framework version.

The browser worker writes newline-delimited JSON on stdout, one object per event, carrying
`correlationId`, `executionId`, `jobId`, `testCaseId`, `projectId` and `tenantId` where each
is known. It is JSON rather than prose because the worker's output is the thing most likely
to be shipped somewhere and queried.

Neither logger is trusted to be careful with what it is handed. Values pass through
`SecretMasker` before they reach a log line, and the masker runs again server-side on
anything persisted. See [Secrets and masking](#secrets-and-masking) below.

## Health

Three endpoints, and the distinction between them matters when something is wrong:

| Endpoint | Checks | Use it for |
| --- | --- | --- |
| `/live` | nothing | Liveness. Answers only "is the process running". |
| `/ready` | PostgreSQL, Redis | Readiness. Answers "can this instance serve traffic". |
| `/health` | everything registered | A human, or a dashboard. |

`/live` deliberately checks no dependency. A database outage is not a reason for an
orchestrator to restart the API — restarting it will not bring the database back, and a
restart loop during an outage turns one broken component into two.

## The audit trail

`AuditLog` is an append-only record of the actions that a security or governance review would
ask about: who logged in and who failed to, who changed a role, who configured an
integration or a secret, who changed a quality gate, who approved or rejected a healing
proposal, who started a run — and, because schedules fire with nobody present, who created,
changed or deleted a schedule, when one fired, and when one disabled itself.

Each record carries the organization and project, the acting user and their email, the
action, the entity type and id, a human summary, optional before/after `ChangesJson`, the
correlation id, whether the action succeeded, and when it occurred. Failure is recorded as
explicitly as success: `LoginFailed` is an audit action, not a log line, because a run of
them is the thing you most want to be able to query.

Two design decisions are worth stating plainly.

**Auditing never fails the operation it audits.** `AuditLogger` writes in its own unit of
work and swallows its own exceptions to an error log. A failure to record an audit row does
not turn a successful role change into a failed one — nor, in the other direction, does it
let a failed one look successful. The alternative, a transaction spanning both, means an
audit-table problem takes the product down.

**There is no update or delete path.** The API exposes none, and the database role the
application uses is granted `INSERT` and `SELECT` on the table only. Append-only is a
property of the deployment, not a convention the code is trusted to keep.

Summaries and change payloads are masked with the same `SecretMasker` used everywhere else
before they are stored, so configuring a secret produces an audit record that says a secret
was configured without recording the secret.

### Reading it

```bash
aira audit list --limit 50            # the most recent records
aira audit list --failed              # only what did not succeed
aira audit list --action scheduleFired
aira audit trace <correlation-id>     # everything one request did
aira audit actions                    # the action names this build records
```

or over HTTP:

```
GET /api/v1/audit?action=&entityType=&entityId=&correlationId=&userEmail=&projectId=
                 &succeeded=&from=&to=&limit=&offset=
GET /api/v1/audit/correlation/{correlationId}
GET /api/v1/audit/actions
```

Three things about this endpoint are deliberate.

**Organization is not a parameter.** `AuditLog` is tenant-owned, so the context's global
query filter constrains every query before the service sees a row. There is no way to ask
for another organization's records, because there is nothing to ask with — supplying an
`organizationId` changes nothing rather than being honoured.

**`audit:read` is its own permission.** Project administrators and above hold it; viewers,
developers, QA engineers and QA leads do not. A viewer can read every test result in the
organization and none of the trail, because the trail names people and that is a different
kind of access.

**There is no write path.** No POST, PATCH or DELETE, and the database role the application
runs as holds `INSERT` and `SELECT` on the table. Append-only is a property of the
deployment, not a convention the code is trusted to keep.

This read surface did not exist until CQ-9f: the writes were correct, the `audit:read`
permission was defined and granted, and no endpoint had ever required it (BUG-0034).

## What the model was asked, and what it cost

Every model call is recorded — the kind of request, the provider and model, the schema the
response had to satisfy, tokens, latency, estimated cost, whether it came from the cache,
and the error if it failed.

```
GET /api/v1/ai/requests?projectId=&kind=&status=&provider=&correlationId=&failedOnly=&from=&to=
```

The page carries the total cost and failure count **across the whole filter**, not just the
rows on it: a cost figure that changes when you turn the page is worse than no cost figure.

`status` distinguishes what went wrong. `failed` means the provider let the platform down —
a timeout, an error, an unreachable endpoint. `schemaRejected` means the provider answered
and the answer was unusable. They send a reader to different places, so they are never
collapsed into one.

Prompt excerpts and response bodies are deliberately not returned by this listing. They are
stored masked and truncated, but they are still the contents of somebody's application.

Like the audit trail, this had been written since the first AI feature shipped and read only
by the orchestrator's own cache and budget check, with no way to ask it anything, until
CQ-9f.

## Evidence

Logs and audit records say what the platform did. Evidence says what the *application* did,
and it is the only one of the three that is captured per test action rather than per request.

Each execution produces, under `verification/evidence/` for golden runs and in object
storage for platform runs: screenshots at each step and on failure, the DOM at the point of
failure, a Playwright trace, console output, and the network exchange — including, for API
tests, the full request and response bound to the step that made them. The run's JSON report
carries the `correlationId` of the execution, which is what ties a piece of evidence back to
the log line that produced it.

That last sentence was false when this page was first written. The execution's correlation id
was never assigned — a property initialiser generated a fresh one per row — so the id the
report published matched no log line and no audit record, and anyone following the procedure
below would have got nothing from every step and concluded the logging was broken
(BUG-0037). It is now the id the caller supplied, and golden test OBS-003 supplies a known
one and demands it back rather than checking that some id is present.

Evidence is not summarised into logs, and logs are not written into evidence. A screenshot
proves a page looked a certain way; a log line proves the platform believed something. They
are different claims and they fail independently — an assertion can pass against a page that
looks wrong, and a log can be silent about a page that is fine.

## Secrets and masking

`SecretMasker` is the single implementation used by the worker at capture time and by the API
again before anything is persisted, so behaviour cannot drift between the two passes.

It removes values by header name (`authorization`, `cookie`, `set-cookie`, `x-api-key`,
`x-csrf-token` and the rest), by field name (`password`, `token`, `secret`, `apiKey`, `pin`,
`cvv`, `cardNumber`, `ssn`, `iban`, `sortCode` and others), and by shape — bearer and basic
auth headers, JWTs, key-like strings, card numbers, email addresses and credentials embedded
in URLs. Callers can also register literals with `WithLiteral`, which is how the specific
password a run is about to type is removed from places no pattern would catch.

Redacted values are replaced with `***REDACTED***` rather than dropped, so the shape of the
record survives and a reader can tell the difference between "there was no authorization
header" and "there was one, and you are not seeing it".

What this does not do: masking is a safety net, not a guarantee. A secret in an unusual
format, in a field named something the list does not know, and not registered as a literal,
will not be caught. Do not rely on the masker as the reason it is safe to point AIRA at
production data — see [environments.md](environments.md) for the control that actually
governs that.

## Tracing one failure end to end

```bash
# 1. The run report names the execution and its correlation id
jq '.executions[] | {id, correlationId, status}' aira-report.json

# 2. Every API log line for that request
grep 5f4d3c2b1a0947e8b6c5d4e3f2a19087 api.log

# 3. Every worker line for the same work
grep 5f4d3c2b1a0947e8b6c5d4e3f2a19087 worker.log | jq .

# 4. Who asked for it
psql -c "SELECT occurred_at, user_email, action, summary FROM audit_logs
         WHERE correlation_id = '5f4d3c2b1a0947e8b6c5d4e3f2a19087' ORDER BY occurred_at;"

# 5. What the application actually did
ls verification/evidence/<TEST-ID>/<RUN_ID>/
```

## What is not here

- **No metrics endpoint.** There is no Prometheus scrape target and no counters or histograms
  are exported. Run-level numbers are available through the dashboard API and the run
  reports; process-level numbers are not exposed at all.
- **No distributed tracing.** The correlation id gives log correlation, not spans. There is
  no OpenTelemetry exporter, no trace context propagation beyond the single header, and no
  timing breakdown across the API/queue/worker boundary other than what the logs' own
  timestamps give you.
- **No log shipping.** Both services write to stdout and stop there. Collecting, retaining
  and querying that output is the deployment's responsibility; see
  [deployment.md](deployment.md).
- **No alerting on logs.** Alerting is event-driven through
  [notifications](notifications.md), on run and gate outcomes, not on log patterns. A refused
  credential attempt is logged at warning level and attributed to `Aira.Api.RateLimiter`
  (BUG-0038), which makes a brute-force burst greppable — but nothing watches for it.

These are absences, not oversights deferred to a later section: nothing elsewhere in the
documentation should be read as claiming them.
