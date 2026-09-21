# BUG-0018 — The API reference renders blank

| | |
| --- | --- |
| **ID** | BUG-0018 |
| **Title** | `Content-Security-Policy: default-src 'none'` blocks the stylesheet, script and images of the API's own reference page, so the URL the documentation points at renders nothing |
| **Severity** | **MEDIUM** |
| **Found by** | Writing the installation guide — the page would not photograph |
| **Environment** | See `verification/environment.md` |
| **Build** | `8b20cf3` |
| **Component** | `apps/api/src/Aira.Api/Program.cs` |
| **Reproduction rate** | 2 of 2 |
| **Status** | Fixed and re-verified |

## What happens

`docs/setup.md` and the README both tell a reader to open
`http://localhost:5080/swagger` as the API reference and as a check that the control plane
is answering. The page loads, returns 200, and is blank.

```
attempt 1: .swagger-ui present: false; 9 resource(s) refused by the policy
    Refused to load the stylesheet 'http://127.0.0.1:5080/swagger/swagger-ui.css' …
    Refused to load the script     'http://127.0.0.1:5080/swagger/swagger-ui-bundle.js' …
```

Nine same-origin resources refused. The HTML arrives; nothing that makes it a page does.

## Why it matters

It is the first thing the setup guide asks a newcomer to open, and a blank page after a
fresh install is indistinguishable from a broken install. Someone following the
instructions has no way to tell which they are looking at.

It is not a security defect: nothing is exposed that was not exposed before, and the
reference is only served in Development.

## Root cause

The API sets one policy for every response:

```csharp
headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'";
```

That is exactly right for an endpoint that only ever answers JSON, and it was written when
that was all this application served. Swagger UI is the one page it serves as HTML, and it
loads its own stylesheet, script and icons from the same origin — all of which
`default-src 'none'` forbids.

## Expected

The API reference renders. Every other path keeps `default-src 'none'`.

## Reproduction

```bash
bash scripts/api-ctl.sh start
node verification/bugs/BUG-0018/reproduce.mjs
```

Loads the page twice in a real browser and reports whether Swagger UI rendered and what the
browser refused.

## Fix

The relaxed policy applies only to `/swagger`, only when the reference is served at all
(Development), and only to the same origin:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'
```

`'unsafe-inline'` is confined to `style-src`, because Swagger UI injects styles at runtime.
Scripts stay same-origin with no inline allowance, nothing external may load on any path,
and every route other than `/swagger` is unchanged.

## Re-verification

| | Before | After |
| --- | --- | --- |
| `reproduce.mjs` | 2 of 2 rendered nothing, 9 resources refused each time | **0 of 2** — renders, 0 refused |
| `SEC-G10` (the API sets the security headers it claims to) | passed | passed |
| `tests/e2e/security-check.mjs` headers | passed | passed |
