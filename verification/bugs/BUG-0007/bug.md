# BUG-0007 — Discovery cannot sign in to a single-page application

| | |
| --- | --- |
| **ID** | BUG-0007 |
| **Title** | The platform posts the correct credentials to a single-page application, then reports that the credentials are probably wrong |
| **Severity** | **CRITICAL** |
| **Found by** | Test lab, first discovery run against the React banking application |
| **Environment** | See `verification/environment.md`; lab bank at `http://localhost:4300` |
| **Build** | `2e833d3` |
| **Component** | `apps/browser-worker/src/browser/authenticator.ts` |
| **Reproduction rate** | 4 of 4 by hand, then 2 of 2 under `reproduce.mjs` |
| **Status** | Fixed and re-verified |

## What happens

Discovery against the lab's React bank fails in about six seconds with:

```
Authentication failed: The browser is still on the login page with a password field
visible; the credentials are probably wrong.
```

The credentials are not wrong. The application under test records every sign-in it is
asked to perform, and it received exactly one, with the right username and a password of
the right length, **five milliseconds before the run was declared failed**:

```json
{ "at": "2026-09-21T03:05:55.847Z", "username": "alice", "passwordLength": 12,
  "userAgent": "… HeadlessChrome/141.0.7390.37 …" }
```

```
run completedAt: 2026-09-21T03:05:55.852Z
```

## Why it matters

This is not a corner case. Every application built with React, Vue, Angular or Svelte signs
in this way: the submit handler calls an API and routes on the client when the promise
resolves. There is no document navigation to wait for.

For those applications the platform cannot discover anything at all — the crawl aborts
before its first page, because continuing without a session would map the login page
repeatedly. Discovery, generation and every test that depends on a signed-in session are
unavailable against exactly the kind of application the product exists to test.

The product's existing demo bank is server-rendered, so its own end-to-end checks never
exercised this path. That is how a defect this size stayed invisible: the only target
application was one where a click always caused a navigation.

## Root cause

`performFormLogin` clicks the submit control and then verifies, with no wait in between
that can observe an asynchronous sign-in:

```ts
await Promise.all([
  page.waitForLoadState('domcontentloaded', …).catch(() => undefined),
  submit.locator.click(…)
]);

await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);

// verification follows immediately
```

Both waits are no-ops for a single-page application:

- `waitForLoadState('domcontentloaded')` resolves immediately because the document is
  already loaded — no navigation is coming.
- `waitForLoadState('networkidle')` resolves immediately as well: Playwright returns as
  soon as the page is *currently* in that state, and the page was idle when the call was
  made. The `fetch` that the click starts has not been issued yet.

So the verification runs while the sign-in request is still in flight. It finds the browser
on the login page with a password field visible — which is exactly what a wrong password
looks like — and reports that.

The five-millisecond gap between the request arriving at the application and the run being
declared failed is the whole defect in one number.

## Expected

After submitting, the platform waits — up to the configured action timeout — for one of the
outcomes that means the sign-in finished: the URL left the login page, the password field
disappeared, the configured success locator appeared, or an error message was rendered.
Only then does it decide.

## Reproduction

```bash
bash test-lab/scripts/lab-ctl.sh start
node verification/bugs/BUG-0007/reproduce.mjs
```

Runs discovery twice against the React bank and reads the bank's own record of what it was
sent. Evidence in `evidence/reproduction.json`.

## Fix

`waitForSignInOutcome` now runs between the click and the verification. It polls, up to the
action timeout, for whichever signal this application produces: a configured success
locator appearing, a configured success fragment in the URL, the URL leaving the login
page, the password field disappearing, or an error being rendered. It returns as soon as
one of them holds, so nothing is slowed down by a fixed sleep.

Waiting for the *error* signal as well as the success ones is what keeps a real
authentication failure fast: the report still arrives in seconds rather than after the full
timeout.

## Re-verification

| | Before | After |
| --- | --- | --- |
| Discovery against the React bank | `failed`, 0 pages, ~6s | `completed`, **10 pages**, both attempts |
| Wrong password (`alice` / 25-character wrong password) | `failed` | `failed`, 8s, "the credentials are probably wrong" — unchanged |
| Worker unit tests | 81 passed | 81 passed |

`reproduce.mjs` now reports `reproduced 0 of 2`, and the bank's own record shows the same
single sign-in attempt in both cases — the difference is what the platform does after it.

The negative case matters as much as the positive one: a fix that made every sign-in
"succeed" would have turned a broken login into a green crawl, which is worse than the
defect it replaced.
