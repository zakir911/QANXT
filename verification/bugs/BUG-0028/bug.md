# BUG-0028 — A pipeline could not say which environment it was testing

| | |
| --- | --- |
| **ID** | BUG-0028 |
| **Title** | `aira run` never sent `environmentId`, so every safety control the environment carries — the production guard, the allowed domains, the rate limit, the per-environment base URL — was unreachable from CI |
| **Severity** | **HIGH** |
| **Found by** | Building the local CI simulation: the scenario that runs against an unauthorized production environment had no way to select it |
| **Environment** | See `verification/environment.md` |
| **Build** | `2250b03` |
| **Component** | `packages/cli/src/commands/run.ts`, `packages/cli/src/commands/regression.ts` |
| **Reproduction rate** | 3 of 3 |
| **Status** | Fixed and re-verified |

## What happens

`StartTestRunRequest` has taken an `EnvironmentId` since environments existed, and
`TestRunService.StartAsync` uses it for everything that matters:

```csharp
var testable = await _environments.EnsureTestableAsync(environment.Id, ct);
if (!testable.IsSuccess) return Result<TestRunSummary>.Failure(testable.Error!);
…
var baseUrl = environment?.BaseUrl ?? application.BaseUrl;
var apiBaseUrl = string.IsNullOrWhiteSpace(environment?.ApiBaseUrl) ? baseUrl : environment!.ApiBaseUrl!;
```

The CLI never sends it. The body it posts to `/api/v1/testruns` has no `environmentId`
field at all, and there is no flag that would produce one:

```
$ grep -n 'environment' packages/cli/src/commands/run.ts
$
```

## Why it matters

Three things follow from it, and the third is the serious one.

1. **Every run ignored the environment's base URL** and fell back to the application's.
   A project with a QA and a staging environment ran both against whatever URL was
   registered on the application, and reported the result as if it had tested the one you
   asked for. Nothing in the report said otherwise — `environmentId` was null, so a reader
   could not tell which deployment the evidence came from.

2. **The rate limit and the allowed domains configured on the environment were never
   applied**, because the run resolved its allowlist from the application alone.

3. **The production guard never ran.** `EnsureTestableAsync` refuses an unauthorized
   production environment, and CQ-5 added the call specifically so that it is checked when
   a run is asked for rather than only when the environment was configured. That call is
   inside `if (environment is not null)`. With the CLI never sending one, `environment` was
   always null from CI, so the branch never executed. The guard was correct, tested, and
   unreachable from the only surface that would ever trip it.

This is the same shape as BUG-0018 in the earlier phase — a control that exists, is right,
and is never invoked — and it is the shape worth looking for deliberately, because
inspecting the guard's own code proves nothing about whether anything calls it.

There was a fourth part, found while verifying the fix: even once a run recorded its
environment, nothing downstream reported it. `TestRunSummary` returned a bare
`EnvironmentId`, and the CLI's report model and JSON report dropped even that. A report
that cannot answer "was this staging or production?" has the same problem as a run that
never knew.

## Fix

`--environment <id>` on `aira run` and `aira regression run`, also read from
`AIRA_ENVIRONMENT_ID` so a pipeline can set it once per job rather than on every command.
The value is passed straight through to `environmentId` on the start-run request.

`TestRunSummary` now also carries the environment's key and name, because a report holding
only a UUID is unreadable without a second lookup and the question being asked is about
"prod", not about an identifier. The JSON report gains an `environment` block, and the pull
request summary names the environment in its footer beside the commit.

Nothing about the guard itself changed. It was already right; it just had no caller.

## Verification

`test-lab/ci-simulation` scenario `production-refused` selects a production environment
that has not been authorized and requires exit 6 — which, before this fix and BUG-0026's,
exited 0 with a green run against the wrong URL. Scenario `qa-environment` selects an
authorized QA environment and requires the run to record it.

Golden tests CIS-006 and CIS-007 cover both.
