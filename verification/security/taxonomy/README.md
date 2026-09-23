# OWASP taxonomies

These files are **data, not truth**. Each carries the edition it represents, where it came
from, and — the field that matters — whether it has been checked against the official OWASP
source by this deployment.

```json
"verifiedAgainstSource": false
```

That is the state they ship in, and it is deliberate rather than an oversight.

## Why they are unverified here

The brief that commissioned this work is explicit: *"At implementation time, verify the
current OWASP API Security Top 10 taxonomy from the official OWASP source"* and *"Do not
assume an old version is current."*

The environment this was built in denies outbound access to `owasp.org`:

```
$ WebFetch https://owasp.org/API-Security/editions/2023/en/0x11-t10/
EGRESS_BLOCKED: Access to owasp.org is blocked by the network egress proxy.
```

So the taxonomy could not be verified, and the only honest thing to do is say so in the data
itself rather than present a list from memory as though it had been checked. A coverage
matrix computed against an unverified taxonomy is still useful — it maps real executed tests
to named categories — but it cannot claim to be current, and no report generated from it
says that it is.

## Refreshing them

```bash
./scripts/refresh-owasp-taxonomy            # both
./scripts/refresh-owasp-taxonomy --api      # API Security Top 10 only
./scripts/refresh-owasp-taxonomy --web      # Web Top 10 only
```

The script fetches from `owasp.org`, rewrites the file, and sets `verifiedAgainstSource` to
true with the timestamp and the URL it read. It fails loudly rather than silently keeping
the old data if the host is unreachable — a taxonomy that quietly stays stale is the thing
this whole arrangement exists to prevent.

## What reads them

`SecurityCoverage` builds the matrices, and every report prints the edition and the
verification state beside the numbers:

```
OWASP API Security Top 10 — edition 2023 (NOT verified against owasp.org in this deployment)
```

A reader who sees that line knows exactly how much weight the category names carry.
