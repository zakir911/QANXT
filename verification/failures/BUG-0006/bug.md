# BUG-0006 — The recorder's step de-duplication never fires

| | |
| --- | --- |
| **ID** | BUG-0006 |
| **Title** | Consecutive edits to the same field are recorded as one step per change event; the de-duplication in the service worker can never match |
| **Severity** | **LOW** |
| **Found by** | EXT-002, independent browser-extension suite |
| **Environment** | See `verification/environment.md` |
| **Build** | `082c85b` |
| **Component** | `apps/browser-extension/src/background.ts` |
| **Reproduction rate** | 2 of 2 |
| **Status** | Fixed and re-verified (EXT-007) |

## Steps

1. Load the extension into Chromium and start a recording.
2. Edit one field three times, well apart in time — a person correcting a typo:
   `one`, then `two`, then `three`.
3. Read the recording back from the extension.

`node verification/failures/BUG-0006/reproduce.mjs` does exactly this, twice.

## Expected

One `fill` step holding `three`. The service worker says so itself:

> Consecutive edits to the same field are one step: a person filling a box does not think
> of it as one action per keystroke, and neither should the generated test.

## Actual

```
run 1: 3 fill step(s) — one, two, three   (targets identical)
run 2: 3 fill step(s) — one, two, three   (targets identical)
```

Every intermediate value is kept as its own step, including values the person typed and
then corrected. The targets of those steps are byte-identical, so this is not a case the
de-duplication was never meant to cover: it is the exact case it was written for.

## Root cause

The comparison is

```ts
JSON.stringify(previous.target) === JSON.stringify(step.target)
```

where `previous` came back out of `chrome.storage.session` and `step` arrived in a message
from the content script. `chrome.storage.session` does not preserve key order. Measured
directly, in the extension's own service worker:

```
written:   {"strategy":"testId","value":"username","fallbacks":[{"strategy":"role","value":"textbox","name":"Username"}]}
read back: {"fallbacks":[{"name":"Username","strategy":"role","value":"textbox"}],"strategy":"testId","value":"username"}
equal:     false
```

The stored object is alphabetised; the incoming one is in insertion order. The two strings
never match, for any step, so the branch is unreachable and every change event becomes a
step.

## Impact, honestly

Small. The generated test fills the same field several times in a row and the last write
wins, so a test produced from such a recording still passes and still tests the same thing.
What is wrong is the record: the journey claims the person performed actions they corrected,
the step list is longer than the journey it describes, and an intermediate value the person
deleted is persisted in the platform's database. A password is not at risk — that is
substituted in the content script before it is ever sent.

## Suggested fix

Compare the locators structurally rather than by their serialised form — a canonical
key-sorted stringify, or a field-by-field comparison of the descriptor. The comparison must
not depend on the order a storage backend happens to return keys in.

## Note on the check that found it

EXT-002 was written to fire eight change events into one tick and require all eight back.
On a build where this de-duplication worked, seven of those eight would be collapsed
legitimately and the check would have failed for the wrong reason. It now alternates
between two fields, so consecutive steps are never duplicates and the check measures step
loss only. See "Mistakes I made while verifying" in the final report.

## Fix and re-verification

`background.ts` now compares the two descriptors canonically — keys sorted, `undefined`
dropped, recursively — so the comparison no longer depends on the order a storage backend
returns keys in. A step with no locator never merges into another.

Re-verified three ways:

- EXT-007, in a real browser: three edits to one field arrive as one step holding
  `corrected-3`.
- The unit test in `apps/browser-extension/test/recording-state.test.ts`, whose storage stub
  now sorts keys as Chrome does. It fails on the old comparison and passes on the new one.
- `verification/tests/ext-negative-control.mjs` restores the old comparison in the built
  bundle and confirms EXT-007 goes red again.
