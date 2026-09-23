# BUG-0034 — The audit trail is written and cannot be read

| | |
| --- | --- |
| **ID** | BUG-0034 |
| **Title** | `AuditLog` records 35 action types and no API endpoint, CLI command or console screen queries them; reviewing the trail requires direct database access |
| **Severity** | **MEDIUM** |
| **Found by** | Documenting the observability surface for CQ-10: writing down how an operator reviews the audit trail turned up no way to do it |
| **Environment** | See `verification/environment.md` |
| **Build** | `72e2987` |
| **Component** | `apps/api/src/Aira.Api/Controllers/` (no `AuditController`), `apps/web-console/src` |
| **Reproduction rate** | 3 of 3 |
| **Status** | **OPEN** — documented as a known limitation in `docs/observability.md`; fix belongs to CQ-9f |

## What happens

`AuditLogger` writes correctly and is called from throughout the application. The write side
is in good order. The read side does not exist:

```
$ ls apps/api/src/Aira.Api/Controllers/ | grep -i audit
$ grep -rn 'AuditLogs' --include=*.cs apps/api/src/Aira.Api apps/api/src/Aira.Application | grep -v Migrations
apps/api/src/Aira.Application/Abstractions/IAiraDbContext.cs:75:    DbSet<AuditLog> AuditLogs { get; }
```

One reference, and it is the `DbSet` declaration itself. Nothing reads the table. There is
no `GET /api/v1/audit`, no `aira audit` command, and no console screen — `auth.tsx` is the
only file in the console matching "audit", and the match is on "authenticated".

## Why it matters

The audit trail exists to answer governance questions: who changed this quality gate, who
approved this healing proposal, who disabled this schedule, which account produced this run
of failed logins. Every one of those answers is being recorded. None of them can be
retrieved by the people who would ask.

This matters more than an ordinary missing endpoint because of what the table is *for*. The
schema comment states that the API exposes no update or delete path and the application's
database role holds `INSERT` and `SELECT` only — a design that treats the table as a
compliance record. A compliance record nobody can query is a control in name only, and the
absence is invisible from the code: every call site looks correct, because the writes are
correct.

It is the fifth instance of the same pattern found in this phase of work — after BUG-0026
and BUG-0027 (documented exit codes no path could produce), BUG-0028 (a parameter with no
caller) and BUG-0033 (a field no request body carried). A capability that is implemented,
correct, and unreachable.

## Reproduction

```
$ for i in 1 2 3; do
    curl -s -o /dev/null -w "attempt $i: %{http_code}\n" \
      "$AIRA_API_URL/api/v1/audit" -H "authorization: Bearer invalid"
  done
attempt 1: 404
attempt 2: 404
attempt 3: 404

$ curl -s -o /dev/null -w "projects: %{http_code}\n" \
    "$AIRA_API_URL/api/v1/projects" -H "authorization: Bearer invalid"
projects: 401
```

The control matters: an existing route rejects the bad token with 401, so the 404 is the
absence of a route rather than an authorization refusal. Three attempts, three 404s.

The only working path is SQL:

```sql
SELECT occurred_at, user_email, action, entity_type, summary, correlation_id, succeeded
FROM   audit_logs
WHERE  organization_id = '…'
ORDER  BY occurred_at DESC
LIMIT  100;
```

## Not fixed here

CQ-10's scope is documentation, the verification entry point and the traceability matrix.
Adding a query endpoint means a controller, tenant-scoped filtering, pagination, a
role check (the trail names users, so it is not readable by every role), a CLI command and
golden tests over all of it. That is CQ-9f's scope — the phase that covers isolation, audit
and observability verification — and it is recorded here so the gap is carried into it
rather than rediscovered.

`docs/observability.md` states the limitation in the section "Known limitation: the audit
trail has no read surface", including the SQL, so the documentation does not imply a
capability that is absent.
