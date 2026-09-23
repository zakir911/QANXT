# BUG-0038 — A refused credential attempt read exactly like a served request

| | |
| --- | --- |
| **ID** | BUG-0038 |
| **Title** | The rate limiter had no `OnRejected` handler, so a blocked sign-in appeared only as Serilog's ordinary "responded 429" line at Information — indistinguishable from normal traffic, and unattributable to the limiter |
| **Severity** | **LOW** |
| **Found by** | CQ-9f, while writing AUD-004: a burst of failed sign-ins produced fewer audit records than attempts, and the missing ones turned out to have been refused before reaching the auth service |
| **Environment** | See `verification/environment.md` |
| **Build** | `7f50d74` |
| **Component** | `apps/api/src/Aira.Api/Program.cs` |
| **Reproduction rate** | 3 of 3 |
| **Status** | Fixed and re-verified |

## What happens

An attempt that reaches `AuthService` is audited as `LoginFailed`. An attempt the limiter
refuses never gets there, so it produces no audit record — correctly, and deliberately. But
it produced nothing else distinctive either:

```
[04:45:14 INF] POST /api/v1/auth/login responded 429 in 1.1ms
  {"SourceContext": "Serilog.AspNetCore.RequestLoggingMiddleware", …}
```

Information level, from the generic request logger, with nothing naming the rate limiter and
nothing marking the endpoint as credential-bearing.

## Why it matters

This is not a broken control — the limiter works, and 429 is the right answer. It is that
the control's most interesting output is unfindable.

A brute-force attempt against a real deployment looks like: a handful of `LoginFailed` audit
records, then silence, then several thousand Information-level lines that are shaped exactly
like every successful page load. The number a security review most wants — "how many did we
refuse" — is the one that reads as routine.

Severity is LOW rather than higher because the information was present, just undifferentiated.
Nothing was lost; it was unusable.

## Fix

An `OnRejected` handler that says what happened, at a level that reflects what kind of
request it was:

```csharp
options.OnRejected = (context, _) =>
{
    var logger = context.HttpContext.RequestServices
        .GetRequiredService<ILoggerFactory>().CreateLogger("Aira.Api.RateLimiter");
    var isCredentialEndpoint = context.HttpContext.Request.Path
        .StartsWithSegments("/api/v1/auth", StringComparison.OrdinalIgnoreCase);

    logger.Log(
        isCredentialEndpoint ? LogLevel.Warning : LogLevel.Information,
        "Rate limit refused {Method} {Path} from {RemoteAddress} (credential endpoint: {IsCredentialEndpoint})",
        …);
    return ValueTask.CompletedTask;
};
```

Two decisions worth stating.

**A refused credential attempt is a warning; an ordinary tenant hitting its quota is not.** A
tenant exhausting its per-minute budget is capacity news and belongs at Information. They do
not belong at the same level, because the whole point is to be able to find one without
reading the other.

**Logged, not audited.** An audit row per refusal would let anyone who can reach the login
endpoint write unbounded rows into the governance table — turning a brute-force attempt into
a second and worse problem, and one that degrades the very record a reviewer needs. The
attempts that got through are audited; the ones the limiter stopped are in the log.

## Re-verification

AUD-008 exercises it against a real burst and reads the API's own log file, counting only the
lines that burst produced:

```
PASS  AUD-008  A burst of credential attempts is refused, and the refusals are recorded as a
               security event rather than as ordinary traffic — 14 of 20 attempt(s) refused
               with 429; 14 limiter line(s) written — 14 at warning level, 14 named as a
               credential endpoint, 14 attributed to the limiter
```

Every refusal is accounted for: all fourteen at warning level, all fourteen carrying
`SourceContext: Aira.Api.RateLimiter`, all fourteen marked as a credential endpoint. The
assertion counts rather than merely finding one, so a handler that fired intermittently
would fail it.
