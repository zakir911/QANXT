# BUG-0004 — The platform rate-limits its own browser worker

| | |
| --- | --- |
| **ID** | BUG-0004 |
| **Title** | Under concurrent runs the worker's artifact uploads and completion callbacks are throttled with HTTP 429, losing evidence and stranding executions |
| **Severity** | **HIGH** |
| **Found by** | CONC-001, independent operations suite |
| **Environment** | See `verification/environment.md` |
| **Build** | `db15fa6` |
| **Component** | `apps/api/src/Aira.Api/Program.cs` — global rate limiter |
| **Reproduction rate** | 1 of 1 observed (1 execution in 10) |
| **Status** | **Fixed and verified** |

## Steps

1. Start ten test runs at once against one project (`CONC-001`).
2. Watch `/tmp/aira-worker.log`.

## Expected

All ten runs reach a verdict. The worker is an internal component of the platform, not a
tenant consuming an API quota.

## Actual

Nine passed. One execution (`83718af6-…`) is stuck in `Running` with `completed_at` NULL,
seven minutes after the worker reported nothing in flight.

The worker log shows the chain, from `logs/worker-429-chain.jsonl`:

```
16:22:56  upload trace.zip failed; retrying           … failed with 429   (attempt 1 of 4)
16:22:59  An artifact could not be uploaded and will not be referenced  artifact: trace.zip
16:23:06  An artifact could not be uploaded and will not be referenced  artifact: execution.network.json
16:23:10  An artifact could not be uploaded and will not be referenced  artifact: execution.webm
16:23:13  POST /api/v1/worker/executions/83718af6-…/complete failed with 429   (4 attempts)
16:23:13  Releasing a job back to the queue
```

Two consequences, both bad:

1. **Evidence is silently lost.** The trace, the video and the network log for that execution
   were discarded. The platform's whole value is evidence; losing it under load and carrying
   on is worse than failing.
2. **The execution is stranded.** The worker released the job, but the execution row stays
   `Running` forever — see BUG-0005.

## Root cause

The global limiter partitions by the organization claim for authenticated callers:

```csharp
var key = context.User.Identity?.IsAuthenticated == true
    ? context.User.FindFirst(JwtTokenService.OrganizationClaim)?.Value ?? "authenticated"
    : context.Connection.RemoteIpAddress?.ToString() ?? "anonymous";
```

A worker token carries `org`, so **every worker callback for a tenant shares one partition
with that tenant's human users**, against `RATE_LIMIT_PERMIT_PER_MINUTE` (300). A run that
fans out to ten executions uploads four or five artifacts each plus a completion callback,
and exceeds it.

The limit is correct for protecting the API from a noisy tenant. It should never have
applied to the platform's own execution plane, whose traffic volume is a function of how
much work the tenant legitimately asked for.

## The real root cause, found while fixing it

Giving worker tokens their own partition changed nothing. Re-running the parallel test still
showed seven throttled responses, which led to the actual defect:

```csharp
app.UseCors("console");
app.UseRateLimiter();      // <- partitions on claims
app.UseAuthentication();   // <- claims only exist after this
```

**The limiter ran before authentication.** `context.User` was therefore empty when the
partition key was chosen, so every request — worker or human — fell through to
`context.Connection.RemoteIpAddress`.

That means the per-tenant isolation the limiter was written for **never worked at all**. Its
own comment says "so one noisy tenant cannot exhaust another's budget"; in practice every
caller reaching the API from one address shared a single 300-per-minute bucket, across all
tenants. Behind a load balancer or a corporate NAT, one tenant could have starved every
other one, and nobody would have seen why.

## Fix

Two parts:

1. `app.UseAuthentication()` now runs **before** `app.UseRateLimiter()`, so the limiter can
   see who is calling. This is what makes per-tenant partitioning work for the first time.
2. Worker-kind tokens get their own partition, sized for the execution plane
   (`WORKER_RATE_LIMIT_PERMIT_PER_MINUTE`, default 6000), so a tenant's humans and its
   workers cannot starve each other.

## Verification after the fix

| Check | Before | After |
| --- | --- | --- |
| CONC-001 — ten parallel runs | 9 passed, 1 stranded | **10 passed, 0 unresolved** |
| CONC-002 — worker traffic throttled | 7 throttled in-window | **0 throttled, 0 artifacts dropped** |
| SEC-001…SEC-060 | 17 pass | **17 pass — no regression from reordering** |
| `tests/e2e/security-check.mjs` | passes | **passes; sign-in still rate limited** |

Evidence: `logs/after-fix-worker-window.log`, `../../performance/CONC-001-reverify.json`.

## Regression cover

`verification/tests/conc-reverify.mjs` (CONC-001 and CONC-002). CONC-002 scopes its log scan
by timestamp, so it cannot pass on stale lines — an earlier version of it did exactly that
and reported a fixed defect as still present.
