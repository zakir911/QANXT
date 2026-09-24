# Limitations

Stated here rather than discovered later. Everything below is a real boundary of what AIRA's
security testing can establish today.

## DOM-based cross-site scripting is not detected

The source is `location.hash`, which never reaches the server, and the sink is `innerHTML`,
which runs in the browser. A response-only scan gets byte-identical responses from the
vulnerable and the corrected page, so there is nothing for it to observe.

`checkDomXss` returns `notTestable` with the reason, and lists the client-side sinks and
sources it found in the page — which is grounds for someone to look, not a finding. `SECX-001`
asserts that it reports this way rather than reporting nothing found.

A browser-driven security scan would reach it. None exists. `SECN-002` records that.

## Cloud metadata and internal infrastructure are untested, not clean

SSRF detection uses loopback and private-range destinations by default. Whether an application
would fetch `169.254.169.254` is not established, and the finding says so explicitly rather
than leaving the reader to assume that area was covered.

## Production scanning has never been exercised in its permitted form

Only the refusal path is verified (`SECG-016`, `SECG-017`, `SECG-018`). No production
environment exists here, and `SECN-001` records the permitted path as NOT VERIFIED rather than
implying it works.

## The detection rate does not generalise

34 of 34 planted flaws detected, 0 false positives on the corrected applications. Every one of
those flaws was written alongside the check that finds it. That is the right way to test a
detector and the wrong way to estimate how it will do against an application nobody has seen.

`SECN-003` records this as not measurable here. The number describes this lab.

## There is no security surface in the console

Scopes, scans, findings and triage are persisted and exposed through the API
(`/api/v1/security/...`), and the whole path is verified end to end by `SECPL-001` through
`SECPL-015`: the authorization, the refusals, the stored findings, the regression, and the
triage decision that needs a person.

What does not exist is a screen. There is no findings list, no scan history view and no trend
line in the web console. Everything is reachable through the API and nothing is reachable by
clicking, so:

- **IMPLEMENTED and VERIFIED**: every check, the scope guard, the severity model, the gate,
  the regression comparison, the triage workflow, the evidence writer, the RBAC matrix, and
  the stored scope/scan/finding lifecycle through the API.
- **IMPLEMENTED, NOT TESTED**: nothing.
- **NOT IMPLEMENTED**: the console screens, and trend analysis over stored scans. The data to
  build both is in the database; the queries and the pages are not written.

## The scanner does not run inside the worker

The engine that issues security requests is driven by the golden suites, and the API records
what it found. A scan is not yet something you start from the platform and watch — there is no
security job type in the worker queue, so `POST /api/v1/security/scans` is an ingestion
endpoint rather than the far end of a "start a scan" button.

This is the largest remaining gap between what the brief describes and what runs. It is
recorded here and in the security verification report rather than left for someone to
discover.

## Authenticated scanning depends on the application's own sign-in

The engine signs in through `POST /api/session` with synthetic credentials. An application
using SSO, MFA or a bespoke token exchange would need work before an authenticated scan could
run against it. Nothing here handles that.

## Only HTTP is tested

No WebSocket, no gRPC, no GraphQL-specific checks, no mobile API conventions. A GraphQL
endpoint would be probed as an ordinary HTTP POST, which finds some things and misses the ones
that matter most in GraphQL.

## Checks are written, not generated

AIRA's AI generates functional tests. It does not generate security checks. A security check
whose logic a model invented would be a check nobody had reviewed, and the brief is explicit
that an AI-generated hypothesis is not proof. Findings are produced by deterministic code.

## What "no findings" means, precisely

It means: these checks, against these endpoints, within this scope, at this profile, on this
run, observed nothing they are built to observe. It does not mean the application is secure.
It does not mean there are no vulnerabilities. It does not mean a different scanner, a
different scope or a person would find nothing.
