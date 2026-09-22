# BUG-0023 — A run against an unauthorized production environment was accepted

| | |
| --- | --- |
| **ID** | BUG-0023 |
| **Title** | `EnsureTestableAsync` existed and refused production correctly, but nothing called it when a run was started |
| **Severity** | **HIGH** |
| **Found by** | Building golden test API-014, which needed a production environment and found the guard was never consulted |
| **Environment** | See `verification/environment.md` |
| **Build** | `5642a03` |
| **Component** | `apps/api/src/Aira.Application/Testing/TestRunService.cs` |
| **Reproduction rate** | 2 of 2 |
| **Status** | Fixed and re-verified |

## What happens

The environment model refuses production deliberately and well. `EnsureTestableAsync`
rejects a disabled environment, and rejects a production environment whose testing has not
been authorized with a recorded note and author.

`TestRunService.StartAsync` looked the environment up, checked it existed, and used it:

```csharp
var environment = request.EnvironmentId is null ? null
    : await _db.Environments.FirstOrDefaultAsync(e => e.Id == request.EnvironmentId, ct);

if (request.EnvironmentId is not null && environment is null)
    return Error.NotFound("The environment");
```

Existence was the only question asked. A run pinned to an unauthorized production
environment was queued and executed.

## Why it matters

"Production testing is disabled by default" was true of the configuration surface and not
of the thing that matters — starting a run. The two-switch safeguard, the note, the
recorded authorizing user: all of it was reachable and none of it was consulted on the one
code path where it counts. A disabled environment was equally testable.

## Root cause

The guard was written as part of the environment service and never wired into the run
path. Nothing failed, because refusing nothing looks the same as having nothing to refuse
until someone marks an environment production.

## Expected

Starting a run against an environment asks that environment whether it may be tested, at
the moment the run is requested, and refuses with the environment's own reason.

## Fix

`TestRunService` takes `IEnvironmentService` and calls `EnsureTestableAsync` immediately
after resolving the environment, returning its error unchanged so the caller sees the real
reason ("Environment 'prod' is production and testing it has not been authorized…") rather
than a generic refusal.

## Re-verification

| | Before | After |
| --- | --- | --- |
| Run against unauthorized production | queued and executed | refused, 403, naming the environment and what is missing |
| Run against a disabled environment | queued and executed | refused, "Environment 'x' is disabled." |
| Run against an authorized production environment | executed | executed — authorization still works, and API-014 then shows the *write* refused separately |

API-014 exercises the surviving path end to end: production authorized with a note, the run
permitted, and the `POST` inside it refused at the moment of the call because destructive
tests are a separate switch that is still off.

```
PASS  API-014  run failed; message "A POST request is not permitted against this
               environment. Destructive API requests are disabled for it.";
               0 request(s) recorded
```
