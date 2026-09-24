# The security lab

Seven deliberately vulnerable applications under `test-lab/security/`. They exist so that
AIRA's security claims can be measured rather than asserted: a detector tested only against
applications that happen to be broken in the ways you expected is not tested at all.

Everything in them is synthetic. Every identity is fictional, every account number is
invented, every balance is a round number so a leak is unmistakable in evidence rather than
something to argue about. Nothing is persisted between runs beyond what `/__reset` clears.

| Port | Application | What it gets wrong |
| --- | --- | --- |
| 4400 | `auth-lab` | user enumeration, no lockout, session survives sign-out, 30-day sessions, reusable reset tokens |
| 4401 | `access-control-lab` | BOLA, vertical escalation, a read-only account that can write, an endpoint with no authorization at all |
| 4402 | `api-lab` | unverified tokens, mass assignment, no input validation, unauthenticated DELETE, no rate limit, password hashes in responses |
| 4403 | `xss-lab` | reflected, stored and DOM XSS — **and two endpoints that reflect safely** |
| 4404 | `csrf-upload-lab` | no CSRF token, no origin check, unrestricted upload, no size limit, path traversal in filenames, open redirect, SSRF |
| 4406 | `headers-lab` | no CSP, weak cookie, reflected CORS with credentials, directory listing, verbose errors, exposed source map |
| 4408 | `injection-lab` | SQL, NoSQL, command and template injection |

## The parts that are correct on purpose

Eight endpoints across the lab are deliberately right, and they are not filler. They are how
precision gets measured:

- `GET /greet?name=` reflects **escaped** — a detector reporting XSS here is wrong.
- `GET /echo?value=` reflects into **JSON** — not an HTML context.
- `GET /api/public` sets a wildcard origin with **no credentials** — how a public API works.
- `GET /strict` sets every header and a fully attributed cookie.
- `GET /api/accounts` returns only the caller's own rows.
- `GET /api/accounts/{id}` (api lab) enforces ownership correctly.
- `POST /api/password-reset` answers identically for a real and an absent account.
- `GET /api/fetch?url=<own origin>` accepts only its own origin.

## Nothing dangerous actually happens

The labs reproduce the *observable behaviour* of a flaw, not the flaw itself:

- the injection lab has **no database, no shell and no template engine**. It returns the error
  an injectable application returns, and a tautology widens a result set held in memory.
- the upload endpoint **writes nothing to disk**. It reports what it would have stored, which
  is what the path-traversal check reads.
- the SSRF endpoint **fetches nothing**. It reproduces the decision an application makes about
  a destination — accept or refuse — which is the part a detector can see.
- the transfer endpoint **moves no money**, so a second run does not depend on the first.

## Every flaw is independently switchable

Each vulnerability is a fault in the same `/__faults` registry as the functional lab's, which
means a test discovers them rather than keeping its own list, and a false-positive scenario is
built by switching one **off** through the same API.

This is what makes the SECD/SECP pairing possible: the same check run against the flaw and
against its correction. `isolateFaults` switches every fault off except the ones named, so a
check keyed on the wrong signal fails rather than passing by coincidence.

One detail worth naming, because it was a bug: `/__faults/reset` originally restored every
fault to *off*, which quietly repaired the planted vulnerabilities. Every detection test would
then have been meeting a correct application. Security faults now carry `defaultEnabled: true`
and reset restores them to on.

## Ground truth

`test-lab/security/ground-truth.json` names, for each application, every planted flaw — its
id, type, endpoint, severity, CWE, OWASP category and how to detect it — and every endpoint
that is deliberately correct, with why reporting it would be a false positive.

`test-lab/security/audit-ground-truth.mjs` exercises each one directly over HTTP and fails if
the lab and the file disagree. It runs **before** anything is measured, in
`./scripts/verify-security`, because if they disagree then a "missed detection" might be a
vulnerability that was never there and a "false positive" might be a real flaw nobody wrote
down — and every number downstream would be taken with a broken ruler.

45 checks at the time of writing, all agreeing.

## Running it

```bash
bash test-lab/scripts/lab-ctl.sh start     # all labs, functional and security
bash test-lab/scripts/lab-ctl.sh reset
node test-lab/security/audit-ground-truth.mjs
```
