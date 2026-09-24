# The attack surface, change impact and release posture

Three things that connect security testing to the rest of AIRA, rather than leaving it as a
separate product that happens to live in the same repository.

## The attack surface

`GET /api/v1/security/applications/{id}/surface`

Derived from the knowledge graph discovery already builds. For each page and each observed API
call it works out what is worth pointing a check at:

| Signal | What it implies |
| --- | --- |
| An authenticated endpoint with `{id}` in its template | BOLA, missing authorization |
| An authenticated collection | vertical escalation |
| POST / PUT / PATCH | CSRF, origin validation, read-only write, input validation, mass assignment |
| DELETE | the unsafe-method check |
| Query parameters | reflected XSS, SQL, command and template injection, rate limit |
| A parameter named `url`, `next`, `redirect`, `callback`… | open redirect, SSRF |
| `multipart/form-data`, or a file input on a page | upload restrictions |
| A route or template that looks like authentication | the whole authentication family |
| Any page | headers, cookies, sensitive data |

Each item says **why** it is there, in terms you can disagree with — `"an API call discovery
observed (POST); it needs a session; it changes state; 2 query parameter(s)"`.

### The caveat list is never empty

Its first entry is unconditional:

> This is what discovery walked, not the application. Anything a crawl did not reach is absent
> from this surface and is untested rather than safe.

A surface derived from a crawl that reached eleven pages is not the application's attack
surface. A reader who takes the item list as complete will treat everywhere else as safe, and
nothing here has looked at anywhere else. Other caveats appear when they apply: no API calls
observed, nothing requiring a session (so discovery never signed in), no authentication surface
recognised, DOM XSS implied and decidable only in a browser.

## Where to see it

**Security → Attack surface** in the console, for one application: the summary, the caveats —
above the list, deliberately — and each item with the reason it is there and the checks it
implies. `GET /api/v1/security/applications/{id}/surface` is the same thing for a machine.

The caveats come first on that screen for the same reason they come first here. A reader who
takes the item list as complete will treat everywhere else as safe, and nothing here has looked
at anywhere else.

## Change impact

`POST /api/v1/security/impact`

Intersects the existing change-impact analysis with the surface: a diff reaching
`/api/accounts/42` selects the checks `/api/accounts/{id}` implies. Concrete paths match
templates, because git reports the first and the graph holds the second.

Narrowing a security scan is genuinely useful — thirty-two checks on every commit is how a team
learns to skip the security job — and it is the most dangerous thing in this area, because
fewer checks produce fewer findings and fewer findings look like progress. Two rules stop that:

**A check covering a currently open finding stays selected whatever the change touched.** A
check that found something and then stopped running is how a regression hides.

**The result reports the full implied set as `checksImplied`.** A scan that runs six of
thirty-two reaches the gate as six of thirty-two and comes back REVIEW. Narrowing changes what
runs; it cannot change what a clean result is allowed to claim. There is a unit test that takes
the selector's output, hands it to the gate the way a scan would, and asserts the answer is
REVIEW.

A change that matches nothing selects nothing and says so:

> No discovered surface matched the change. That is not the same as the change being safe: it
> may touch something discovery never walked.

An open finding naming a check that no longer exists — a finding recorded before a rename — is
reported rather than silently dropped, because otherwise it stops being re-tested and nothing
says so.

## Release posture

Every release quality report carries a `security` section. **Not optional and not nullable.**

A release report that omits security when no scan ran reads as though security was fine — the
section is missing, so nothing is wrong — and that is the most consequential silence a release
report can contain. So a build nobody scanned comes back:

> **NOT SECURITY TESTED.** No security scan covers this build, so nothing is known about its
> security posture from AIRA. This is not the same as having been tested and found clean, and a
> release decision should not read it as such.

| Verdict | When |
| --- | --- |
| `notScanned` | no scan covers the build's run window |
| `blocked` | an open Critical, a regression, or a suppression with no written reason |
| `needsReview` | an open High, or partial coverage, or coverage that could not be read |
| `clear` | scanned, within its coverage, nothing open above the thresholds |

The window is the build's own runs, so a release tested across three days is not assessed on a
scan that ran a week before any of them. `clear` produces the same sentence the gate does, and
names the untested areas alongside it.

## The check vocabulary

`GET /api/v1/security/checks` serves the 32 check names.

Served rather than documented because four things must agree on these strings: the surface that
says which apply, the selector that says which to run, the scan record that says which
executed, and the gate that reads coverage from that record. A check named one way in the
selector and another in the scan record produces a gate reporting full coverage from a scan
that ran nothing — a false green arriving through a typo. `SECPL-027` fetches the platform's
list and asserts it is identical to the engine's.

## The main dashboard

Every release quality report carries a security posture; so does the dashboard everybody
opens. `DashboardView.Security` is non-nullable for the same reason: a dashboard that shows
security only when a scan exists reads as though security is fine whenever the section is
missing.

The number that earns its place there is **applications never scanned**. Every security
dashboard shows open findings; almost none shows how many applications nobody has pointed a
scanner at. A project with three findings and full coverage, and a project with the same three
findings and two applications never touched, are in very different states — and they render
identically without that count.

It also distinguishes *not authorized* from *never scanned*. The first is nobody having said
security testing may happen; the second is it being permitted and not done. Different problems,
different people.

The dashboard, the gate and the release posture all use the same definition of an open
finding, including counting an unexplained suppression as open. A finding that were open at the
gate and closed on the dashboard would make both untrustworthy.

## Telling somebody

Two notification events, and no more:

| Event | When |
| --- | --- |
| `SecurityCriticalFinding` | a scan found something Critical nobody has seen before |
| `SecurityRegression` | something that was fixed has been detected again |

Both are on by default. A team that configured notifications and then had a fixed
vulnerability come back without being told would be right to ask why they had to opt in, and
these two fire rarely enough not to become noise. Everything else reaches people through the
gate and the report — a security channel that fires on every Medium is a channel people mute,
which costs more than the messages are worth.

Both are delivered at **Problem** severity. They were briefly `Information`, which meant a
channel colour-coding by severity would have rendered a new Critical vulnerability the same
shade as a passing build; `SECPL-028` caught that.

### Confidence is consulted, except for a regression

A new Critical resting on a single unreproduced indicator does **not** notify. The gate sends
such a finding to review rather than failing the build, on the grounds that one weak signal is
not enough to stop a release; the same reasoning says it is not enough to interrupt somebody,
and a notification path that ignored what the gate weighed would be the two disagreeing about
the same finding.

A regression notifies whatever this scan's confidence was. It was confirmed once already, and
that earlier confirmation is the corroboration this scan lacks.

### What a notification never contains

The category, the endpoint and the counts. Never the evidence, the payload, the reproduction
steps or any response value. A notification goes to a chat channel with a membership nobody
audits, and *"this endpoint leaks account data, here is the request"* is not a thing to put
there. The message says so itself:

> The evidence is in AIRA; it is deliberately not in this message.

`SECPL-028` asserts the absence by searching the delivered bodies for the payload and the
error signature that produced the finding.
