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

## Discovery bounds what can be tested

The attack surface is derived from the knowledge graph, so everything downstream of it — which
checks a change calls for, which endpoints a scan targets — is bounded by what discovery
walked. A crawl that reached eleven pages produces a surface of eleven pages, and an
application with ninety has seventy-nine nobody has looked at.

A worker-run scan inherits the same bound: its targets are the surface, so a page discovery
never reached is not scanned and does not appear in the coverage fraction as a gap — the
fraction counts checks against the surface, not surface against the application. `SECW-002`
refuses to start a scan against an undiscovered application for the same reason, since a scan
with no targets would issue no requests and still be stored as a scan.

This is stated in the surface's own caveat list, in the change-impact response, in the summary
of every scan started from it, and here. There is no way around it short of running discovery
more thoroughly, and a tool that hid it would be telling a team that the places it did not look
do not exist.

## What is verified, and how

- **VERIFIED by execution**: every check, the scope guard, the severity model, the gate, the
  regression comparison, the triage workflow, the evidence writer, the RBAC matrix, the stored
  scope/scan/finding lifecycle, the trend, and the console page — the last by twelve component
  tests covering the refusals that matter (no permission to read, no permission to scan, no
  scope, no scans, an empty findings list after a real scan, an incomparable trend point, a
  triage dialog that will not submit without a justification, a refused scan showing the
  reason the API gave, and a queued scan that is never drawn as a result).
- **VERIFIED by execution**: a scan AIRA starts and runs itself — queued from
  `POST /api/v1/security/scans/start`, consumed by the worker, issued against the application,
  and recorded against the scan that was started (`SECW-001` to `SECW-012`).
- **VERIFIED by execution**: a scan no worker reports is ended with its reason stated and its
  gate still reading NOT SCANNED, and a late report supersedes that — nine unit tests over the
  sweep and its two consequences, and both paths driven end to end against a running stack with
  the worker stopped and then restarted.
- **NOT VERIFIED**: a worker-run scan against an authorized production environment.

## Nothing schedules a security scan

A scan starts because a person or a pipeline asks for one. There is no recurring security scan
and no scan triggered by a deployment, so an application scanned once and never again reads as
its last scan for as long as anyone is looking. The scan's date is on every view of it, which is
the whole of what stops that being misleading.

## A scan whose worker stops is ended, but not retried

A sweep ends a scan no worker reported within the grace period (`Security:StrandedAfterMinutes`,
an hour by default), marks it `abandoned`, writes the reason onto the row and audits it. Its gate
still reports NOT SCANNED, because it is: an abandoned scan established nothing, and it sits
outside the set the gate counts as having run, exactly where the queued one was.

Two things it deliberately does not do. It does not retry — queueing another scan is somebody's
decision, not the platform's, and a scan that silently re-ran could re-run against an
authorization that has since been withdrawn. And it is not final: a worker that was slow rather
than dead still delivers, its report supersedes the abandonment and the stale note is cleared,
because real findings beat a presumption of death.

Nobody is notified. A scan that never ran is a gap in coverage rather than a finding, and the
notification channel is deliberately narrow — a new Critical and a regression, nothing else.

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
