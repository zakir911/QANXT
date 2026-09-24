# The finding model

## Status

| Status | Means |
| --- | --- |
| `Potential` | Detected, not verified. Never reported as a vulnerability. |
| `Confirmed` | Reproduced, with evidence. |
| `NeedsReview` | A person has to decide. |
| `FalsePositive` | Examined and found not to be a problem. Needs a justification and a name. |
| `Accepted` | A person judged it acceptable. Needs a justification and a name. |
| `Resolved` | Confirmed, then a later scan could not reproduce it — and a person closed it. |
| `Regressed` | Resolved, then detected again. |

Nothing automated moves a finding to `FalsePositive`, `Accepted` or `Resolved`.

## Severity

Computed, never assigned. Five factors, fixed weights, a maximum of 19:

| Factor | Values | Weight |
| --- | --- | --- |
| Exploitability | theoretical, difficult, straightforward, trivial | ×2 |
| Impact | minimal, limited, serious, severe | ×2 |
| Privilege required | administrator, authenticatedUser, none | ×1 |
| Affected data | none, nonSensitive, personalData, credentials | ×1 |
| Exposure | internalOnly, authenticatedUsers, public | ×1 |
| Requires unusual conditions | — | −3 |

Bands: **Critical** ≥16, **High** ≥12, **Medium** ≥8, **Low** ≥4, **Informational** below.

The last factor earns its place. A session cookie missing `HttpOnly` has serious impact, but
reading it needs an XSS the attacker does not have yet — a condition they do not control. The
factor exists so that can be said in the model rather than by putting a thumb on the scale.

Every finding stores its factors, and `SECM-*` asserts for each finding class that the
severity recomputes from them. A number nobody can reproduce is an opinion with a decimal
point.

### Calibration

The lab's ground truth names an expected severity for each planted flaw, and the golden suite
asserts the model lands on it. Where the two disagreed, one of them was wrong and the
disagreement was resolved in the open:

- **Missing rate limit** was recorded as Low in the ground truth and scored Medium. The label
  was a casual judgement; the factors — trivially exploitable, no account needed, publicly
  reachable — do not support Low. The ground truth was raised, with the reason recorded in the
  file.
- **Open redirect** scored High and was expected Medium. Its *direct* impact really is
  minimal: it discloses nothing and changes nothing. Its value to an attacker is as a step in
  something else, and scoring a step as though it were the whole attack is how severity stops
  meaning anything. The impact factor was corrected.

Both changes are in the code beside the finding, with the reasoning.

## Confidence

A different question from severity, and computed from different things:

| | |
| --- | --- |
| **High** | Reproduced, and the evidence admits no other reading |
| **Medium** | Reproduced, or corroborated by a second independent signal |
| **Low** | A single indicator, unreproduced |

Collapsing this into severity is how scanners end up reporting a critical vulnerability they
merely suspect. The gate treats them differently: a new High finding fails a build; a new High
finding at Low confidence goes to review.

## CWE and OWASP

Each finding carries a CWE, a `cweConfidence` (`confirmed` or `likely`), an OWASP API Top 10
category and an OWASP Web Top 10 category.

The taxonomy files live in `verification/security/taxonomy/` and carry
`verifiedAgainstSource`. At the time of writing that flag is **false** for both: outbound
network access was blocked in the environment where they were recorded, so the categories come
from knowledge rather than from the published documents. `scripts/refresh-owasp-taxonomy`
fetches and replaces them, and fails loudly rather than silently keeping the unverified copy.

The security report states the flag. A taxonomy nobody checked, presented as authoritative, is
exactly the kind of quiet inaccuracy that makes a compliance report worthless.
