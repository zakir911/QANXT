# @qa-nxt/security-engine

The security scanning engine: the scope guard, the checks, the severity model, the evidence
writer, the gate and the regression comparison.

**It lives here because two consumers need it and two copies would drift.** The browser worker
runs scans against real applications; the golden suites run the same engine against the
security lab and measure what it finds. A check that behaved one way in the worker and another
in the verification suite would make the verification meaningless — it would be measuring a
different program from the one that ships.

Plain ESM with no build step, so the golden suites can run it directly with `node` and the
worker can import it compiled. Hand-written types live in `src/index.d.ts`.

## What is in here, and what is not

In: anything that decides what a security request may do, what a finding is, how severe it is,
and whether a build should stop.

Not in: anything that knows about the security lab. The lab's ports, its ground truth and its
scenario catalogue stay in `verification/golden-tests/security/`, because an engine that knew
about the fixtures used to test it would be able to pass them.

## The one rule

Every security request goes through `SecurityScanner.request`, which evaluates the scope guard
first. There is no other way to issue one, and that is the design: the guard is not something a
check remembers to call, it is something a check cannot avoid.
