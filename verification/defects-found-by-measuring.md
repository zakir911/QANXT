# Defects in QA NXT found by trying to measure it

Every entry here was found by pointing the product at a 150-page application and watching
what happened, not by reading the code. Each one is recorded with the evidence that
established it, because the diagnosis is usually not what the symptom suggested.

The pattern worth noticing: of the twelve below, **six were found by a check that was
itself new**. A better failure message, a pre-flight, a collector that refuses to report
partial data — each immediately exposed something that had been invisible. The tooling that
makes a tool honest is the tooling that makes it diagnosable.

The last two are the sharpest version of the same point. A run stalled at 81% because every
job's credential had been stamped before its work was scheduled (10), and the guard written
to catch exactly that had never fired once, because it was tested against an imagined
message rather than a real one (11). Neither is visible from the code. Both are obvious
within a minute of watching a real run stop.

The twelfth is the uncomfortable one: the analyser that scores all of this was itself
over-crediting, and reported 3 detections where the evidence supported 2.

---

## 1. Tests were authored with locators that address more than one element

**Symptom.** 18 failures reading `role=heading name="X" matched N elements`.

**Diagnosis.** `buildLocatorFor` chose a locator per element in isolation and never asked
whether it addressed one element. Two identical headings on a page, or a heading whose name
is a prefix of another, produced the same descriptor; `exact: false` meant "Shipment" also
matched "Shipment Details". The execution-time resolver refuses an ambiguous match, which is
correct, but by then a test had been authored, queued, dispatched and run, and the failure
it reported was the platform's own.

**Fix.** The crawler already maps the whole page's element list, so the uniqueness context
was in hand. Candidates that would match more than one element are skipped; a role+name
match tightens to an exact name when the substring match is the ambiguous part; `nth` is
pinned only when every candidate is ambiguous.

## 2. A failing `select` step reported only that it had waited

**Symptom.** 29 failures reading `locator.selectOption: Timeout 30000ms exceeded`.

**Diagnosis.** Playwright waits the full timeout for an option that will never arrive. From
that message a missing option, an empty dependent select and a disabled control are the same
event, and none of them is distinguishable from a slow page.

**Fix.** A failing select reads back what the control actually offers and names the cause.

**What it then revealed** — see 9.

## 3. Cancelling a run did not reach the crawl

**Symptom.** The worker log showed it crawling two discovery runs at once. One had been
marked cancelled fourteen minutes earlier and was still mapping pages.

**Diagnosis.** The control plane already refused to record progress for a finished run —
that guard was right and was working — but its answer was discarded. Nothing stopped the
crawl except its own clock.

**Why it matters.** On a real application the tool keeps opening pages and pressing controls
after being told to stop, which is the one thing this product promises it will not do.

**Fix.** The progress endpoint answers `shouldStop` with a reason; the crawl honours it and
records why it stopped. A delivery failure still answers "carry on": a blip in a
best-effort feed is not an instruction to abandon a crawl.

## 4. A reclaimed crawl started a fresh full time budget

**Symptom.** Same log. A run with a declared 900-second budget was twenty minutes in.

**Diagnosis.** The deadline was computed when the worker process began crawling, not when
the run began. A job whose worker died and was reclaimed got a whole new budget.

**Nearly misdiagnosed as** "the time budget is ignored". It is not ignored; it is enforced
from the wrong instant. The distinction is the whole fix, and the log only yielded it
because the stale crawl stopped exactly on schedule measured from its own restart.

**Fix.** The job carries the run's start time and the deadline is measured from there. A job
reclaimed after its budget has gone gets a short window, capped by the budget, rather than a
deadline in the past — a crawl that stops without reporting leaves the run looking stranded
and throws away every page it already has.

## 5. The server was never asked whether it enforces anything

**Symptom.** None. That is what made it the worst of these. Every test the engine wrote went
through the DOM, so a rule implemented in the browser alone looked enforced, and three of
the planted defects sat under passing tests.

**Fix.** `assertServerEnforces`, which sends the submission the browser just refused
straight to the form's action with the session's own cookies and asks for the refusal again.

**Verified true in the field.** On the lab's payment form the oracle reported that
`POST /billing/invoices/inv-0010/pay` accepted a submission the browser had refused for
want of a required "Date received". The handler validates `amount` and never looks at
`receivedOn`. The finding is correct.

## 6. Information carried by colour alone was never checked

**Diagnosis.** axe-core checks colour contrast, which is a different question from whether a
colour is the only thing saying what a row is. A status column of green, amber and red
squares passes every contrast rule.

**Fix.** `assertNotColourOnly`, reported only where a column's text-free cells disagree
about colour — one colour is decoration, two or more is data.

## 7. The new oracle would have passed 398 times without running

