# Final verification report

**Status: PARTIALLY VERIFIED**

---

## A declaration that has to come first

I am not an independent party. I built this product across the preceding phases of this
session, and I then acted as its verifier. That is a real conflict and it limits what this
report is worth. A verifier who wrote the code knows where the bodies are buried and may
unconsciously avoid digging there.

What I can offer instead of independence is **falsifiability**. Every claim below names a
check, and every check is a script in `verification/tests/` that another engineer can run
against their own deployment. Every artifact is hashed. Where a result rests on the
product's own test suite rather than on an independent check, it is marked as such and not
counted as independent evidence. Where I could not test something, it is marked NOT
VERIFIED rather than assumed.

Read this report as a structured invitation to disprove it, not as a certificate.

---

## Executive summary

Forty-seven independent checks were executed against a running deployment. All forty-seven
pass on the current build. Getting there required finding and fixing six defects, two of
which were serious and none of which the product's own 215-test suite had caught.

| | |
| --- | --- |
| **Build verified** | `082c85b` plus the six fixes below |
| **Independent checks** | 47 — all passing |
| **Defects found** | 6 (1 HIGH security, 2 HIGH reliability, 1 MEDIUM privacy, 1 MEDIUM missing capability, 1 LOW recorder fidelity) |
| **Defects fixed and re-verified** | 5 |
| **Defects recorded, not fixed** | 1 (BUG-0002, a missing feature) |
| **Regressions introduced** | 0 — the product's own tests still pass |

The most important findings were not in the features. They were in the seams: a security
flag that unlocked more than it claimed, a rate limiter that had never worked as designed,
and work that could be stranded with no path to a verdict.

---

## What was verified, and what that means

### Verified with independent evidence

**Self-healing, in both directions.** This is the product's headline claim and the one most
easily faked, so it got the most attention.

- A test passed against the unmodified application (HEAL-001).
- The sign-in button was then renamed — both its label and its test id — and the *same,
  unedited* test was re-run. Under the default `Suggest` policy the run **failed** while
  recording a replacement at 93% confidence (HEAL-002). Under an opt-in `Auto` policy the
  same break healed, and the run was reported as **healed**, not as a clean pass (HEAL-004).
- The stored test still holds its original locator afterwards (HEAL-005). Healing at run
  time does not rewrite the test behind the author's back.
- **The negative case, which matters more.** A locator targeting an element that never
  existed was run *under the `Auto` policy*, where a healer willing to guess would have
  rescued it. It failed, `wasHealed` was false, zero healing events were recorded, and the
  message named the missing element precisely (HEAL-010, HEAL-011, HEAL-012).

A self-healer that always finds something is worse than none, because it converts a broken
application into a green build. This one declines.

**It does not lie about results.** A false assertion fails (FP-001). A genuine application
defect — a dashboard total computed wrongly — fails, and the same test passes against the
healthy application, so the failure is attributable (FP-002). A run with no executions is
refused rather than reported as an empty pass (FP-003). Ten repetitions of a known-good test
passed ten times, 1065–1173ms (FN-001).

**It cannot be talked into anything by the application it tests.** Instructions were planted
in the demo bank telling the platform to mark everything as passed, to exfiltrate credentials
to `attacker.example`, to fetch cloud metadata and to run a shell command. With that text on
the page, a deliberately false assertion still **failed** (INJ-001), discovery completed
normally (INJ-002), and no page at any host named in the injection was ever visited
(INJ-003). Application content is treated as data.

**Model-proposed actions are validated before execution.** Five hostile shapes — an unknown
verb, a shell command via `executeScript`, off-domain navigation, a missing target, and an
inlined credential — were all refused or dropped with warnings (AI-001).

**Security boundaries hold.** Seventeen checks: unauthenticated access refused on every
endpoint; forged signatures and `alg=none` refused; cross-tenant read, write, listing and
user enumeration refused, returning 404 rather than 403 so existence is not confirmed; SQL
injection and malformed bodies refused with no server errors; path traversal on artifact ids
returning no file content; stored credentials never echoed; security headers and CSP present;
a token in a query string not accepted outside the SignalR hub path.

