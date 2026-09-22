# BUG-0033 — A test data set could be created and never attached to anything

| | |
| --- | --- |
| **ID** | BUG-0033 |
| **Title** | Nothing could point a test case at a data set except AI generation: the update endpoint had no `testDataSetId`, so a hand-authored or imported test could never use one |
| **Severity** | **MEDIUM** |
| **Found by** | Golden test DAT-006, which tried to create a test case using a data set in order to check that deleting the set was refused |
| **Environment** | See `verification/environment.md` |
| **Build** | `c6b6883` |
| **Component** | `apps/api/src/Aira.Api/Controllers/TestCasesController.cs` |
| **Reproduction rate** | 3 of 3 |
| **Status** | Fixed and re-verified |

## What happens

`TestCase.TestDataSetId` is read at dispatch by `TestRunService.ResolveDataAsync`, and is
written in exactly one place:

```
$ grep -rn 'TestDataSetId =' apps/api/src --include=*.cs | grep -v obj/
apps/api/src/Aira.Application/Testing/TestGenerationService.cs:454:  TestDataSetId = dataSet.Id,
apps/api/src/Aira.Application/Testing/TestGenerationService.cs:464:  testCase.TestDataSetId = dataSet.Id;
```

AI generation, and nothing else. `UpdateTestCaseBody` carries name, objective,
preconditions, expected results, priority, risk, tags and enabled — and not the data set.

## Why it matters

It makes the feature reachable only by accident. A team can create a data set through the
new API, see it listed, preview its values — and then have no way to use it, unless they
happen to regenerate the test with AI, which would replace the test they wrote.

It is the same shape as BUG-0028 and the two before it: a capability that exists, is
correct, and has no caller. Here the missing caller is one field on one request body.

It also made the guard in `TestDataService.DeleteAsync` untestable, which is how it was
found: DAT-006 tried to create a test case using a data set so that deleting the set would
be refused, and the delete returned 204 because nothing was using it — nothing *could* be.

## Fix

`testDataSetId` on `UpdateTestCaseBody`, validated to belong to the same project, with an
explicit null meaning "detach":

```csharp
if (body.TestDataSetId is not null)
{
    var setId = body.TestDataSetId.Value;
    if (setId == Guid.Empty) testCase.TestDataSetId = null;
    else if (!await _db.TestDataSets.AnyAsync(s => s.Id == setId && s.ProjectId == testCase.ProjectId, ct))
        return Problem(Error.NotFound("The test data set"));
    else testCase.TestDataSetId = setId;
}
```

Scoped to the project deliberately: a data set from another project would resolve to values
nobody in this one has seen, and the failure would look like an application defect.

## Also fixed in the same change

`TestDataService.PreviewAsync` returned the value of a field marked sensitive instead of
masking it. A secret reference is safe to show — it names a secret — and the branch that
handled both cases returned `field.Value` for each:

```csharp
field.IsSensitive || field.Kind == SecretReference
    ? field.Value ?? SecretMasker.Redacted      // wrong for a plain sensitive field
```

This was in code written in the same phase and never released; DAT-005 caught it before it
was committed, which is the test doing its job rather than a defect in the product as it
stood. Recorded here because it is adjacent, not because it shipped.

## Verification

DAT-006 creates a test case, attaches the data set through the update endpoint, requires the
delete to be refused with 409, detaches it and requires the delete to then succeed. DAT-005
requires neither the read nor the preview to contain a sensitive value, scanned against the
response body rather than a parsed field.
