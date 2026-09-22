# BUG-0032 — Seeded test data was not reproducible, which is the only thing a seed is for

| | |
| --- | --- |
| **ID** | BUG-0032 |
| **Title** | `uuid` ignored the seed entirely, and `date`/`futureDate` were generated relative to today, so a seeded field produced a different value on a different day |
| **Severity** | **HIGH** |
| **Found by** | Inspecting `TestDataGenerator` against its own documented contract while building the test data surface, then executing it to confirm |
| **Environment** | See `verification/environment.md` |
| **Build** | `c6b6883` |
| **Component** | `apps/api/src/Aira.Application/Testing/TestDataGenerator.cs` |
| **Reproduction rate** | 3 of 3 |
| **Status** | Fixed and re-verified |

## What happens

`TestDataGenerator` states its contract in its own summary:

> Generation is seedable, and a seeded field produces the same value on every run. That
> matters more than it sounds: a test that fails only on Tuesdays because it generated a
> different email address is indistinguishable from a real defect, and costs the same
> investigation.

Two of its types did not honour it.

**`uuid` ignored the seed.** Executed:

```
customerEmail  seed=42  first=aira.tomas.2268@example.test  second=aira.tomas.2268@example.test  same=True
orderId        seed=42  first=96602add-9a19-4e06-b8af-…     second=9743327e-5d28-491d-ba6a-…     same=False
```

Two calls, same seed, same process, different values. The implementation was
`"uuid" => Guid.NewGuid().ToString()`, which never consults `random` at all.

**`date` and `futureDate` drifted with the calendar.** The offset is seeded and therefore
stable; the base is `DateTime.UtcNow`, which is not:

```
seed=7 today=2026-09-22 value=2026-02-08 offset=226 days
=> tomorrow the same seed yields 2026-02-09, a different value
```

Reproducible within a day, different the next. That is the exact failure mode the comment
warns about, in the code the comment is attached to.

## Why it matters

A seed exists so that a failure can be reproduced. When the data moves underneath it:

- A test that fails on a boundary date passes when you re-run it, and the investigation
  ends in "could not reproduce".
- A test that passes today fails tomorrow with no change to the application or the test,
  and the first suspicion falls on the application.
- Re-running a failed run — which AIRA does on retry — can silently exercise different
  data from the attempt that failed, so the retry proves nothing about the failure.

`uuid` is the worse of the two, because an identifier is exactly the sort of field a test
asserts on.

## Root cause

Both are the same mistake: reaching for an ambient source of entropy instead of the seeded
one that was already in hand. `Guid.NewGuid()` and `DateTime.UtcNow` are each a global that
the seed cannot reach.

Nothing enforced the contract. Every other type threaded `random` through, so the rule was
visible in the code and not checked by anything — and the two exceptions looked ordinary.

## Fix

- `uuid` is derived from the seeded `Random` when a seed is given, by filling the bytes
  from it and setting the version and variant bits so it is still a well-formed v4 UUID. An
  unseeded field still uses `Guid.NewGuid()`, which is right: without a seed, nothing was
  promised.
- `date` and `futureDate` count from a fixed epoch rather than from today when a seed is
  given, so the value is stable for ever. Unseeded fields keep the relative-to-today
  behaviour, which is what somebody who did not ask for reproducibility wants.
- `TestDataGeneratorTests` now asserts the contract for **every** type the generator
  supports, by enumerating them rather than listing them, so a type added later cannot
  quietly opt out.

## Verification

`apps/api/tests/Aira.UnitTests/Testing/TestDataGeneratorTests.cs` generates every supported
type twice with the same seed and requires equality, and generates with two different seeds
and requires difference. The date types are additionally checked against a fixed expected
value, which is what would have caught the drift.

Golden test DAT-002 exercises the same property through the platform: the same seeded data
set resolved twice yields identical values.
