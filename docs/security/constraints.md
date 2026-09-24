# The eighteen constraints

The brief this capability was built against ends with eighteen rules. This maps each one to
the requirement that states it and the tests that hold it, so "we follow these" is checkable
rather than asserted.

Every test named here ran in the verification run the report was generated from. Where a rule
is enforced by the absence of a code path rather than by a check, that is said plainly — it is
a stronger guarantee, not a weaker one, but it is a different kind of claim.

| # | Constraint | Requirement | Tests |
| --- | --- | --- | --- |
| 1 | Never test an application without explicit authorization | SEC-R01, SEC-R51 | `SECG-001` `SECG-002` `SECG-003` `SECPL-002` `SECPL-005` `SECPL-014` |
| 2 | Never leave security scope unrestricted | SEC-R02 | `SECG-004` `SECG-005` `SECPL-003` |
| 3 | Never allow arbitrary URLs | SEC-R03 | `SECG-005` `SECG-008` `SECG-022` |
| 4 | Never allow AI to bypass scope controls | SEC-R04 | `SECG-012` `SECG-013` `SECE-003` |
| 5 | Never perform destructive testing by default | SEC-R05, SEC-R52 | `SECG-012` `SECF-008` `SECF-012` `SECPL-004` |
| 6 | Never perform DDoS or load attacks as part of security scanning | SEC-R06 | `SECD-007` `SECD-014` `SECD-025` |
| 7 | Never access cloud metadata or internal infrastructure by default | SEC-R03, SEC-R22 | `SECG-006` `SECG-007` `SECD-028` |
| 8 | Never use real customer credentials or production data in the lab | SEC-R08 | `SECD-001` `SECD-006` `SECE-002` |
| 9 | Never expose secrets in evidence | SEC-R09 | `SECE-002` `SECE-004` |
| 10 | Never fabricate vulnerability evidence | SEC-R10 | `SECE-001` `SECQ-009` `SECPL-006` |
| 11 | Never call a vulnerability confirmed without reproducible evidence | SEC-R10, SEC-R54 | `SECE-001` `SECPL-007` `SECPL-008` |
| 12 | Never allow self-healing to hide a security regression | SEC-R37, SEC-R38, SEC-R60 | `SECT-008` `SECB-002` `SECB-003` `SECPL-020` |
| 13 | Never weaken security assertions to make the pipeline pass | SEC-R34, SEC-R67 | `SECQ-006` `SECT-001`–`SECT-005` `SECPL-009` `SECPL-010` |
| 14 | Never treat an AI-generated hypothesis as proof | SEC-R10, SEC-R11, SEC-R41 | `SECM-001` `SECM-018` `SECQ-008` |
| 15 | Never claim "secure" or "zero vulnerabilities" | SEC-R40 | `SECQ-003` `SECQ-010` |
| 16 | Always distinguish tested coverage from untested areas | SEC-R28, SEC-R29, SEC-R62, SEC-R65 | `SECX-001` `SECQ-010` `SECE-003` `SECPL-017` `SECPL-018` `SECPL-023` |
| 17 | Always preserve an audit trail | SEC-R35, SEC-R56 | `SECT-006` `SECPL-011` |
| 18 | Always fail safely when scope or authorization is ambiguous | SEC-R01, SEC-R02, SEC-R18 | `SECG-001`–`SECG-023` `SECPL-001` |

## Where a rule is held by an absent code path

These two are held by code that does not exist, which is the one kind of claim a passing test
cannot make. `security-constraints.mjs` checks the absence against the source rather than
leaving it asserted here — and fails if a guarded directory holds no source at all, because an
absence proved by reading nothing is not proved.

**Constraint 12 — self-healing.** AIRA's self-healing rewrites locators when a functional test
breaks. It has no path to a security finding's status at all: no reference to `SecurityFinding`
or `SecurityScan` appears in `Aira.Application/Diagnosis` or the worker's `src/healing`. The
triage refusal (`SECT-008`) and the never-resolve-on-absence rule (`SECB-002`, `SECB-003`,
`SECPL-020`) are the second and third lines, not the first.

**Constraint 14 — AI.** AIRA's AI generates functional tests. It does not generate security
checks, and no reference to `SecurityFinding` appears in `Aira.Application/Ai`, `Agent` or
`Intelligence` — so there is no path by which a model's output becomes a finding. Findings are
produced by deterministic code, severity is computed from stored factors, and confidence is
computed from whether something was reproduced. `SECM-*` asserts that every severity recomputes
from its stored factors.

## Where a rule is a process rather than a mechanism

**Constraint 13 — "never weaken security assertions to make the pipeline pass"** is, in the
end, about what people do. What the code can enforce, it does:

- a suppression with no written justification and no named person is counted as **open** and
  fails the gate, so silencing a finding is not available as a way to go green;
- narrowing a scan reports the full implied set as configured, so running fewer checks produces
  REVIEW rather than PASS;
- the gate's thresholds are policy a project sets, and loosening them is a recorded change
  rather than an edit to a check.

None of that stops somebody setting `failOnNewAtOrAbove` to Critical and shipping a High. It
makes that a decision with a name on it rather than a quiet erosion.

## Constraint 15, in the exact words

The sentence a clean result is allowed to produce, asserted verbatim by `SECQ-003`,
`SecurityGateTests` and `SecurityReleaseServiceTests`:

> Within the configured scope and test coverage, no security findings were detected by the
> executed AIRA security tests.

Followed, always, by what was not tested.
