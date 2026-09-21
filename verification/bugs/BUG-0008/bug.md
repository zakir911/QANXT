# BUG-0008 — The sign-in page is never part of the application model

| | |
| --- | --- |
| **ID** | BUG-0008 |
| **Title** | Discovery signs in before it starts crawling and never records the sign-in page, so no test can be generated for it |
| **Severity** | **HIGH** |
| **Found by** | DISC-002, DISC-004, DISC-006, DISC-007 (golden discovery suite) |
| **Environment** | See `verification/environment.md` |
| **Build** | `fc9a034` |
| **Component** | `apps/browser-worker/src/discovery/crawler.ts` |
| **Reproduction rate** | 2 of 2 under `reproduce.mjs`, and on every discovery run observed so far |
| **Status** | Fixed and re-verified |

## What happens

Discovery maps ten pages of the lab bank and none of them is `/login`:

```
/accounts  /accounts/:id ×3  /beneficiaries  /dashboard  /payments  /profile
/statements  /transactions
```

The sign-in fields are absent from the element model too — `username`, `password` and
`login-submit` are all missing, in both attempts.

## Why it matters

Three of the five requirements the brief asks a generator to satisfy are about the sign-in
screen:

- "Customer can login and view account balance."
- "Customer cannot login with invalid credentials."
- and every journey that begins by signing in.

Generation works from the discovered model. With no login page and no sign-in elements in
it, those tests cannot be generated at all, and the most commonly broken screen in any
application — the one the healing story is usually told about — is the one the platform
knows least about.

It also makes the model quietly wrong: a reader of the knowledge graph would conclude the
application has no sign-in screen.

## Root cause

`Crawler.run` authenticates first and then seeds the queue with the base URL:

```ts
const login = await this.authenticate(page);      // navigates to /login, fills, submits
…
const queue: QueueEntry[] = [{ url: this.options.baseUrl, depth: 0 }];
```

The browser is on the login page during `authenticate`, but nothing captures it, and by
the time the crawl starts the session exists — so any later visit to `/login` is redirected
to `/dashboard` by the application, exactly as it would be for a signed-in user. The page
is therefore unreachable for the rest of the run.

This is not specific to the lab: every application that redirects a signed-in user away
from its login screen behaves this way, which is nearly all of them.

## Expected

The sign-in page appears in the model, marked as not requiring authentication, with its
fields, its submit control and its links captured — the same treatment every other page
gets.

## Reproduction

```bash
bash test-lab/scripts/lab-ctl.sh start
node verification/bugs/BUG-0008/reproduce.mjs
```

## Fix

`Crawler.run` now maps the sign-in page before it signs in, through the same `visit()` path
every other page goes through, marking it visited so the crawl does not queue it again.
Failure to capture it is noted and does not abort the run — the page is worth having, but
not at the cost of a whole crawl.

## Re-verification

| | Before | After |
| --- | --- | --- |
| Pages discovered | 10 | **11** |
| `/login` in the model | no | **yes** |
| `username`, `password`, `login-submit` | 0 of 3 | **3 of 3** |
| Page recall against ground truth | 88.9% | **100%** |

`reproduce.mjs` reports `reproduced 0 of 2`.
