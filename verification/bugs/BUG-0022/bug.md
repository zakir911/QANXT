# BUG-0022 — A reference inside a longer string was left in place, and the 404 it caused looked like an application defect

| | |
| --- | --- |
| **ID** | BUG-0022 |
| **Title** | `${data:...}` and `${secret:...}` only resolved when they were the entire value, so a templated API path kept its placeholder |
| **Severity** | **HIGH** |
| **Found by** | Executing a chained API test: capture an account id, then read that account's transactions |
| **Environment** | See `verification/environment.md` |
| **Build** | `585c679` (during development) |
| **Component** | `apps/browser-worker/src/execution/executor.ts`, `execution/api-runner.ts`, `execution/action-runner.ts` |
| **Reproduction rate** | 1 of 1 |
| **Status** | Fixed and re-verified |

## What happens

`resolveReference` matches a whole string:

```ts
const data = /^\$\{data:([A-Za-z0-9_.-]+)\}$/.exec(raw);
```

That is right for a browser step value, where the reference *is* the field. It is wrong for
a request path, which is a template. The second step of a chained API test went out
verbatim:

```
GET http://127.0.0.1:4322/api/accounts/$%7Bdata:accountId%7D/transactions → 404 Not Found
```

## Why it matters

The failure is indistinguishable from the application being broken. The report says a
route returned 404; the route exists and works. Someone spends a morning looking for a
missing endpoint.

It also removed the point of capturing a value at all. Chaining — create, then read back
what was created — is most of what an API test does beyond a single call, and the only
place the captured value naturally goes is the middle of a path.

## Root cause

One resolver was used for two jobs that are not the same job. Whole-string replacement and
template interpolation look similar enough that the difference was never stated, so the
API runner reached for the resolver that was already on the context.

## Expected

Every reference inside a path, query value, header value or request body is substituted.
An unknown name throws, exactly as a whole-string reference does — leaving the placeholder
in place is what caused the misleading 404 in the first place.

## Fix

- `ActionContext` gains `resolveTemplate`, documented alongside `resolveValue` so the
  difference between the two is on the page rather than in someone's head.
- `interpolateReferences` in the executor substitutes every occurrence and throws on an
  unknown secret or data field, with the same messages `resolveReference` uses.
- The API runner uses `resolveTemplate` for the path, every query value, every header
  value and the body. Browser steps keep whole-string semantics: changing them was not
  needed and would alter the behaviour of every existing test.

## Re-verification

A worker test drives the real chain against the real Demo Bank:

```
✓ an API request reuses the session a UI login established, and chains captured values
```

It captures `accounts[0].id` from `GET /api/accounts`, substitutes it into
`/api/accounts/${data:accountId}/transactions`, and asserts the recorded URL matches
`/api/accounts/acc-\d+/transactions` — so the test fails if the placeholder ever returns
rather than merely if the request 404s.

| | Before | After |
| --- | --- | --- |
| Second step | 404, placeholder in the URL | 200, `/api/accounts/acc-1001/transactions` |
| Reported cause | looks like a missing route in the application | n/a |
