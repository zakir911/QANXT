# The Verdaccio pilot

One bounded autonomous pass, against an application AIRA has never seen and nobody wrote for
it. This is the only evidence in the project that says anything about how the platform
behaves outside its own lab, and the interesting half is what it got wrong.

**Target.** Verdaccio 6.10.4, a private npm registry — a Vue front end over an Express API.
Installed from npm, run locally with no uplink, three packages published into it, loopback
only. Setup and authorization are in `README.md`; the raw record of the pass is in
`pilot-run.json`.

**Run.** Agent run `f6eaa176-957e-4e9a-9836-f0a6a5a88514`, build `verdaccio-6.10.4`,
25 September 2026.

## What the pass did

| | |
| --- | --- |
| Pages discovered | 4 |
| Endpoints discovered | 7 |
| Capabilities assessed | 11 |
| Phases recorded | 36 |
| Decisions recorded | 8 |
| Questions asked of a person | 2 (both granted) |
| Tests generated | 11 |
| Tests executed | 11 — all passed |
| Failures investigated | 0 |
| Proposals made | 15 (11 coverage gaps, 4 risk areas) |
| Model spend | $0.00 — the deterministic planner |
| Outcome | `completed`, "The pass completed its plan." |

It onboarded, crawled, modelled, assessed coverage, proposed a plan, waited for a person,
generated API tests for all seven discovered endpoints, queued a security scan, waited for
approval before executing, ran what it had assembled and wrote up what it found. Every
decision carries its evidence. Nothing was destructive, nothing touched production, and both
state-changing actions stopped for a person first.

## What it established

**It works on an application nobody wrote for it.** That is not nothing: the crawl, the
knowledge graph, risk scoring, API test generation, the policy ladder, approvals and the
release assessment all functioned against third-party code on the first attempt.

**It was honest about its own reach.** The plan named three things it does not cover before
anybody asked: that no journey has ever been recorded so nothing follows a path a real user
was seen to take, that two areas were excluded by a person, and that anything discovery did
not reach is absent from the plan rather than covered by it. The coverage decision repeated
the qualifier in its own words: *"4 page(s) and 7 endpoint(s) discovery reached."*

**It did not claim the application is good.** Eleven tests passed and the write-up says only
that they hold "on the application as it is now", followed by the standing sentence that the
agent has no authority to raise a defect, change a test, approve a healing proposal or alter
a quality gate.

## What it got wrong

### 1. It tested the console's API, not the registry's

All seven discovered endpoints are `GET /-/verdaccio/data/…` — the web UI's own backing
calls. None of the npm registry protocol appears: not `GET /:package`, not `PUT /:package`,
not `/-/user/…`, not dist-tags. Those are the product. A browser never calls them, so a
crawler never finds them.

This is a structural limit of discovery-by-crawling, not a bug, and it matters for how the
platform should be described. On an application whose primary surface is an API that no
browser drives, an autonomous pass tests the part a browser can see and is silent about the
rest — and silence here reads as coverage unless somebody says otherwise. The coverage
decision's denominator is honest about being what discovery reached; it cannot know what it
never had a way to reach.

### 2. The operator's stated priorities matched nothing, and nobody was told

The pilot named three business-critical areas: *search for a package*, *read a package
page*, *login*. **None of them matched any capability.** Critical areas are matched to routes
by substring, and no route contains an English phrase. The result:

- `businessCriticalWithGaps` was **0** with three areas named;
- every one of the eleven coverage gaps came out `medium`, none `high`;
- the plan's narrative quoted the three areas back, so the record *looks* as though they were
  taken into account.

The input was accepted, stored, echoed and had no effect on any ranking. An operator reading
that plan would reasonably believe the pass was prioritising what they asked for.

**Fixed, partly.** The coverage decision now records
`namedAreasMatchingNothingDiscoveryReached`, so a named area that corresponds to nothing is
stated rather than silently dropped, and `AQI-057` pins it. That makes the failure visible;
it does not make the matching better. Matching a journey written in English to a route needs
more than a substring test, and that is not done.

### 3. A completed scan was reported as no scan at all

The pass queued a security scan; it ran, executed six checks and issued 54 requests against
Verdaccio, and completed at 15:08:14. The release assessment for the same build reported:

> **NOT SECURITY TESTED.** No security scan covers this build, so nothing is known about its
> security posture from AIRA.

The window for "scans covering this build" was `[first run's completion, last run's
completion]` and tested for containment. For a build with one run — the normal case in a
pipeline — that is a single instant that nothing can fall into. Every single-run build read
as unscanned however thoroughly it had been scanned.

**The first fix was not enough, and the golden suite caught that.** Anchoring the window on
the first run's *start* and testing for *overlap* rather than containment fixed the pilot's
ordering, where the scan was still running as the tests began. It did not fix the ordering
the golden lab produces, where the pass waits for the scan and starts the run 1.5 seconds
after it finishes — outside any window drawn from that run. Widening the window further would
have been picking a number to make a test pass.

**The root cause is that a scan recorded no build reference at all.** "Which build did this
scan cover" was always being deduced from timestamps, and every deduction of that shape has a
boundary where the right answer and the computed one differ. A scan now records the build it
covered, the agent passes the run's build reference when it queues one, and the release
assessment matches on it directly. The time window remains as the fallback for scans that
named no build — scans already in the database, and scans a person starts by hand — so adding
the column does not quietly stop counting them. A scan that named a *different* build is
excluded either way: it already said what it covered.

`AQI-056` pins it end to end. Eight unit tests now cover the window and the build reference,
where previously there were none at all — every existing test passed `(null, null)` and never
exercised either.

This is the most serious defect the pilot found. A false *"nothing is known"* on a security
section is the most consequential wrong answer a release report can give, and it survived
251 golden tests because both orderings it depends on only occur when a real pass runs
against a real application.

### 4. Four pages is a thin crawl

Discovery reached `/` and three package-detail pages. Verdaccio's UI has more than that.
Whether the crawl stopped for a good reason is not established here — it is recorded as a
number, not diagnosed — so the coverage figures describe a small slice of the application and
the report says so rather than presenting 11 capabilities as the application.

## What this pilot does NOT establish

- **That AIRA works on arbitrary applications.** One application, one pass, one afternoon.
- **That Verdaccio is defect-free, secure or well covered.** Eleven generated tests passed.
  That is a statement about eleven tests.
- **That the security scan found nothing worth knowing.** It ran and reported; what it found
  was not analysed as part of this pilot.
- **That the agent would behave the same on a larger application**, under a real model
  provider (spend was $0 — the deterministic planner), or against production (never
  exercised in its permitted form).
- **That the crawl's depth was correct.** Four pages is recorded, not explained.

## The honest summary

The platform ran end to end against somebody else's application, refused what it should have
refused, asked before everything that changed state, and was careful in its language about
what it had and had not established.

It also produced a release report that said nothing was known about security when a scan had
just covered the build, and let an operator's stated priorities fall on the floor without a
word. Both were found by pointing it at one unfamiliar application for an afternoon. Neither
would have been found by the 251 golden tests, because both live in the gap between what the
lab looks like and what a real application looks like.

That is the argument for the pilot, and the argument for more of them.
