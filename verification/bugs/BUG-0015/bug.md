# BUG-0015 — A missing control is blamed on the session

| | |
| --- | --- |
| **ID** | BUG-0015 |
| **Title** | A 401 the application returns on its own sign-in page outranks the engine's statement that no element matched, so a removed button is reported as an authentication problem |
| **Severity** | **HIGH** |
| **Found by** | The product demonstration (`scripts/run-product-demo`, step 14) |
| **Environment** | See `verification/environment.md` |
| **Build** | `98c0687` |
| **Component** | `apps/api/src/Aira.Application/Diagnosis/DeterministicFailureClassifier.cs`, `apps/api/src/Aira.Infrastructure/Ai/Providers/LocalFailureAnalyser.cs` |
| **Reproduction rate** | 2 of 2 |
| **Status** | Fixed and re-verified |

## What happens

The bank's sign-in button is removed (`FAULT_LOGIN_BUTTON_REMOVED`). A test that signs in
fails at step 4 with the clearest possible message:

```
step 4 (click): testId="login-submit" could not be used: No element matched testId="login-submit".
```

The platform reports:

```
category:         authenticationIssue at 85% confidence
summary:          The session was not authorised.
likely cause:     The application rejected requests as unauthenticated or forbidden — the
                  session expired, or the account lacks a required permission.
suggested action: Check the test account's permissions and this environment's session lifetime.
```

Nothing about the session is wrong. The button is gone.

## Why it matters

This is the analysis a person reads first, and it sends them to the wrong place: they will
check credentials, permissions and token lifetimes on an application whose markup changed.
The failure screenshot, the DOM snapshot and the engine's own message all say "the element
is not there", and the platform talks over all three.

It is also the exact scenario the product demonstration exists to show — a control removed,
healing correctly refused, the run correctly failed — so the one sentence a viewer reads
about *why* is the one sentence that is wrong.

The verdict itself is not affected: the run failed, no healing was applied, and no false
pass was produced. This is a defect in the explanation, not in the result.

## Root cause

`DeterministicFailureClassifier` orders its rules "strongest evidence first", and counts
`401`/`403` responses anywhere in the execution as strong evidence:

```csharp
if (input.AuthErrorCount > 0)
    return new DeterministicVerdict(FailureCategory.AuthenticationIssue, 85, …);

// … several rules later …
if (lowered.Contains("no element matched") …)
    return new DeterministicVerdict(FailureCategory.LocatorChange, 65, …);
```

A single-page application asks "is anyone signed in?" as it loads and is answered `401`
when nobody is. That answer is not a symptom — it is the sign-in page working correctly.
Every failure on a signed-out page therefore arrives with `AuthErrorCount > 0`, and the
auth rule swallows every other explanation.

`LocalFailureAnalyser` carries the same ordering independently, which is why the prose
agreed with the category rather than contradicting it. This is the second time these two
have had to be corrected together (see BUG-0012).

## Expected

When the engine states that the step's locator matched no element, that statement is about
the step that failed and is more specific than a count of responses from elsewhere in the
run. The category should be `locatorChange`, and the recorded auth responses should still
be shown to the reader as context — because a session that really did expire produces the
same symptom, and the reader should be told both facts rather than sold one of them.

A `5xx` response stays ahead of the locator rule: a server error is a real fault, not
routine traffic.

## Reproduction

```bash
bash test-lab/scripts/lab-ctl.sh start
node verification/bugs/BUG-0015/reproduce.mjs
```

Runs the journey twice with the control removed. Before the fix both are classified
`authenticationIssue`; after it, both must be `locatorChange`.

## Fix

The auth rule is gated on the engine not having said the locator matched nothing:

```csharp
if (input.AuthErrorCount > 0 && !IsLocatorMiss(lowered)) { … }
```

and the locator rule now carries the auth responses as context rather than dropping them:

> No element matched testId="login-submit". 2 request(s) also returned 401 or 403, which is
> ordinary on a signed-out page but would also follow a session that expired mid-test.

A session that really did expire produces the same symptom — the page becomes the sign-in
page and the element vanishes — so the reader is given both facts instead of one chosen for
them. `LocalFailureAnalyser` carries the same condition, with a comment on each saying the
two have to agree.

`5xx` responses stay ahead of the locator rule, and an assertion that fails while the
application is returning 401s is still an authentication issue: nothing in that message
says the element was missing.

## Re-verification

| | Before | After |
| --- | --- | --- |
| `reproduce.mjs` | 2 of 2 misclassified as `authenticationIssue` | **0 of 2** — `locatorChange` both times |
| Suggested action | "Check the test account's permissions and this environment's session lifetime." | "Compare the failure screenshot with the expected page…" |
| Failure-detection suite | 12/12 | 12/12 — DET-003 and DET-004 still `authenticationIssue`, DET-011 still `locatorChange` |
| Failure-analysis suite | 16/16 | 16/16 — classification accuracy still 10/10 |
| Classifier unit tests | none existed | **8 added**, covering the rule ordering including this case |

The classifier had no unit tests before this. Two defects in a row (BUG-0012, BUG-0015) had
to be found by driving the whole product, which is slower and less precise than it needed to
be; `apps/api/tests/Aira.UnitTests/Diagnosis/DeterministicFailureClassifierTests.cs` now
pins the ordering, and both defects fail it.