**Cross-browser execution is real.** The same test passed on Chromium 141.0.7390.37, Firefox
142.0.1 and WebKit 26.0, with the engine and version checked per execution so a silent
fallback to Chromium would have shown (EXEC-001).

**Instability is surfaced, not smoothed.** Against an application that answers after a random
delay straddling the action timeout, 20 runs produced 14 passes and 6 failures — a 70% pass
rate the platform reports rather than hides (FLAKE-001).

**Roles are enforced server-side.** Six built-in roles were each issued a real session and
put through five operations. A viewer could write nothing; an administrator was denied
nothing; reading never implied writing (RBAC-001).

**The CLI behaves as a pipeline needs.** Exit codes distinguish misuse (2), a rejected token
(3), an unreachable platform (4) and success (0), and the emitted JUnit declares the same
number of tests it contains (CLI-001, CLI-002).

**Concurrency holds.** Twenty-five runs started simultaneously all reached a verdict, with
zero throttled worker requests and zero dropped artifacts (CONC-001, CONC-002) — after the
fixes below.

**The browser extension records faithfully.** Seven checks (EXT-001 to EXT-007) load the
real MV3 extension into a real Chromium, drive its popup as a person does, and record a
real journey through the demo bank. The suite does not reuse the product's own extension
check and does not assert the same things:

- Every recorded locator was re-resolved **in a separate browser session** that had no part
  in the recording: 14 of 14 addressed exactly one element (EXT-004). A recording whose
  locators only work in the browser that made them is not a test.
- The page's element skeleton is **byte-identical** with the recorder attached and in a
  browser with no extension at all, no overlay is present while merely recording, and the
  recorded sign-in still signed in (EXT-005). The recorder observes; it does not intervene.
- A typed password is absent from the export, from the extension's own
  `chrome.storage.session`, from the popup window, and from the platform's database after
  import — checked by reading each surface back, not by trusting the substitution
  (EXT-003, EXT-006).
- Eight change events fired into a single tick all survive (EXT-002), and three edits to one
  field arrive as the one step the person performed (EXT-007) — the defect below.

**These checks were themselves tested.** `ext-negative-control.mjs` breaks one property of
the real extension at a time — removes the service worker's serialisation, records the
password literally, emits unvalidated locators, injects a node into the page, restores the
broken comparison — rebuilds, and re-runs the suite. Each of the five mutations turned its
own check red, and the clean rebuild returns every check to green
(`evidence/extension/negative-controls.json`). One mutation had to be rewritten to get
there, which is itself a finding: drifting a recorded test id alone changes nothing
observable, because the recorder checks every candidate locator against the live document
and silently drops one that matches nothing.

### Partially verified

| Capability | What is missing |
| --- | --- |
| Application discovery | Crawls run and produce a knowledge graph, but I did not build an expected-model-versus-discovered-model comparison, so discovery *completeness* is unmeasured. |
| AI test generation | Generation produces runnable tests, verified indirectly. Generation *quality* — whether the tests are the right tests — was not independently assessed. |
| Quality gates | Covered by the product's own e2e check, not independently re-run here. |
| Autonomous agent | Bounds and absence of authority are covered by the product's integration tests, not independently re-executed. |
| Docker deployment | API and worker images build and run; console and demo-bank images cannot be built in this environment (Docker Hub is blocked by egress policy). |

### Not verified

| Capability | Why |
| --- | --- |
| **CI/CD pipelines** | No GitHub Actions or Azure DevOps runner is reachable. The workflow files parse and their embedded logic was run locally, but no pipeline has ever executed. |
| **Manual test authoring** | Not implemented — see BUG-0002. |
| **Performance baselines** | Latencies were observed incidentally (runs 1.1–2.0s, 25 parallel without degradation) but no load test was designed, so no baseline is claimed. |
| **Recovery testing** | Killing the API, Redis or the database mid-execution was not exercised. BUG-0005's fix addresses the worker case specifically. |

