# Scope and authorization

## Why a scope exists

Security testing is the one thing QA NXT does that could be indistinguishable, from the far end
of the connection, from an attack. The difference is permission, and permission has to be a
thing the system can check rather than a thing somebody remembers.

So a security scope is not configuration. It is a record that a named person authorized a
named application, in a named environment, to be tested in named ways. Every field defaults
to refusing.

## What a scope holds

| Field | Default | What it means |
| --- | --- | --- |
| `Enabled` | `false` | A scope that exists but is switched off permits nothing. |
| `AuthorizationNote` | empty | **Required.** The written statement. An empty note refuses every request. |
| `AllowedDomains` | empty | Hosts that may be reached. An empty list permits nothing — it is not "no restriction". |
| `AllowedApiDomains` | empty | Where API probes may go, when different from the UI. |
| `AllowedPaths` | empty | When non-empty, only these paths are in scope. |
| `BlockedPaths` | empty | Paths that stay out of scope whatever else says. |
| `EnvironmentId` | null | The environment authorized. A scan naming another one is refused. |
| `AllowActiveTesting` | `false` | Whether anything beyond observation may be sent. |
| `AllowDestructiveTesting` | `false` | Whether requests that cannot be assumed reversible may be sent. |
| `AllowProduction` | `false` | Whether production may be tested at all. |
| `MaxRequestsPerSecond` | 0 | 0 refuses everything. A rate has to be chosen deliberately. |
| `MaxConcurrentRequests` | 0 | The same, for parallelism. |
| `MaxScanDurationMinutes` | 0 | The same, for how long a scan may run. |

Every default refuses. Creating a scope and saving it unchanged produces a scope that permits
nothing, which is the correct behaviour for a record whose only purpose is to say what
somebody agreed to.

## The guard

`SecurityScopeGuard.Evaluate` is a pure function, and every security request in QA NXT goes
through it. Not "should go through" — there is no other way to issue one. The engine's
`request` method is the only door, and the guard is the first thing behind it.

The ladder, in order. Each rung is checked only if the one before it passed, and the result
records how far it got — so a refusal says *where* it was refused, not merely that it was.

1. **authorization** — is there a scope, is it enabled, does it carry a written note?
2. **target-policy** — is the URL absolute, http(s), and not one of the addresses that are
   never legitimate? Cloud metadata endpoints are refused here, before the allowlist is even
   consulted, so a scope cannot opt in to them.
3. **domain** — is the host in the allowlist? An empty allowlist refuses.
4. **path** — is the path blocked, or outside an allowlist that exists?
5. **method** — is a verb named? The declared risk is then raised to match the verb: a POST is
   at least state-changing and a DELETE is destructive, regardless of what the check said.
6. **risk** — does the profile permit this risk level, does the scope, does the caller?
7. **environment** — is this production, and if so has *this run* been authorized?
8. **rate** — is the scan within its requests-per-second, concurrency and duration budget?

The risk-raising in step 5 matters more than it looks. A check that declares a POST as
"passive" does not get to issue it: the verb decides the floor and the declaration can only
raise it. A control a caller can talk its way past is not a control.

## Permissions

Six permissions rather than one, because the acts differ:

| Permission | Who holds it by default |
| --- | --- |
| `security:read` — see scans, findings and evidence | QA lead and above |
| `security:scan` — run a passive or standard scan | QA lead and above |
| `security:triage` — change a finding's status | QA lead and above |
| `security:scan:destructive` — run a scan that issues destructive requests | Project admin and above |
| `security:authorize` — write the authorization note and enable a scope | Project admin and above |
| `security:production` — authorize a scan against production | Organization admin only |

None of them is in the Viewer set. A security finding is a working description of how to break
the application; read-only access to test results is not a reason to hold one.

Holding `security:scan` does not imply `security:scan:destructive`, and the scope permitting
destructive testing does not grant the permission. Both are required, and neither implies the
other.

## Production

Production security testing is disabled by default. Three separate things must be true before
a request reaches a production environment:

1. the scope has `AllowProduction`,
2. *this run* has been authorized for production — a standing permission is not a decision to
   run today,
3. the caller holds `security:production`, which is organization-level.

Only the refusal path has ever been exercised. The permitted path is recorded as NOT VERIFIED
in the security report, because no production environment exists to exercise it against and
claiming otherwise would be a lie about the most dangerous path in the system.
