# False positives

## Why precision matters more than recall here

A functional test that fails wrongly costs somebody an hour. A security finding that is wrong
costs trust, and trust is the only thing that makes the next finding get read. A team that has
dismissed four AIRA findings will dismiss the fifth without opening it, and the fifth is the
one that mattered.

So every check here is built to be quiet unless it is sure, and every check is measured
against a corrected application as well as a broken one.

## How it is measured

The security lab has 35 planted flaws and 8 endpoints that are deliberately correct. For every
scenario the golden suite runs the check twice:

- **SECD** — the flaw switched on **alone**, every other fault in that lab switched off. The
  check must report it. Isolating the flaw is what makes the result mean something: with six
  flaws on at once, a check keyed on entirely the wrong signal still finds *something*.
- **SECP** — the flaw switched off. The check must report nothing.

And separately:

- **SECS** — the endpoints the ground truth calls correct, with the lab left **fully
  vulnerable**. That is when false positives actually happen: a scanner that has just found
  four real flaws is the one most likely to invent a fifth.

The measured result is in `SECR-001` and in the security report. It describes this lab.

## The cases the lab exists to catch

| Endpoint | What a careless detector does |
| --- | --- |
| `GET /greet?name=` | reports XSS because input was reflected — it was reflected *escaped* |
| `GET /echo?value=` | reports XSS on reflection into JSON, which is not an HTML context |
| `GET /api/public` | reports dangerous CORS on a wildcard origin with no credentials |
| `GET /strict` | reports a cookie finding on a fully attributed session cookie |
| `GET /api/accounts` | reports BOLA on a collection that returns only the caller's own rows |
| `GET /api/accounts/{id}` (api lab) | reports BOLA on an endpoint that enforces ownership |
| `POST /api/password-reset` | reports enumeration on an endpoint that answers identically either way |
| `GET /api/fetch?url=<own origin>` | reports SSRF on an endpoint that accepts only itself |

Each of those is a golden test. Each fails if a check reports anything.

## Setting a finding aside

A finding is set aside through `triage`, which **refuses** rather than warns:

- no justification → refused;
- no named decision-maker → refused;
- a justification under twenty characters → refused, because "not real" is not a reason.

A false-positive mark with no reason behind it is somebody switching the check off, and a
workflow that accepts it quietly is how a security gate becomes decoration. The gate closes
the loop: a suppressed finding missing either field is **counted as open** and fails the
build.

Decisions **append to a history** rather than overwriting a status field. A field holding only
the latest answer is not an audit trail.

## A suppression covers one finding

Suppressions are keyed to a fingerprint — application, category, endpoint, parameter, observed
role. Marking one endpoint's BOLA finding a false positive says something about that endpoint.
Applying it to every BOLA finding in the application would hide real ones. `SECT-007`.

## What happens when a suppressed finding gets worse

The triage decision carries forward to the next scan; the severity does not. A flaw somebody
accepted at Medium that is now Critical should not inherit the old severity along with the
decision. `SECB-005`.
