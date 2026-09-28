# What QA NXT's security testing will not do

Each of these is a refusal built into the code, not a convention. Where a test proves the
refusal, it is named.

## It will not test an unauthorized application

No scope, a disabled scope, or a scope with no written authorization note: refused before the
URL is even parsed. `SECG-001`, `SECG-002`, `SECG-003`.

## It will not treat an empty allowlist as "no restriction"

A scope naming no allowed domains permits nothing. This is the single most common way a
scanner ends up somewhere it should not be, and it is refused explicitly rather than by
accident. `SECG-004`.

## It will not reach an arbitrary URL

Only hosts the scope names. `SECG-005`.

## It will not reach cloud metadata or link-local addresses, ever

`169.254.169.254`, `metadata.google.internal` and their kin are refused at the target-policy
rung, *before* the allowlist is consulted. A scope that explicitly lists them still gets a
refusal. `SECG-006`, `SECG-007`.

An instance metadata endpoint hands out credentials. A scanner that pulls them into its own
evidence store has created the breach it was hired to look for, and no configuration should be
able to arrange that.

## It will not let a check understate what it is about to do

The HTTP verb raises the declared risk and never lowers it. A POST declared "passive" is
treated as state-changing; a DELETE is treated as destructive. `SECG-013`, `SECG-012`.

## It will not perform destructive testing by default

`AllowDestructiveTesting` is false, the standard profile refuses destructive risk, and the
caller needs a separate permission. All three must line up. `SECF-008`, `SECG-012`.

Where a check does issue a DELETE — the unsafe-method check — it deletes an object it created
one request earlier, for that purpose. It never deletes something it found.

## It will not run a load or denial-of-service test

Every volume probe is bounded by construction and says so in the finding:

- the account-lockout probe sends exactly six failed sign-ins,
- the rate-limit probe sends exactly fifteen requests,
- the oversized-input probe is capped at 5,000 characters,
- the upload size probe *declares* a large size rather than transferring one.

Each finding carries a coverage note saying what the bound was and that no conclusion is drawn
beyond it. "How much can this endpoint take" is a question QA NXT does not ask.

## It will not probe cloud metadata during SSRF testing by default

SSRF detection uses loopback and private-range destinations. The metadata payloads are behind
an explicit opt-in that is off, and the finding says so — so a reader cannot mistake "we did
not look" for "we looked and it was fine".

## It will not follow a redirect it is testing

Open-redirect detection reads the `Location` header. The engine issues every request with
redirects disabled, so this is enforced rather than promised.

## It will not upload anything executable

Upload checks send a filename, a declared content type and a size, because that is what the
validation reads. Sending a real web shell to an application that might store and serve it is
how a test becomes the incident it was meant to prevent.

## It will not extract data to prove an injection

SQL injection is established by an error signature and by a result set widening against a
measured baseline. The finding records the row *count*, never the rows. No second statement is
attempted, no schema is enumerated, no timing attack is run.

Command injection sends one metacharacter naming no command, and looks for a shell reporting
that it could not run what it was given.

## It will not use real credentials or real data

Every identity in the security lab is synthetic, every account number is fictional and every
balance is a round number. Nothing in the security capability reads a production credential
store.

## It will not put a secret in the evidence a report links to

Evidence is written twice: the raw exchange, and a sanitized copy with credentials removed.
Reports link to the sanitized copy. `SECE-002` proves both halves — that the secrets are gone
*and* that the descriptive text survives, because redaction that eats the evidence is as
useless as redaction that leaks it.

## It will not report a finding it cannot show you

`writeFindingEvidence` throws when a finding arrives with no request/response exchange. Not
warns — throws. `SECE-001`.

## It will not let an AI decide a severity

Severity is computed from five stored factors and a fixed arithmetic. The computation is
reproducible from the stored factors, and `SECM-*` asserts that for every finding class. No
model assigns a number.

## It will not treat a hypothesis as a finding

Confidence is separate from severity and computed from different things: was it reproduced,
did a second signal agree, does the evidence admit another reading. A single unreproduced
indicator is Low confidence however alarming it looks, and the gate sends it to review rather
than stopping a release.

## It will not let anything automated close a security finding

Self-healing cannot mark a finding resolved. A suppression needs a written justification and a
named person, and the workflow refuses without both. A finding absent from a scan is
`notObserved` — or `notReproduced` where the check actually ran — and neither is a resolution.
`SECT-008`, `SECB-002`, `SECB-003`.

## It will not go green because nobody scanned

A build with no security scan is REVIEW and the summary says NOT SCANNED. So is a scan that
ran a fifth of its checks, and so is one whose own scope refused most of its requests.
`SECQ-001`, `SECQ-004`, `SECQ-005`.

## It will not say an application is secure

The strongest sentence a clean result produces is:

> Within the configured scope and test coverage, no security findings were detected by the
> executed QA NXT security tests.

followed, always, by what was not tested. `SECQ-003`, `SECQ-010`.
