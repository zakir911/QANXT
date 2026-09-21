# BUG-0014 — Text and value assertions do not wait for what they expect

| | |
| --- | --- |
| **ID** | BUG-0014 |
| **Title** | `assertText`, `assertValue`, `assertAttribute` and `assertCount` read the element once, so any asynchronously rendered value fails |
| **Severity** | **HIGH** |
| **Found by** | REL-002, REL-003 (golden reliability suite) |
| **Environment** | See `verification/environment.md` |
| **Build** | `98c0687` |
| **Component** | `apps/browser-worker/src/execution/action-runner.ts` |
| **Reproduction rate** | 2 of 2 |
| **Status** | Fixed and re-verified |

## What happens

The same page, the same test, two variants:

```
healthy (answer is immediate)   run passed, assertion passed after 39ms
slow    (answer after 3s)       run FAILED, assertion failed after 17ms
                                "Expected the element to contain "OK 42" but it read "calculating…"."
```

Seventeen milliseconds. The assertion read the element once, while the page was still
waiting for its data, and called that a failure.

Against the lab's genuinely unstable case — which answers after 100ms, 800ms, 2.5s or 6s at
random — **all twenty runs failed**, including the ones the application answered in a tenth
of a second.

## Why it matters

Every application built in the last fifteen years renders its values asynchronously. An
assertion that reads once and gives up turns each of those into a false failure, and the
advice it forces on a user — scatter explicit waits through every test — is exactly the
brittleness an automated testing platform is supposed to remove.

It also makes the platform's own flakiness measurement meaningless: a test that fails
whatever the application does cannot distinguish a flaky application from a stable one.
REL-003 shows the consequence — twenty executions, 0 passed, 20 failed, flakiness score 0.

The platform already does the right thing elsewhere: `assertVisible` waits for the element
to become visible, up to the action timeout. Only the assertions that compare a *value*
read once. That inconsistency is the bug.

## Root cause

```ts
case 'assertText': {
  const locator = await locate(page, target, timeout);
  const actual = (await locator.textContent({ timeout }))?.replace(/\s+/g, ' ').trim() ?? '';
  if (!actual.includes(expected.trim())) { throw new ActionError(…); }
  return;
}
```

The `timeout` is passed to `textContent`, which is the timeout for *finding* the element,
not for the text becoming what the test expects. Once the element exists, the comparison
happens immediately and only once. `assertValue`, `assertAttribute` and `assertCount` have
the same shape.

## Expected

A value assertion waits, up to the action timeout, for the expected value to appear, and
reports the last value it saw when it gives up — the behaviour `assertVisible` already has,
and the behaviour Playwright's own `expect` provides.

A failing assertion will then take longer to fail, because it waits out the timeout before
concluding. That is the correct trade-off and the same one every mature assertion library
makes.

## Reproduction

```bash
bash test-lab/scripts/lab-ctl.sh start
node verification/bugs/BUG-0014/reproduce.mjs
```

## Fix

`action-runner.ts` gained `waitForValue(timeoutMs, read, satisfied)`: it re-reads the
element until the expectation holds or the action's timeout expires, and reports the time
it waited in the failure message so a reader can tell a slow page from a wrong value. It is
used by `assertText`, `assertValue`, `assertAttribute` and `assertCount`.

The wait is the action's own timeout, not a new fixed sleep: an assertion that holds
immediately still returns in tens of milliseconds.

## Re-verification

```
attempt 1 healthy : run passed, assertion passed after 35ms
attempt 1 slow    : run passed, assertion passed after 6118ms
attempt 2 healthy : run passed, assertion passed after 39ms
attempt 2 slow    : run passed, assertion passed after 6041ms
0 of 4 runs gave the wrong verdict
```

A fast page is still fast; a page that answers after three seconds is now waited for.

| | Before | After |
| --- | --- | --- |
| `reproduce.mjs` | 2 of 4 wrong (both slow runs) | **0 of 4** |
| REL-002 (20 runs against the unstable application) | 0 passed / 20 failed | 10 passed / 10 failed, matching the delays the application recorded serving |
| EXEC-017 (late-arriving content) | n/a — written with this fix | passed; the assertion waited 6401ms for content rendered after about 2.5s |
| A failing assertion | failed in 17ms | still fails, after the action timeout, saying how long it waited |

The last row is the one that matters: an assertion that waits is only an improvement if a
genuinely wrong value still fails. `ASRT-002` and `ASRT-004` check exactly that, and report
the wait in the message — `Expected the value "999" but found "250" (waited 15060ms)`.
