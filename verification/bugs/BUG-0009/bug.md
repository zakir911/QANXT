# BUG-0009 — A recorded journey that signs in cannot be replayed

| | |
| --- | --- |
| **ID** | BUG-0009 |
| **Title** | The platform signs in automatically and then replays the test's own sign-in steps, which fails on any application that redirects an authenticated visitor away from its login page |
| **Severity** | **HIGH** |
| **Found by** | EXEC-001, EXEC-018, EXEC-019 (golden execution suite) |
| **Environment** | See `verification/environment.md` |
| **Build** | `399446c` |
| **Component** | `apps/browser-worker/src/execution/executor.ts` |
| **Reproduction rate** | 3 of 3 — three independent journeys, same failure, in one run |
| **Status** | Open |

## What happens

Three imported journeys that begin by signing in all failed at their second step:

```
order 2  fill  "Enter a value in username"   FAILED after 15056ms
url      http://localhost:4300/dashboard
error    testId="username" could not be used: No element matched testId="username".
```

The browser was on `/dashboard`, not `/login`, before the test had done anything. The
platform had already signed in using the credentials configured on the application, so
the test's own first step — navigate to `/login` — was redirected straight back to the
dashboard, where there is no username field.

## Why it matters

This breaks the product's own recommended workflow. The browser extension records what a
person did, *including* signing in — that is precisely why it substitutes
`${secret:app_password}` for the password field rather than dropping the step. The journey
is then imported and executed. On any application that redirects a signed-in visitor away
from its login screen, which is most of them, that test can never pass.

Both features work in isolation. Together they contradict each other, and the failure is
attributed to the application under test rather than to the platform.

The product's own demo bank re-renders the login form for a signed-in visitor instead of
redirecting, which is why its end-to-end checks never showed this.

## Root cause

`TestExecutor.execute` performs the configured form login unconditionally:

```ts
if (auth.strategy === 'formLogin') {
  const login = await performLogin(page, auth, …);
  …
}
```

There is no way for a test to say "I sign in myself", and no inspection of what the test
is about to do.

## Expected

A test whose first navigation is to the configured login URL is understood to be signing
in itself, and the automatic sign-in is skipped. Every other test still gets the session
it expects.

## Fix

The executor now compares the test's first `navigate` step against the configured login
URL — by origin and path, so a query string or trailing slash does not change the answer —
and skips the automatic sign-in when they match, noting that it did so. Only the first
navigation counts: a journey that visits the login page halfway through, to sign out and
back in, still starts from the session it was given.

## Reproduction

```bash
bash test-lab/scripts/lab-ctl.sh start
node verification/bugs/BUG-0009/reproduce.mjs
```

Imports and executes two journeys against an application that has credentials configured:
one that signs in itself (must pass) and one that assumes it is already signed in (must
also pass). Before the fix the first failed; both must pass after it.

`evidence/pre-fix-actions.json` holds the failing action from the golden run that found it.
