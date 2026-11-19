# Defects in QA NXT found by trying to measure it

Every entry here was found by pointing the product at a 150-page application and watching
what happened, not by reading the code. Each one is recorded with the evidence that
established it, because the diagnosis is usually not what the symptom suggested.

The pattern worth noticing: of the nine below, **six were found by a check that was itself
new**. A better failure message, a pre-flight, a collector that refuses to report partial
data — each immediately exposed something that had been invisible. The tooling that makes a
tool honest is the tooling that makes it diagnosable.

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

## Two near misses worth recording

**A clock misread.** Discovery at 88 pages looked like it had overrun a 900-second budget;
the elapsed time was 535 seconds and I had read 02:51 as 03:12. Checking the timestamp
rather than the expectation was the only thing that stopped a fourth "the budget is broken"
report.

**A product defect blamed on myself.** The first `fetch failed` was reported here as
self-inflicted, caused by rebuilding the API mid-run. The second had the same 300-second
signature with nothing rebuilt, which corrected it. Attributing a real defect to one's own
error is the same failure as the reverse, and costs the same: the defect goes unfixed.