**Symptom.** Caught before execution, by reading the generated payload:
`{"form":{"strategy":"testid","value":"payment-form"}}`.

**Diagnosis.** Two faults in one line. The wire grammar spells that strategy `testId`, and
the oracle honoured only the `css` strategy anyway, falling back to the first `form` on the
page. Nearly every list page carries a search box first, so the fallback was the normal
path. A wrong submission gets refused — and this oracle reads a refusal as the server
enforcing the rule. All 398 would have **passed**, and the capability would have been
recorded as working on the strength of a check that never ran once.

**The uncomfortable part.** That exact failure mode is named in the oracle's own doc comment
as the one thing it must not have. It was built in anyway, two layers below where anyone
was reading.

**Fix.** The oracle resolves through the platform's own locator grammar; the designer
serialises the `LocatorDescriptor` itself instead of hand-assembling JSON. Hand-building it
caused both halves, and silently dropped the fallbacks, `name` and `nth` as well.

**Guard.** `preflight-suite.mjs` runs before execution and refuses a suite whose verbs,
locator spellings or step ordering are not coherent. It reads the strategy list from the
shared contract rather than restating it, since a spelling nobody checked was the whole bug.

## 8. Starting a run outlives any default HTTP client

**Symptom.** `TypeError: fetch failed`, twice, with no error logged on the API side and the
run executing perfectly well afterwards.

**Diagnosis, to the second.** Run created 02:57:28; the client gave up 03:02:30. Five
minutes and two seconds, against a caller timeout of ten minutes. That is Node's undici
`headersTimeout`, 300 seconds, which is independent of the caller's `AbortSignal`.
`StartAsync` commits the run and its executions and then, still inside the request, performs
one enqueue per execution, building a payload for each. At 5,887 executions that exceeds
five minutes.

**Nearly misdiagnosed twice.** First as a client timeout — which led to raising the caller's
timeout to ten minutes, the wrong layer, so it kept happening. Then as my own fault, for
rebuilding the API while it was running; the 300-second signature on a later failure where
nothing had been rebuilt ruled that out.

**Consequence.** The run proceeds and the caller has no run id, so every later stage is
lost. Three hours of execution produce no report.

**Status.** Not yet fixed. An earlier fix correctly detached the dispatch loop from the
request's cancellation token so the work completes; it left the loop inside the request, so
the caller still waits. The right shape is to return the run id as soon as the executions
are committed and dispatch behind it. Recorded rather than attempted, because it needs a
rebuild a running measurement cannot survive.

**Worked around** by `collect-run-result.mjs`, which reads what a run did from the control
plane's own tables, refuses to be read as a result while executions are outstanding, and
attributes each failure to the oracle whose wording raised it.

## 9. The suite invalidates its own test data as it runs

**Symptom.** 13 failures reading `Cannot select "inv-0008": that option is not offered. The
select has 25 option(s): "inv-0010" …`.

**Diagnosis.** The invoice selects list *unpaid* invoices. The designer captured `inv-0008`
at discovery time and an earlier test in the same run paid it.

**Visible only because of 2.** The same failures previously read
`locator.selectOption: Timeout` and were indistinguishable from a slow page.

**Status.** Classified as the engine's own fault so it is never counted as an application
defect. Counting it as one would be wrong in the most expensive direction: it inflates what
the tool appears to find while hiding a real weakness in how it chooses test data. The fix
is for a test that selects from a data-dependent list to resolve its value at execution
time, or to declare the dependency. Not yet done.

---

## 10. A run larger than two hours of work could never finish

**Symptom.** Run `accddf2b` designed 5,887 tests. At 04:48 the fleet was completing about
forty a minute and 1,116 executions were still queued. At 05:03 completions stopped dead.
Load fell to 0.24, the worker process was alive and idle, and the Redis stream held 1,116
entries, every one delivered to a consumer and never acknowledged.

**Evidence.** The worker log, from 05:03 onward, 866 times:

```
/api/v1/worker/executions/3e080446-.../started failed with 401
```

The run started at 02:57:29. The first 401 was at 05:03. Two hours and six minutes.

**Diagnosis.** `TestRunService` minted every execution's callback token when the execution
was *queued*:

```csharp
CallbackToken = _tokens.IssueWorkerToken(run.OrganizationId, execution.Id, "execution", TimeSpan.FromHours(2)),
```

Queue time is the suite's size over the fleet's size. The control plane knows neither when
it stamps the token. Those 1,116 executions were not slow or broken: their credential
expired before their work was ever scheduled, and no retry could change that. The larger
the suite, or the smaller the fleet, the more of the run is unreachable — a tool meant to
test applications of any size could not finish testing a large one.

