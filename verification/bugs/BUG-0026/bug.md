# BUG-0026 — Exit code 6, SECURITY_POLICY_VIOLATION, could never be produced

| | |
| --- | --- |
| **ID** | BUG-0026 |
| **Title** | Every security refusal reported as exit 4 (AUTHENTICATION_ERROR) or exit 3 (CONFIGURATION_ERROR), so the documented security exit code was unreachable |
| **Severity** | **HIGH** |
| **Found by** | Building the local CI simulation: the scenario that must produce exit 6 could not be written |
| **Environment** | See `verification/environment.md` |
| **Build** | `2250b03` |
| **Component** | `packages/cli/src/api.ts`, `apps/api/src/Aira.Application/Projects/EnvironmentService.cs` |
| **Reproduction rate** | 3 of 3 |
| **Status** | Fixed and re-verified |

## What happens

`ExitCode.SecurityPolicyViolation` is documented in `packages/cli/src/exit-codes.ts`:

> A security policy refused the request: a target outside the allowed domains, a
> production environment without explicit authorization, a destructive action a policy
> forbids. The run did not happen, and that is the correct outcome.

All five example pipelines in `infrastructure/ci/examples/` branch on it, and golden test
CI-005 requires them to. `docs/ci-cd.md` documents it. Nothing in the CLI ever returns it:

```
$ grep -rn 'SecurityPolicyViolation' packages/cli/src/
packages/cli/src/exit-codes.ts:47:  SecurityPolicyViolation: 6,
packages/cli/src/exit-codes.ts:71:  { code: ExitCode.SecurityPolicyViolation, name: 'SECURITY_POLICY_VIOLATION', … },
```

Two mentions, both declarations. The value is never thrown and never returned.

What actually happens when a pipeline is pointed at an unauthorized production
environment: `EnvironmentService.EnsureTestableAsync` refuses with `Error.Forbidden`, the
API answers 403, and `ApiClient` maps every 403 the same way:

```ts
if (response.status === 403) {
  throw new CliError('The account is not permitted to do that.', ExitCode.AuthenticationError,
    'Ask an organization administrator for the required role.');
}
```

## Why it matters

The pipeline is told the wrong thing, and so is the person reading the build.

Exit 4 means *the credentials are wrong*, and the hint says so: "Ask an organization
administrator for the required role." A team that reads it does the natural thing — widens
the service account's permissions, and tries again. That is the opposite of the correct
response. Nobody's role was insufficient; a policy refused to test production, on purpose,
and the correct response is to leave it refused or to authorize production explicitly with
a written reason.

The whole reason the codes are separate is that they go to different people. Collapsing a
security refusal into an authentication failure sends it to the person most likely to
resolve it by removing the control.

## Root cause

`Error.Forbidden` is one error for two different situations — "your role does not allow
this" and "a policy refuses this regardless of your role" — and the CLI only had the
HTTP status to tell them apart. 403 carries both.

## Fix

A security refusal is now a distinct error code on the wire, while keeping 403 as the
status (the server understood, and re-authenticating will not help):

```csharp
public static Error SecurityPolicy(string message)
    => new(ErrorKind.Forbidden, "security_policy", message);
```

`EnsureTestableAsync` and the destructive-tests guard use it. The problem document already
carried `error.Code`, so nothing new had to be added to the response shape.

The CLI reads that code on a 403 and separates the two:

```ts
if (response.status === 403) {
  if (problemCode(text) === 'security_policy') {
    throw new CliError(describeProblem(text), ExitCode.SecurityPolicyViolation,
      'A security policy refused this. Do not retry until you have read why…');
  }
  throw new CliError('The account is not permitted to do that.', ExitCode.AuthenticationError, …);
}
```

## Verification

`test-lab/ci-simulation` scenario `production-refused` runs the pipeline against a
production environment that has not been authorized, and requires exit 6. Before the fix
it exited 4. Golden test CIS-006 covers the same path.

Unit tests pin both halves: a role refusal still exits 4, a policy refusal exits 6.
