# BUG-0003 — An imported journey may store a credential in plain text

| | |
| --- | --- |
| **ID** | BUG-0003 |
| **Title** | Journey import accepts a literal password as a step value, stores it unencrypted and returns it from the API |
| **Severity** | **MEDIUM** |
| **Found by** | AI-001, independent trust suite |
| **Environment** | See `verification/environment.md` |
| **Build** | `db15fa6` |
| **Component** | `apps/api/src/Aira.Application/Journeys/JourneyImportService.cs` |
| **Reproduction rate** | 2 of 2 |
| **Status** | Open |

## Steps

1. Register an application whose stored credentials are `alice` / `Password123!`.
2. Import a journey containing a `fill` step whose `value` is the literal `Password123!`.
3. Read the generated test case back.

## Expected

Either the import is refused, or the literal is replaced with a `${secret:...}` reference
and a warning is returned — the same treatment the platform's own recorder applies, which
never writes a password into a journey at all.

## Actual

```
import status: 200
warnings: ["This journey contains no assertions, ..."]      <- nothing about the credential
stored value returned by the API: "Password123!"
literal present in the test-case response: true
```

The value is stored in `test_steps.value` in plain text and returned by
`GET /api/v1/testcases/{id}`, which is also what the console renders.

## Scope, honestly

This is narrower than it first looks:

- The platform's **own browser extension never produces this.** It substitutes
  `${secret:app_password}` at the moment a password field is read, and that is verified
  separately. This path requires a hand-written or third-party journey.
- **Execution evidence is still masked.** The stored action records
  `maskedValue: "***REDACTED***"`, so the credential does not reach screenshots, traces or
  artifacts.
- The credential is visible to members of the same organization who can already read the
  test — not across tenants.

So it is a data-handling defect in one input path, not a cross-tenant leak.

## Why it is still worth fixing

The product's stated rule is that a credential is never stored in readable form, and here
one is. It also defeats the encryption applied to the application's own credential record:
the same password sits beside it in plaintext, in a table nothing encrypts.

## Root cause

`BrowserActionValidator` rejects credential *shapes* — `password=`, `apikey=`, `bearer ` —
but cannot recognise an arbitrary string as a secret, and nothing compares the value against
the credentials the platform already holds for that application.

## Suggested fix

On import, compare each `fill` value against the target application's resolved credentials.
On a match, substitute the matching `${secret:...}` reference and warn. The platform already
has both values at that point, so the comparison costs nothing and the author gets a working
test rather than a rejection.