**Why no constant fixes it.** Raising the lifetime moves the cliff; it does not remove it.
A 12,000-test suite on this same fleet would cross any constant chosen today.

**Fix.** `Security:WorkerToken` was already declared in this project's settings as "shared
secret a worker presents to exchange for job-scoped tokens", and nothing read it: the
exchange was specified and never built. It is built now
(`WorkerTokenController`). A worker whose callback is refused with 401 presents the fleet
secret once, receives a token for that job, and retries — without spending a retry attempt,
since the first attempt already established that the control plane is reachable and only
the credential was wrong. The embedded token stays as a fast path, so the exchange is only
reached by jobs that waited.

**What the exchange will not do.** Issue a token for a job that has finished. The check is
on the job's state, not the clock, so a leaked secret cannot reopen a closed run. "No such
job" and "that job has finished" return the same refusal, so the endpoint is not a way to
discover which run ids exist.

**Status.** Fixed. Seven integration tests and eight worker tests, including that a renewed
token is scoped exactly as narrowly as the one it replaced.

---

## 11. The guard against exactly this had never once fired

**Symptom.** The 1,116 refused jobs did not fail and stop. Each was released back to the
queue with a 15-minute retry, reclaimed, and refused again, five times over. Those retries
produced 1,110 further `429`s out of the control plane they were retrying against.

**Diagnosis.** `permanent-failure.ts` exists precisely to stop this; its own doc comment
describes the hot loop it was written to prevent. It carried a signature for a refused job:

```js
/\b(401|403|404)\b.*(discovery|execution|security|worker)|was not found\./i
```

It requires the status code to appear *before* the word. The real message is a URL and then
a number, and the URL contains `executions`. It never matched once.

```
> re.test("/api/v1/worker/executions/3e080446/started failed with 401")
false
```

A guard written against an imagined message and never run against a real one. Note that the
failure is silent in both directions: nothing reports that a signature never matches.

**Fix.** Stop re-deriving the verdict from the text. `ControlPlaneClient.ensureOk` already
decides retryability when it reads the response — 408, 429 and 5xx retryable, everything
else "a decision, not a blip". The classifier now honours that field. This also covers every
refusal the control plane can return rather than the three statuses someone thought to list.

**Status.** Fixed, with the real log line from this run as a test fixture and a test that
the verdict does not depend on where the status code falls in the message.

---

## 12. The measurement credited one failure to several defects

**Not a product defect — a defect in the thing measuring the product, which is worse.**

**Symptom.** The detection analysis reported **3 of 32 planted defects detected**.

**Diagnosis.** Two of the three shared their evidence with another defect. The line

```
Book a shipment — step 2: refuses Requested delivery date before Collection date
  → Expected the submission to be refused, but it was accepted
```

was counted as finding both `FP_D02_DELIVERY_BEFORE_COLLECTION`, which it is, and
`FP_D15_WIZARD_BACK_LOSES_DATA` ("going back from step 3 empties step 2"), which it plainly
is not — the word "step" appeared in the test's name, and a signal naming the defect's
screen needed only **one** keyword to count. The same colour-only finding was credited to
both `FP_D23` and `FP_D21`.

A measurement that flatters what it measures is worse than no measurement, and this one had
**no tests at all**, which is how it stayed wrong while every other number was checked.

**Fix.** One failure line is evidence of one defect. Each signal is awarded to the defect
whose keywords it matches most specifically, and naming the defect's own screen outranks
keyword count elsewhere — the colour finding on `/fleet/vehicles` is the colour defect's,
not that of an unlabelled-field defect on another screen that shares vocabulary. Eight
tests now cover the matcher, including that the result does not depend on the order the
defects are listed in.

**Corrected figure: 2 of 32**, reported below.

**A second instance, same run.** The security harness printed nothing under "what the scan
did not establish" after a scan that had recorded **204** reasons. It read only the
structured `untestedAreas` field; the scan detail response has no such field, and the
reasons reach it only as prose on the gate's reason. So a scan that was refused permission
to run 120 of its checks read as a clean one. The harness now falls back to the gate, and
refuses to print "17 skipped" with no account of what was skipped.

---

## Two near misses worth recording

**A clock misread.** Discovery at 88 pages looked like it had overrun a 900-second budget;
the elapsed time was 535 seconds and I had read 02:51 as 03:12. Checking the timestamp
rather than the expectation was the only thing that stopped a fourth "the budget is broken"
report.

**A product defect blamed on myself.** The first `fetch failed` was reported here as
self-inflicted, caused by rebuilding the API mid-run. The second had the same 300-second
signature with nothing rebuilt, which corrected it. Attributing a real defect to one's own
error is the same failure as the reverse, and costs the same: the defect goes unfixed.
