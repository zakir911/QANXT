# BUG-0027 — Exit code 8, AIRA_INTERNAL_ERROR, could never be produced either

| | |
| --- | --- |
| **ID** | BUG-0027 |
| **Title** | A bug in AIRA was reported as exit 5 (INFRASTRUCTURE_ERROR), so it was read as "the platform is down" and went to the operator instead of to whoever maintains AIRA |
| **Severity** | **MEDIUM** |
| **Found by** | Building the local CI simulation, immediately after BUG-0026 — the same audit, one code further down |
| **Environment** | See `verification/environment.md` |
| **Build** | `2250b03` |
| **Component** | `packages/cli/src/aira.ts`, `packages/cli/src/api.ts` |
| **Reproduction rate** | 3 of 3 |
| **Status** | Fixed and re-verified |

## What happens

Same shape as BUG-0026, one code further down the table. `ExitCode.AiraInternalError` is
documented as:

> AIRA itself misbehaved: an unhandled error, a malformed response from its own API. A bug
> in the tool, not a finding about the application.

and is never returned:

```
$ grep -rn 'AiraInternalError' packages/cli/src/ | grep -v exit-codes.ts | wc -l
0
```

The three paths that meet its own definition all returned 5 instead:

| Path | Was | Definition it matches |
| --- | --- | --- |
| An unhandled exception in the CLI (`aira.ts:122`) | 5 | "an unhandled error" |
| A response from AIRA's API that is not JSON (`api.ts:73`) | 5 | "a malformed response from its own API" |
| A 500 from AIRA's API | 5 | AIRA failed, rather than being unreachable |

## Why it matters

Less serious than BUG-0026 — nobody removes a safety control over this one — but wrong in
the same way. Exit 5 means *AIRA could not be reached*, and the pipelines say so: "The
platform operator should look." An operator handed an unhandled `TypeError` from the CLI
checks the deployment, finds it healthy, and hands it back. The defect is in AIRA, and the
code that would have said so existed and was unused.

It also hid the defect class from the one audience that can fix it. A dashboard counting
exit 5 sees a flaky platform; the same builds counted as exit 8 would have read as a
recurring crash in the CLI.

## Root cause

Two of the three were written before code 8 existed and never revisited. The third — the
catch-all in `aira.ts` — has a comment that gets the reasoning exactly right and then picks
the wrong code:

```ts
// Not a test failure. Something in the tooling broke, and the message must say so
// clearly rather than leaving a team looking for a defect that is not there.
process.exitCode = ExitCode.InfrastructureError;
```

"Something in the tooling broke" is code 8's definition, verbatim.

## Fix

- The catch-all in `aira.ts` returns `AiraInternalError`.
- A non-JSON response from AIRA's own API returns `AiraInternalError`.
- A 500 returns `AiraInternalError`; 502, 503 and 504 stay `InfrastructureError`, because a
  gateway error in front of AIRA genuinely is the operator's. `ErrorKind.Dependency` already
  maps to 503, so a dependency AIRA depends on being down still reads as infrastructure.

A transport failure — `fetch` throwing, nothing listening — is untouched and stays 5. That
is the one case where AIRA really cannot be reached.

## Verification

`packages/cli/test/api-errors.test.ts` pins each path. `test-lab/ci-simulation` scenario
`aira-internal-error` runs the pipeline against a responder that answers 500 the way a
broken AIRA would, and requires exit 8 and the pipeline's own "this is a defect in AIRA"
branch. That scenario verifies the CLI's classification and the pipeline's handling of it;
it does not claim to verify that AIRA returns 500 under any particular condition, and the
simulation's README says so.
