# Evidence

A finding is a claim. Evidence is what makes it checkable by somebody who was not there.

## What is written

For each finding, under `verification/evidence/<TEST-ID>/<RUN_ID>/`:

| File | What it is |
| --- | --- |
| `request.txt` | The requests exactly as sent, headers and body |
| `response.txt` | The responses exactly as received |
| `sanitized-request.txt` | The same, with credentials removed |
| `sanitized-response.txt` | The same, with credentials removed |
| `reproduction.md` | What was sent, what came back, why that is a finding, and how the severity was reached |
| `metadata.json` | Category, severity with its factors, confidence, CWE, OWASP, endpoint, role, timestamps |
| `sha256.txt` | A digest over the sanitized pair |

Reports link to the **sanitized** copies. The raw pair exists because a person investigating a
finding sometimes needs the byte that was redacted, and deleting it would make the finding
unreproducible.

## A finding with no exchange is refused

```js
if (!Array.isArray(exchanges) || exchanges.length === 0) {
  throw new Error(`Refusing to write evidence for ${findingId}: no request/response exchange
    was supplied. A finding with nothing to show is a claim, not a finding.`);
}
```

It throws rather than warning. `SECE-001` proves it. The brief forbids calling a vulnerability
confirmed without reproducible evidence, and a writer that silently accepted an empty list
would make that rule unenforceable.

The gate takes the other half: a finding arriving with `hasEvidence: false` is neither failed
nor dismissed. It goes to REVIEW. Dropping it silently would be worse than saying so.

## Redaction

`redactText` removes bearer tokens, password fields, API keys, private keys and connection
strings with embedded credentials, plus any literal the check names (the `redactLiterals`
field a finding can carry, used by the excessive-data check for the exact secret values it
saw).

`SECE-002` proves **both halves**, and the second is the one that usually goes wrong:

- every secret is gone from the sanitized copy;
- the descriptive sentence — "The owner received 200 and the intruder received 200 for account
  acc-1002" — comes through untouched.

Redaction that eats the evidence is as useless as redaction that leaks it.

## Hashing

Every evidence file is hashed when it is written and the hash is recorded in the result
ledger. The security report recomputes them and reports how many still match, so an index that
disagrees with the bytes on disk is visible rather than silent.

## What a scan did *not* do

The scanner records every request the scope refused: the URL, the verb, the risk, the rung it
was refused at and why. `SECE-003` proves the count is right and the reasons are recorded.

This is not bookkeeping. Coverage is what tells a reader what a clean result means, and a scan
that silently skips what it could not reach produces the same clean report as one that reached
everything.
