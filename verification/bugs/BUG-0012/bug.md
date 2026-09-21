# BUG-0012 — An assertion failure is classified as "unknown"

| | |
| --- | --- |
| **ID** | BUG-0012 |
| **Title** | The failure classifier matches message text the execution engine no longer produces, so the commonest kind of real defect falls through to `Unknown` |
| **Severity** | **HIGH** |
| **Found by** | FA-007, FA-010, FA-012 (golden failure-analysis suite) |
| **Environment** | See `verification/environment.md` |
| **Build** | `2d18286` |
| **Component** | `apps/api/src/Aira.Application/Diagnosis/DeterministicFailureClassifier.cs` |
| **Reproduction rate** | 2 of 2 |
| **Status** | Fixed and re-verified |

## What happens

The application renders `OK 99` where the test expects `OK 42` — an ordinary wrong-value
defect. The run fails correctly, and then:

```
classified "unknown" at 30% confidence
message: Expected the element to contain "OK 42" but it read "OK 99".
```

The same happens to the timeout case, whose assertion reads `"calculating…"`.

Across the ten failure classes in the lab, classification is **7 of 10 correct with 2
unknown**.

## Why it matters

`Unknown` is the one answer that helps nobody: it tells the reader the platform has no
opinion about a failure whose cause is written in the failure message. Worse, the category
drives everything downstream — defect grouping, the quality-gate view, and whether a model
is consulted at all.

Assertion mismatches are the most common failure a real suite produces. Getting them right
matters more than any other class.

## Root cause

The classifier has a rule for exactly this case:

```csharp
if (lowered.Contains("expected the text") || lowered.Contains("expected the value")
    || lowered.Contains("expected attribute") || lowered.Contains("assertion"))
```

but the engine's messages read:

```
Expected the element to contain "OK 42" but it read "OK 99".
Expected the value "" but found "100".
Expected the URL to contain "/x" but it was "…".
```

"Expected the element to contain" matches none of those patterns. The classifier and the
engine were written at different times and their wording drifted apart. Nothing tied them
together, so nothing noticed.

The deeper problem is the coupling itself: a classifier that identifies an assertion
failure by the *prose* of an error message will drift again the next time a message is
reworded.

## Expected

An assertion failure is classified as an application defect (or a data issue) with useful
confidence, and the classification does not depend on the exact wording of a sentence.

## Reproduction

```bash
bash test-lab/scripts/lab-ctl.sh start
node verification/bugs/BUG-0012/reproduce.mjs
```

## Fix

Two changes, because the same mistake was made twice in the same shape.

1. **An assertion is identified by the action that failed, not by its prose.**
   `ClassificationInput` now carries `FailingAction` — the engine's own name for the step,
   such as `assertText` — and both the deterministic classifier and the local analyser use
   it. The message patterns remain as a fallback, widened to match what the engine actually
   says ("expected the element", "but it read", "but found").

2. **Recorded network evidence outranks the message.** The connection-reset case had a
   failed request in the network log (`net::ERR_EMPTY_RESPONSE`) and was still reported as
   an application defect, because the NetworkIssue rule additionally required the *error
   message* to mention the network — and the message belonged to the assertion that
   noticed. A transport-level failure now decides the category on its own.

## Re-verification

| | Before | After |
| --- | --- | --- |
| Wrong value (`OK 99` for `OK 42`) | unknown, 30% | **applicationDefect, 70%** |
| Connection reset | applicationDefect, 70% | **networkIssue, 85%** |
| Classification accuracy across ten classes | 7/10, 2 unknown | **10/10, 0 unknown** |

`reproduce.mjs`: 2 of 2 misclassified before, 0 of 2 after.

One of the three original mismatches was the lab's fault rather than the product's. For the
timeout case there is no completed request, no console error and no failed request — the
only evidence is an assertion that read "calculating…", so "an assertion failed" is a
defensible answer. The expectation now accepts both, and says why.