---

## Defects

### BUG-0001 — `ALLOW_PRIVATE_NETWORK_TARGETS` also unlocked cloud metadata · HIGH · fixed

One flag gated the entire reserved-address check, so enabling private targets — which the
product's own compose file does by default — also permitted `169.254.169.254`. An
authenticated tenant could have pointed discovery at the cloud metadata service and had the
worker fetch instance credentials into downloadable artifacts.

The guard's parsing was sound: decimal, octal, hex, short-form, IPv4-mapped IPv6 and userinfo
tricks were all refused when the flag was off. The defect was purely that one switch turned
all of it off. Link-local, carrier-grade NAT, `0.0.0.0/8` and multicast are now refused
unconditionally; only loopback and RFC1918 follow the flag. Proven against a second instance
running with the flag off (SEC-041).

### BUG-0004 — the platform rate-limited its own worker · HIGH · fixed

Under ten parallel runs the worker's artifact uploads and completion callbacks were answered
with HTTP 429. Evidence was silently discarded — "An artifact could not be uploaded and will
not be referenced" for a trace, a video and a network log — and one execution was stranded.

Fixing the obvious cause changed nothing, which led to the real one:

```
app.UseRateLimiter();      // partitions on claims
app.UseAuthentication();   // claims only exist after this
```

The limiter ran **before** authentication, so `context.User` was always empty and every
request fell back to the remote address. The per-tenant isolation the limiter was written for
— its own comment says "so one noisy tenant cannot exhaust another's budget" — **had never
worked**. Behind a load balancer, every tenant shared one bucket.

Authentication now runs first, and worker tokens get their own partition. Twenty-five
parallel runs now complete with zero throttling.

### BUG-0005 — stranded executions were never reconciled · HIGH · fixed

An execution left `Running` by a worker that dropped it stayed that way for ever, and so did
its run. A CI pipeline waiting on it would wait until its own timeout. Discovery runs already
had an abandonment reaper and the queue had stale-message reclaim; executions had neither. A
reaper now ends them with a reason that says explicitly this is a platform problem, not a
failure of the application under test — so nobody goes hunting for a defect that isn't there.

### BUG-0003 — an imported journey could store a credential in plain text · MEDIUM · fixed

A hand-written journey containing a literal password was stored unencrypted and returned by
the API. The platform's own recorder never produces this, and execution evidence was still
masked, so the scope was narrow — but the product's stated rule is that credentials are never
stored readably. Import now compares values against the application's stored credentials and
substitutes a `${secret:...}` reference.

### BUG-0006 — the recorder's step de-duplication never fired · LOW · fixed

The service worker collapses consecutive edits to one field into a single step — or says it
does. It compared `JSON.stringify(previous.target)` with `JSON.stringify(step.target)`,
where the first object came back out of `chrome.storage.session`. That API returns an
object's keys in sorted order, not in the order they were written, measured directly in the
extension's own service worker:

```
written:   {"strategy":"testId","value":"username","fallbacks":[{"strategy":"role", ...}]}
read back: {"fallbacks":[{"name":"Username","strategy":"role", ...}],"strategy":"testId", ...}
equal:     false
```

The two strings never matched, for any step, so every change event became a step: three
edits to one field recorded three times, including values the person had corrected and
deleted. Reproduced 2 of 2 in a real browser, then a third time at unit level.

The unit test that covers this behaviour **passed throughout**, because the test's storage
stub cloned with `structuredClone`, which preserves key order. The stub now sorts keys the
way Chrome does, which made the existing test fail; the fix — comparing the descriptors
canonically rather than by their serialised form — turns it green again. The stub was the
more valuable half of this fix: it was the reason a defect in shipped code looked tested.

