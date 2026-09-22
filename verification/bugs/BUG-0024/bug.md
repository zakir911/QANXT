# BUG-0024 — Masking changed the type of every value it redacted, which made a class of contract change invisible

| | |
| --- | --- |
| **ID** | BUG-0024 |
| **Title** | A redacted value was always written as a string, so `"sortCode": null` became `"***REDACTED***"` and a field becoming nullable could not be detected |
| **Severity** | **HIGH** |
| **Found by** | Golden test CON-006, which asserts that a field that can now be null is classified as potentially breaking |
| **Environment** | See `verification/environment.md` |
| **Build** | `18918d1` |
| **Component** | `apps/api/src/Aira.Application/Security/SecretMasker.cs`, `apps/browser-worker/src/security/masker.ts` |
| **Reproduction rate** | 2 of 2 |
| **Status** | Fixed and re-verified |

## What happens

Both maskers redacted a sensitive field by writing a string, whatever the value had been:

```csharp
if (IsSensitiveField(property.Name)) writer.WriteStringValue(Redacted);
```

`sortCode` is a sensitive field name. So the lab bank returning

```json
{ "sortCode": null }
```

was stored as

```json
{ "sortCode": "***REDACTED***" }
```

The contract check compares masked bodies, and both the baseline and the observation went
through the same masker — so both read `string`, and the difference between them vanished.
CON-006 reported it plainly: a fault that makes the field null produced **zero** contract
differences of any kind.

## Why it matters

Two things, and the second is the larger one.

**A whole class of contract change was undetectable.** Any type change on a field whose
name happens to be sensitive — `token`, `pin`, `accountNumber`, `sortCode`, `iban`,
`credentials` and twenty others — was flattened to "string" before anything could compare
it. A field becoming nullable is the single most common potentially-breaking change an API
makes, and on those fields it could not be seen.

**The evidence misdescribed the response.** A report saying a balance was
`"***REDACTED***"` when the API returned a number is not a redaction, it is a wrong answer
about what the application did. The same masker would equally have *invented* a type change
where there was none, had a baseline been captured before a field became sensitive.

The bug is not that masking happens. Masking a sort code is correct. The bug is that
masking was rewriting shapes as a side effect of hiding values.

## Root cause

Redaction was expressed as "replace the value with the redaction marker", and the marker is
a string. Nobody had a reason to care until something downstream started comparing shapes.

A second, smaller fault sat beside it: an object under a sensitive key was replaced by the
marker string as well, so a sensitive object lost its structure entirely.

## Expected

Masking hides values without changing shapes. A redacted string is a string, a redacted
number is a number, a redacted boolean is a boolean, a null stays null, and a sensitive
object keeps its structure with every value inside it redacted.

## Reproduction

```bash
bash test-lab/scripts/lab-ctl.sh start
node verification/golden-tests/run.mjs --suite api-contracts
```

CON-006 enables `FAULT_API_FIELD_NULLABLE`, which makes one account's `sortCode` null, and
requires the change to be classified as potentially breaking. Before the fix: zero changes
found. After: one, correctly classified.

## Fix

Both maskers now redact type-preservingly, and recurse into a sensitive subtree rather than
replacing it:

| Value | Before | After |
| --- | --- | --- |
| `"04-00-72"` | `"***REDACTED***"` | `"***REDACTED***"` |
| `null` | `"***REDACTED***"` | `null` |
| `42` | `"***REDACTED***"` | `0` |
| `true` | `"***REDACTED***"` | `false` |
| `{ "user": "alice", "rotations": 7 }` | `"***REDACTED***"` | `{ "user": "***REDACTED***", "rotations": 0 }` |

Recursing into a sensitive object is strictly safer than it was: every value below it is now
redacted, including ones whose own names are not sensitive, which the previous code would
have left alone had it ever recursed.

## Re-verification

| | Before | After |
| --- | --- | --- |
| CON-006 | FAIL — zero contract differences found | **PASS** — `$.accounts[].sortCode classified "potentiallyBreaking" (string → null\|string)` |
| CON-003 (unchanged API) | pass | pass — still quiet when nothing has moved |
| CON-004, CON-005, CON-007 | pass | pass — the other three classifications are unaffected |
| Masker unit tests | 21 | **24**, covering type preservation, sensitive-subtree recursion and nesting |

Three unit tests were added rather than one, because the interesting part is not that a
null survives: it is that a number stays a number, a boolean stays a boolean, a
non-sensitive sibling is untouched, and a sensitive field nested two levels below another
sensitive one is still redacted.
