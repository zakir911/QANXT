# BUG-0013 — A deterministically produced analysis records no producer

| | |
| --- | --- |
| **ID** | BUG-0013 |
| **Title** | A failure analysis produced by the rules engine stores `ProducedByAi = false` and leaves `Provider` empty, so the API reports `provider: undefined` |
| **Severity** | **LOW** |
| **Found by** | FA-013 (golden failure-analysis suite) |
| **Environment** | See `verification/environment.md` |
| **Build** | `2d18286` |
| **Component** | `apps/api/src/Aira.Application/Diagnosis/FailureAnalysisService.cs` |
| **Reproduction rate** | Every deterministic analysis |
| **Status** | Fixed and re-verified |
| **Status** | Fixed and re-verified |

## What happens

```
providers: local (deterministic), undefined (deterministic)
```

Two of the ten analyses name their producer; the rest carry `provider: undefined`.

## Why it matters

The platform is careful to distinguish an explanation a model wrote from one its own rules
produced — `ProducedByAi` exists for exactly that reason, and the golden suite checks it.
An analysis that says neither who wrote it nor which rules produced it makes that
distinction unreadable in the API and in the console, and an audit of "what did the AI
actually decide here?" cannot be answered from the record.

## Root cause

Both deterministic paths in `AnalyseAsync` construct the analysis without a `Provider`:

```csharp
analysis = new FailureAnalysis
{
    …
    ProducedByAi = false,
    CreatedAt = _clock.UtcNow
};                       // Provider is never set
```

while the model path sets `Provider = result.Provider`.

## Expected

Every analysis names its producer. A deterministic one says so explicitly rather than
leaving the field empty.

## Reproduction

Run any failing test and read `GET /api/v1/executions/{id}` → `failure.analysis.provider`.
`verification/bugs/BUG-0012/reproduce.mjs` exercises the same path.

## Fix

Both deterministic paths now record their producer:

```csharp
ProducedByAi = false,
Provider = DeterministicProvider,   // LlmProviderKind.Local
Model = DeterministicModel,         // "aira-rules-v1"
```

## Re-verification

FA-013 reports every analysis naming its provider, where two of ten previously read
`undefined`.
