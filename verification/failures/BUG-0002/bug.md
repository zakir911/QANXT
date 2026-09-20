# BUG-0002 — A test case cannot be created by hand

| | |
| --- | --- |
| **ID** | BUG-0002 |
| **Title** | No API or UI creates a test case; `TestCaseSource.Manual` is unreachable |
| **Severity** | **MEDIUM** |
| **Found by** | HEAL suite setup, independent verification |
| **Environment** | See `verification/environment.md` |
| **Build** | `db15fa6` |
| **Component** | `apps/api/src/Aira.Api/Controllers/TestCasesController.cs` |
| **Reproduction rate** | 2 of 2 |
| **Status** | Open — recorded, not fixed |

## Steps

```
POST /api/v1/testcases
Authorization: Bearer <a session with test:write>
{ "projectId": "...", "applicationId": "...", "name": "...", "steps": [...] }
```

## Expected

A test case is created, or a validation error explaining what is wrong with the body.

## Actual

```
405 Method Not Allowed
```

The controller exposes `GET`, `GET /{id}`, `POST /generate`, `PATCH /{id}`,
`PATCH /{id}/steps/{stepId}` and `DELETE /{id}`. There is no create.

## Why this matters

A test case can only come into existence two ways: generated from the knowledge graph, or
imported from a journey recorded with the browser extension. Both are real paths and both
work. But `TestCaseSource` has had a `Manual = 0` member since the first schema, the console
offers step editing, and a QA platform whose users cannot write a test by hand is missing a
capability its own domain model advertises.

It also makes precise verification awkward: to test one specific locator behaviour, an
engineer has to generate a test and hope it contains the step they wanted, or hand-craft a
journey JSON and import it. This verification took the second route.

## Not a correctness or security issue

Nothing reports a wrong result because of this. It is a missing capability, not a broken
one, which is why it is recorded as MEDIUM and left unfixed for the product owner to
schedule rather than fixed opportunistically during verification.

## Suggested fix

`POST /api/v1/testcases` taking the same shape the generator persists, with every step run
through `BrowserActionValidator` exactly as generated and imported steps are, and
`Source = TestCaseSource.Manual`.
