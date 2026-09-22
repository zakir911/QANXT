# BUG-0030 — An exported-but-empty environment variable broke every `aira schedule` command

| | |
| --- | --- |
| **ID** | BUG-0030 |
| **Title** | `aira schedule add` sent `AIRA_ENVIRONMENT_ID` verbatim, so an empty value became `"environmentId": ""` and the API rejected the whole request as malformed |
| **Severity** | **MEDIUM** |
| **Found by** | Golden test SCH-007, which runs the CLI with the variable exported and empty — the way a CI job that declares it and does not set it looks |
| **Environment** | See `verification/environment.md` |
| **Build** | `b6e6354` |
| **Component** | `packages/cli/src/commands/schedule.ts` |
| **Reproduction rate** | 3 of 3 |
| **Status** | Fixed and re-verified |

## What happens

```
$ AIRA_ENVIRONMENT_ID= aira schedule add --name "Nightly" --cron "0 2 * * *"
error One or more validation errors occurred.
```

The body sent was:

```json
{"projectId":"…","name":"Nightly","cronExpression":"0 2 * * *","environmentId":""}
```

An empty string is not a `Guid?`, so ASP.NET refused to bind the request at all — not just
that field. The message says nothing about which field or why, because model-binding
failure happens before any of AIRA's own validation runs.

## Why it matters

Exported-and-empty is the normal state of a variable a pipeline declares and does not set.
A team adding `AIRA_ENVIRONMENT_ID: ${{ vars.AIRA_ENVIRONMENT_ID }}` to a workflow before
setting the variable gets this, and the message gives them nothing to act on. The variable
is not obviously involved — they did not pass a flag.

`aira run` was already correct: `environmentFlag` in `run.ts` treats a blank value as
absent, with a comment saying why. The schedule command read the variable directly and did
not.

## Fix

Use the helper that already existed rather than a second reading of the same variable:

```ts
environmentId: environmentFlag(args),
```

`environmentFlag` returns undefined for a blank value and validates the shape of a
non-blank one, so a typo now fails with "`--environment` expects an environment id" before
a request is sent, instead of an opaque binding error after.

This is a duplicated-logic bug rather than a logic bug: the rule was written once, correctly,
and the second call site did not use it.

## Verification

SCH-007 runs the whole CLI surface — add, list, preview, disable, remove — with
`AIRA_ENVIRONMENT_ID` exported and empty. It failed at `add` before the fix and passes
after it.