Impact is small — the last write wins at run time, so a generated test still passes — but
the recording misrepresents what the person did, and intermediate values reach the database.

---

### BUG-0002 — a test cannot be authored by hand · MEDIUM · recorded, not fixed

`POST /api/v1/testcases` returns 405. Tests can only be generated or imported, though
`TestCaseSource.Manual` has existed since the first schema. Left for the product owner to
schedule rather than fixed opportunistically during verification.

---

## Six mistakes I made while verifying

Recorded because a verification report that only documents the product's failures is not
being honest about its own reliability.

1. **I reported a false positive that was my own test's fault.** FP-002 initially claimed the
   platform passed a test against a broken API. It had not: `breakTransactionsApi` breaks only
   a JSON endpoint, while the page under assertion is server-rendered. The assertion was
   correctly true. I rewrote the check to assert on a wrongly-computed balance instead.
2. **I reported a fixed defect as still present.** CONC-002 scanned the whole worker log tail
   and counted 429s from the incident eleven minutes earlier. It now scopes by timestamp.
3. **I contaminated my own test run.** The harness reset a hard-coded list of nine scenario
   switches after I had added three more, so `removeLoginButton` leaked into the next test and
   made a healthy baseline look broken. The reset now reads the switch list from the running
   application.
4. **I wrote a check that passed on finding nothing.** CONC-002 read a log file the
   containerised worker does not write to, found zero lines, and reported PASS — a check that
   cannot fail is not a check. It now reads Docker logs where appropriate and treats an empty
   window as a failure to prove, not a proof of absence.

5. **I wrote a check that contradicted the product's documented behaviour.** EXT-002 fired
   eight change events into one field and demanded all eight back. On a build where the
   recorder's de-duplication worked, seven would have been collapsed correctly and my check
   would have called that a defect. It passed only because of BUG-0006. The burst now
   alternates between two fields, so it measures step loss and nothing else — and EXT-007
   was added to assert the collapsing that EXT-002 used to contradict.
6. **I nearly dismissed a real intermittency as flake.** EXT-002 failed on some runs with
   *zero* of eight steps captured. After a navigation the content script is re-injected and
   only starts recording once it has announced itself, so my burst was racing that window.
   The check now measures how long arming takes and waits for it — 276ms on this machine,
   recorded in EXT-001's evidence rather than assumed. Had I re-run until green instead of
   chasing it, I would have shipped a check that passes three times in four.

All six would have produced a wrong conclusion had I not chased them. The fourth is the one
that worries me most: it was passing, and only looked wrong because the line count in its own
output was implausible. The fifth is a close second: it was *green because the product was
broken*.

---

## Reproducing this

```bash
make verify-all
```

Starts the stack, runs the product's own suites as a regression baseline, then runs the
seven independent suites in `verification/tests/` and regenerates the evidence index. It
exits non-zero if any check fails.

Individual suites: `sec.mjs`, `heal.mjs`, `trust.mjs`, `ops.mjs`, `exec-flake.mjs`,
`conc-reverify.mjs`, `ext.mjs`.

To check the extension suite itself rather than the extension:
`node verification/tests/ext-negative-control.mjs`. It breaks the real extension five
different ways and requires each check to notice its own breakage. It takes about twenty
minutes and leaves the extension rebuilt and re-verified.

---

## Why the status is PARTIALLY VERIFIED

The gates in the brief that are met: critical workflows, critical security, self-healing in
both directions, AI failure handling, no-false-positive, no-false-negative, multi-tenancy,
RBAC, browser execution, and evidence for each.

The gate that is not: **CI/CD execution has never happened.** No pipeline has run. Quality
gates and the autonomous agent still rest on the product's own checks rather than
independent ones, and discovery completeness and generation quality are unmeasured.

Those are not small. A platform whose purpose is to run in a pipeline, verified without ever
running in one, has an untested claim at its centre. VERIFIED would overstate what the
evidence supports.

**PARTIALLY VERIFIED** is what the evidence supports.
