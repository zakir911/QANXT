# BUG-0025 — The failing step was never identified, because the worker streams its actions and the analyser read the completion

| | |
| --- | --- |
| **ID** | BUG-0025 |
| **Title** | `completion.Actions` is always empty, so every failure was recorded with no step: null `TestActionId`, a signature without a step order, and a classifier falling back to matching message prose |
| **Severity** | **HIGH** |
| **Found by** | Golden test COR-003, which required a diagnosis to name the endpoint the failing step called |
| **Environment** | See `verification/environment.md` |
| **Build** | `fbe49d1` |
| **Component** | `apps/api/src/Aira.Application/Diagnosis/FailureAnalysisService.cs` |
| **Reproduction rate** | 3 of 3 |
| **Status** | Fixed and re-verified |

## What happens

The worker reports each action as it finishes:

```ts
onActionCompleted: action => client.executionAction(job.executionId, action)
```

By the time the completion arrives, those actions are rows in the database and the
completion's own `Actions` list is empty. `ExecutionCompletionPayload.Actions` even says so:
*"Present when the worker streamed actions; otherwise the completion carries them."*

`RecordFailureAsync` read the list:

```csharp
var failedAction = completion.Actions.FirstOrDefault(a => a.Status == ExecutionStatus.Failed);
```

It was always null. Four things followed from that, none of which failed anything:

- `Failure.TestActionId` was always null, so no failure was ever linked to the step it
  happened on.
- The failure signature was computed with a null step order, so the same message at two
  different steps was one failure.
- `ClassificationInput.FailingAction` was always null, so the classifier fell back to
  matching the prose of error messages — the exact fallback BUG-0012 was fixed to stop
  relying on.
- The API correlation added in this phase had no step to correlate to, so it found nothing
  in every case, and every verdict fell through to the uncorrelated count.

COR-003 made it visible: the diagnosis said *"The application returned server errors during
this execution"* at 90% when the evidence supported *"POST /api/session → 500"* at 95%.

## Why it matters

Three of these were silent for as long as the streaming path has existed. Each one degrades
a claim the product makes:

- "Every failure is linked to the step that produced it" was not true.
- "Assertion failures are identified structurally, not by message text" was not true —
  BUG-0012's fix was in place and unreachable.
- Two failures with the same message at different steps clustered as one.

None of them produced a wrong verdict often enough to be noticed, which is what made this
the kind of defect that survives.

## Root cause

Two reasonable decisions that were never reconciled: the worker streams actions so a run
can be watched live, and the analyser was written against a payload that carries them. The
contract documented the ambiguity in a comment and nothing enforced it.

## Expected

The failing step is identified from whatever source has it. When the completion carries
actions, use them; when it does not, read the stored ones, which the streaming path has
already written.

## Reproduction

```bash
bash test-lab/scripts/lab-ctl.sh start
node verification/golden-tests/run.mjs --suite correlation
```

COR-003 runs an API test whose request is answered 500 and requires the diagnosis to name
the method, path and status. Before the fix: the uncorrelated verdict, naming nothing.
After: `POST /api/session → 500 in 8ms`.

## Fix

`RecordFailureAsync` falls back to `StoredFailingActionAsync`, which reads the first
non-passing action by order from `TestActions` — by order, so a test that failed at step
four and was then abandoned is attributed to step four rather than to whatever was written
last. The resolved action is then used for the signature, the `TestActionId`, the
classifier's `FailingAction` and the correlation, rather than each re-deriving it.

`ReanalyseAsync` and the AI analysis context were reading the same empty list and now use
the same resolved action.

**One consequence worth stating:** failure signatures now include the step order, so a
recurring failure recorded before this fix will be seen as new once, and then settle. That
is the correct behaviour arriving late rather than a regression — the same message at two
different steps is two problems.

## Re-verification

| | Before | After |
| --- | --- | --- |
| COR-003 | "The application returned server errors during this execution", 90% | **"The step failed because the API call it made returned 500"**, 95%, naming `POST /api/session → 500 in 8ms` |
| COR-002 | the uncorrelated count | the correlated verdict, naming `/api/accounts/acc-1001/transactions` |
| COR-005 | `authenticationIssue`, 0 API calls seen | **"The API answered correctly and the page showed something else"**, 80% |
| Correlation suite | 3 of 7 | **7 of 7** |
| Unit tests | 244 | **265** |

A second, smaller gap was closed beside it: `IFailureAnalysisService.ReanalyseAsync` existed
and no controller exposed it, so a failure diagnosed before the correlation existed could
never be given the better answer. `POST /api/v1/failures/{id}/reanalyse` now does, and
COR-007 proves the correlation survives the round trip through storage rather than being
carried forward in memory.
