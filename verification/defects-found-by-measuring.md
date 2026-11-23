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

The first twelve came from one application. Entries 13 to 26 came from building three more
of different shapes, and they carry a second pattern: **nine of those fourteen are the same
mistake made in a second place** — a rule the engine learned and the worker did not, a URL
joined correctly in one module and concatenated in forty-three sites of another, an identity
model implemented carefully and then undone by two lines in a handler no test could reach.
A second application finds what a second reading of the code does not.

Entries 27 and 28 came from a third pattern, and the cheapest one: **reading what a check
actually asserts rather than what its name says it checks**. A retention test named after
going back looked only at the step the bug spares, and a coverage figure counted tests whose
own stored reason says they never ran. Neither needed a browser to find.

Entries 29 to 56 are dominated by one shape, and it is the most dangerous one here because it
looks like health: **a check that could not reach the thing it claimed to test, and said so
honestly, so nothing appeared broken.** An oracle whose premise had stopped holding. A crawl
that stopped at a budget and reported what it had rather than what it had not. Three checks
pointed at an address with the query stripped off, each reporting a truthful 404 about a page
that was never the one under test. A scan that recorded its findings and nothing about what
each check concluded, so "found nothing" and "never ran" were indistinguishable from outside.

The lesson they share is not that the third verdict is a problem. It is the opposite: in every
one of those cases the honest "not evaluated" is what made the fault findable at all, and a
suite that had reported them as passes would have hidden the lot. What was missing was never
the verdict — it was somewhere for the verdict's reason to go.

Two entries in this stretch are corrections to earlier entries in this same document, which is
the point of numbering them rather than editing them away: 49 named a check worth building and
asserted it would close two defects on two applications, and it closes one, because the second
cancels with a POST and a POST is not a safe verb. The claim was never tested before it was
written down.

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

# Found by pointing it at applications of a different shape

Everything above came from one application: Meridian Freight, server-rendered, 137 screens.
Three more targets were built because one application can only show the defects that
application's conventions reach — a client-rendered scheduler whose server sends an empty
shell, a 2004-style permit register behind an HTTP Basic challenge that changes state
through links, and a token-authenticated API. Thirteen defects follow, and the pattern in
them is sharper than the pattern above: **nine of the thirteen are the same mistake made in
a second place.** A rule the engine learned and the worker did not; a URL joined correctly
in one module and concatenated in another; an identity model implemented in the engine and
undone by two lines in the handler.

## 13. Discovery changed the application it was mapping

**Symptom.** After a crawl of the permit register, all three permits read `approved`. They
had been seeded as two submitted and one approved.

**Diagnosis.** `decide` carries a careful list of words meaning a control writes —
`approve` and `revoke` among them — and refuses to click any control whose name matches.
It hands an anchor with a destination to link following with the reason "it is an ordinary
link and is already followed", and link following tested nothing. Harmless where everything
that writes is a button. Not harmless on an application built before anti-forgery tokens
were normal, where `<a href="/approve.asp?id=1">Approve</a>` is how approving works.

**Fix.** Link following applies the same test, and the crawl says what it refused. Getting
the rule right took three attempts and the first two were worse than the bug: applying the
button vocabulary to links refused `New application`, `Fund transfer`, `Checkout`, `Save a
draft` and an upload — every one of which only opens a form — and a guard that hides half
the application is not a safe guard. What separates them is not vocabulary but whether the
link addresses a record: `/approve.asp?id=1` acts on something, `/checkout` opens a screen.
A narrow set of words acts on arrival with nothing to act on (delete, clear, reset, revoke,
sign out) and is refused anywhere.

## 14. Discovery never applied basic or bearer credentials

**Symptom.** A crawl of a Basic-protected application reported a successful sign-in and then
mapped nothing.

**Diagnosis.** `performLogin` answers "using header-based authentication" for `basicAuth`
and `bearerToken`, on the understanding that the context already carries them. Execution did
that. Discovery created its context with no credentials at all, so every page answered 401.
Nothing noticed because every target in the lab used a sign-in form.

**Fix.** One mapping from an auth config to context options, used by both callers.

## 15. A sign-in form that marks nothing required got a synthesised username

**Symptom.** Eleven failures on one application, all "the form is still shown; messages:
'Those details were not recognised.'"

**Diagnosis.** The password came from configuration and the username did not. The rule
required the field to be marked `required`, and the form — the normal shape for an
application that validates on the server — marks nothing required. Every test expecting a
successful sign-in then failed, reporting a correct refusal as a defect.

**Fix.** The username goes in the field that says it is the username, or the form's only
text field. A second text field beside it is left to synthesis rather than given the
username too.

## 16. The acceptance oracle could not see a client-side re-render

**Symptom.** 23 of 43 failures against the client-rendered target were submissions the
application had accepted and acted on.

**Diagnosis.** A submission counted as accepted when a confirmation appeared or the form
gave way. An application rendered in the browser does neither: a search form pushes
`?q=...` and redraws its results in place, leaving a new, identical, visible form and no
banner.

**Fix.** A route change counts, which is the same evidence as a navigation. And where even
the route does not change — a booking form whose new row appears in the table above it — a
redraw answering a request the application answered without failing counts. Only together:
an application that posts, is answered 201 and throws the submission away leaves the screen
identical and still fails, which is the defect class that pairing exists to protect.

## 17. A form with no action was assumed to POST, and to an endpoint it never called

**Symptom.** "expected at least 1 POST request(s) but saw 0 (no submission was sent at
all)" on a form that had sent its submission and rendered the answer. And "expected at
least 1 request to /api/session" on a booking form.

**Diagnosis.** Two guesses. `SubmitMethod` ignored the form's own method unless the form
also carried an action, so every action-less form was tested for a POST — a form without an
action submits to the current URL, which is HTML's default and not a sign of scripting.
`EndpointPath` took the first non-GET endpoint the form's page had called, which on a
client-rendered page is whichever one came first: the booking form was assigned the sign-in.

**Fix.** A declared method is believed. Where nothing declares one, the test checks that the
submission reached the server without asserting a verb. One correlated write endpoint is an
answer; several are a gap naming what the choice was between.

## 18. Structural findings were only ever a count

**Symptom.** A design run reported "6 structural finding(s)" and there was no way to read
one.

**Diagnosis.** The engine records a message, a code, a severity and a field for each. The
coverage response exposed the count per form, and nothing else did anything. Reading one
meant querying the database.

**Fix.** `GET /api/v1/applications/{id}/form-findings`, worst first. "Every decision
auditable" is not satisfied by the number 1.

## 19. Forty-three probe URLs were built by concatenation

**Symptom.** Twelve missing-header findings naming URLs like `/schedule/schedule` and
`/default.asp/list.asp`.

**Diagnosis.** Every check built its probe as `${baseUrl}${path}` with paths that are
absolute. Correct only while the base URL has no path of its own, which every target
happened to satisfy. Registered against `http://host/schedule`, a sign-in probe went to
`http://host/schedule/api/session`.

The consequences were not cosmetic. Those twelve findings described the 404 page rather than
the application and named URLs that do not exist. Worse, sign-in failed for all three
identities, so **twenty-three checks — every authorization and authentication check in the
profile — reported inconclusive for want of an identity.** The scan said so plainly in its
untested list; that was the honest report of a scan whose identities had been broken by URL
arithmetic.

**Fix.** An absolute path resolves against the origin: one helper, used everywhere, with
those three URLs as its first test cases. The worker had its own copy of the same mistake,
and a third lived in how a page was targeted (21).

## 20. The engine could not sign in to an HTTP Basic application

**Diagnosis.** It looked for a sign-in form on eight paths, posted JSON to seven endpoints,
took 401 from all fifteen and returned null — with the credentials in its own
configuration.

**Fix.** Basic is tried first, because a 401 carrying `WWW-Authenticate` is the server
stating the answer. The challenge is established before the header is sent: a Basic header
to an application that does not use Basic is ignored, and reading the 200 that follows as a
sign-in would hand every authorization comparison two anonymous requests to find identical.

## 21. A page reached by a query parameter was scanned at a URL that does not serve it

**Diagnosis.** A page's route is its path. A page reached by `?id=1` is only served at that
address, and the scan was pointed at `/view.asp` where the application serves
`/view.asp?id=1`. On the permit register `/view.asp` answers "no such permit", so the header
checks measured that 404 and the personal-data check read a page holding nothing.

**Fix.** A page the route alone cannot reach is named by the address it was served at.
Ordinary pages keep their route, which is what a reader wants in a report.

## 22. The worker discarded every identity that was not a cookie

**Symptom.** A scan of the Basic-protected register reported every authorization check "an
owning identity is needed", after the engine had been taught to sign in with Basic.

**Diagnosis.** Two lines. `if (!session?.cookie) give up`, and then
`{ ...identity, cookie: session.cookie }` — so a session with no Set-Cookie was thrown away,
and what survived reached every check with its headers dropped. The engine's identity model
was covered by tests; these two lines were not reachable from one.

**Fix.** Any session that can authenticate counts, its headers travel through one mapper
rather than ten literals, and the pair is exported so a test can reach it.

## 23. Every record of a route after the first was skipped as already visited

**Symptom.** "Every total equals the sum of its lines" passed on the permit register, where
one permit's fees deliberately do not add up.

**Diagnosis.** The key answering "have I visited this page" was the key answering "what
route shape is this". `/view.asp?id=1`, `?id=2` and `?id=3` all collapse to
`/view.asp?id={v}`, which is right for a shape and wrong for a visit. So the check ran
against permit 1, whose fees add up, passed, and never opened permit 2. One record per route
is how a data-integrity suite reports green on an application full of broken arithmetic.

**Fix.** Two keys. The visit key keeps identifiers and normalises only what is incidental;
the route shape is unchanged and still bounds how many instances get crawled.

## 24. The sensitive-data check looked only for secrets

**Diagnosis.** Password hashes, API keys, JWTs, private keys, connection strings — and
nothing else. A register printing every applicant's national insurance number in full to
every signed-in user was clean by that standard, and so would be a page listing customers'
card numbers.

**Fix.** Payment cards, IBANs and two national identifiers, each recognised by its own
check digits or issuing rules rather than by shape: Luhn, mod-97, the issued ranges. That
arithmetic is the whole reason the precision holds. Email addresses and telephone numbers
are deliberately absent — a support address in a footer is not a leak, and a detector that
reports one teaches its readers to skim. The check also ran anonymously, so behind a sign-in
it examined the sign-in page; it reads as an identity now.

## 25. A critical finding on every route of every client-rendered application

**Symptom.** Three criticals on a three-screen application: "protected data is served to an
unauthenticated caller", about a 244-byte document holding a script tag and nothing else.

**Diagnosis.** `authz.missing` asked whether the anonymous request was refused and read
"not refused" as "the data leaked". An application rendered in the browser answers 200 with
the same empty shell on every route; the data arrives over an API, which does refuse. Fifty
routes would have raised fifty.

**Fix.** A finding requires that something was served — JSON with fields, or markup with
more than a page title's worth of visible text. A JSON error envelope is not data; a shell
shipping kilobytes of bundled script is still a shell. Where nothing was served the answer
is inconclusive with the reason, not a pass, which would read as "checked, and safe".

## 26. Privilege escalation reported on every authenticated collection

**Symptom.** "clerk can reach a route intended for inspector", high severity, confirmed CWE
confidence, about the form clerks use to file applications.

**Diagnosis.** The check concluded a defect from "the privileged role got 200 and the lesser
role also got 200". Nothing in that says the route was meant to be restricted, and on any
real application most authenticated collections are reachable by every role — that is what a
collection is.

**Fix.** A route naming itself administrative still produces the finding, marked likely
rather than confirmed and saying in the finding that the naming is a convention to confirm.
Everything else is inconclusive, with the reason. The stronger check is the application's own
interface — a control the privileged user is shown and the lesser user is not — which needs
per-role discovery the engine does not have, and is named in the finding as the way to settle
it.

## 27. The wizard retention check looked only at the first step

**Symptom.** A booking wizard that empties step two's fields when you step back from step
three. 6,344 tests against the application, none of which asked.

**Diagnosis.** The check existed, under the name `previous-keeps-answers`, and advanced
through step one, pressed Back, and read step one's answers. Step one is the step the bug
spares: a wizard that re-renders a later step from its defaults rather than from the draft
loses step two and keeps step one, which is exactly the shape of the defect. The check also
read only text-like fields, and step two of that wizard holds numbers and a selector, so
even pointed at the right step it would have asserted nothing.

**Fix.** Every step that can be returned to gets its own test, and numbers, dates and
selects are read back alongside text — `assertValue` reads them all through the control's
own value. Passwords, checkboxes and radios stay out: a tick is not a value the control
reports, and a password field is deliberately not read back. A step that cannot be completed
is recorded as a gap naming the field, not skipped silently.

## 28. A test that never ran counted towards coverage

**Symptom.** Coverage above zero for an application QA NXT could not sign in to.

**Diagnosis.** `Blocked` was in the list of statuses that mean a test executed. The worker
sets that status precisely when a test did not: it stores "Preconditions were not met — "
with the sign-in failure, or "Not run: this test reloads the page, and this application signs
the user out on any page load". Both went into the numerator of the coverage percentage.

**Fix.** Blocked is not a verdict. It is still counted and still reported in its own column
and in `notRun`, which is where a test that could not run belongs. Coverage is the share of
tests that ran, and a blocked test did not run.

## 29. A check the engine declared impossible was only unimplemented

**Symptom.** Every saving form carried the gap "the stored record — QA NXT has no access to
the application's database, and a stored record is only observable where the application shows
it back", and a human task to go and look. The first thing any tester does after pressing Save
was recorded as out of reach.

**Diagnosis.** The sentence is true of the database and false of the page. An application that
answers a save with a redirect has chosen to show the record back, and the values it was given
should be in what it shows. Nothing was stopping the engine from reopening that page and
looking; the gap had simply been written once and never re-read.

**Fix.** `assertSavedValuesReadBack`, and a third verdict to make it honest. A redirect alone
is not evidence that the destination shows the record — a thank-you page shows none of the
submission — so a page showing nothing submitted produces no verdict rather than a finding,
and only a page showing part of the record is a defect. Without that distinction the check
would have reported every well-behaved post-redirect-get application for losing data, which
would have been the largest class of false finding in the product.

## 30. Two validation tests that passed whatever the application did

**Symptom.** The AI-fallback planner's "Submit with required fields empty" and "Reject an
invalid amount" scenarios passed against every application they were pointed at.

**Diagnosis.** Both closed by asserting the submit control was still visible. A submit
control is on screen whether the application refused the submission, accepted it and redrew
the form, or accepted it and did nothing at all. The same mistake was found and fixed on the
planner's happy path — the code even carries the comment explaining why, naming BUG-0016 —
and the two refusal scenarios beside it kept making it.

The oracles that answer the question properly were already written, already shown failing
against a lab of deliberate defects, and used by the deterministic engine only.

**Fix.** `assertFormRejected` and `assertFormAccepted`, pointed at the form element
discovery records. Where discovery did not record one there is nothing to point them at, so
the scenario asserts nothing and its stated expectation says so: asserting nothing is worse
coverage and better information than asserting something that cannot fail.

## 31. A long job was handed to a second worker while the first was still running it

**Symptom.** In the discovery log of a 150-page crawl, two lines twelve seconds apart:

```
[13:18:07.102Z] Stopped: the 900s exploration budget was reached.
[13:18:09.461Z] Starting from 2 URLs: the base URL plus 1 from your route list and the sitemap.
[13:18:10.151Z] Mapped /dashboard — 61 elements, 30 links, kind=dashboard
[13:18:19.388Z] Stopped: the control plane asked the crawl to stop — the run is no longer
                in flight: it finished as PartiallyCompleted.
```

A second crawl of the same application started, mapped two pages, and was stopped.

**Diagnosis.** A pending stream entry is re-delivered once it has been idle longer than the
visibility window, and "idle" is counted from its last delivery rather than from any sign of
life. The worker never sent one. The crawl's exploration budget was 900 seconds and the
visibility window's default is 900 seconds, so the job was reclaimed at the moment the first
attempt was finishing.

What stopped the two crawls running together was the control plane refusing a crawl whose run
was no longer in flight — an accident of this run's timing. A budget a little under the window
would have had two browsers mapping one application at once, double-ingesting its pages, and,
before the link guard, changing it twice.

**Fix.** The worker renews its claim every third of the visibility window while a job is in
flight: `XCLAIM` with a minimum idle time of zero, back to the same consumer, and `JUSTID` so
the delivery counter is not incremented — keeping a long job alive must not spend its retry
budget. The recovery this replaces still works: a worker that actually stops renewing has its
job reclaimed, which the test asserts in the same breath as the renewal.

## 32. Twelve defects for one form, titled the wrong thing

**Symptom.** A 6,344-test run produced twelve defects on one credit-note form, every one
titled "Raise a credit note: refuses a valid submission". Two other forms produced six each
with the same title.

**Diagnosis.** Two separate mistakes behind one number.

The form is shown to an account that may not raise credit notes, and the application says so
in the page. The oracle read it correctly and recorded it verbatim: *"Expected the submission
to be accepted, but the form is still shown; fields marked invalid: invoiceId, amountGbp,
reason; messages: "You do not have permission to raise credit notes."; no confirmation is
shown; the route did not change."* Nothing downstream drew the distinction between an
application refusing a value and an application refusing an account, so a correctly working
permission check was filed as a validation defect.

And the defect signature included the field each test happened to be varying. A refused
submission is refused whatever a boundary test was doing to the note's length, so twelve
tests with one cause between them became twelve defects.

**Fix.** The field is no longer part of the signature for a refused submission; the refusal
message still is, so two different refusals on one form remain two defects. And a refusal
whose message names a permission is titled for what it is: the form is shown to an account
the application will not accept it from, so nothing about its rules could be tested. The
vocabulary is deliberately narrow — "not allowed" is excluded, because an application that
says a date is not allowed is talking about the value.

## 33. A form that said the submission worked was filed as refusing it

**Symptom.** From the same run, two failures with the application's own confirmation quoted
inside them:

> fields marked invalid: dataset, dateFrom, dateTo; no error message is shown; confirmation:
> "Export of shipments queued. You will be emailed when it is ready."

> fields marked invalid: file; no error message is shown; confirmation: "Document uploaded."

**Diagnosis.** A server-rendered form that answers in place re-renders itself empty with a
confirmation above it. Every required field on it is then natively invalid — `valueMissing`,
because it is empty — and the oracle counted that as the application reporting a problem. So
the acceptance check failed beside the message saying the submission had been accepted.

**Fix.** An empty required field is not the application reporting anything; it is the
browser's static view of an empty box. `:user-invalid` is the distinction the platform
already draws: it matches only once the user has interacted with the field or tried to submit
the form. A blocked submission still reports its fields, a freshly rendered empty form does
not, and `aria-invalid` and every other kind of invalidity — a bad pattern, a number out of
range — count as before. Both halves are tested, because removing the false refusal must not
remove the real one.

## 34. A dropdown option that had moved on was filed against the application

**Symptom.** Twenty-six failures on one run reading *"Cannot select "inv-0004": that option is
not offered. The select has 25 option(s): ..."*, every one of them recorded as a defect in the
application.

**Diagnosis.** The worker is right to refuse: it will not invent a selection. The test was
built from the options the page had when it was mapped, and by the time the suite reaches it
the application lists a different set — because records in a dropdown are created and consumed
as the system is used, including by other tests in the same run. Nothing classified that
symptom, and an unclassified failure is treated as the application's fault.

`DataIssue` existed as a category, was described in the bug report as "the test's data does not
suit the environment", and was missing from the list of categories that are not product
defects — which cost nothing while no rule produced it.

**Fix.** A rule that recognises it, with the options the page does offer kept verbatim as the
evidence, and `DataIssue` added to the two lists of categories that are not application
defects. The suggested action is to generate again or pin the field to data the environment
always has, and the report still carries it so a select that genuinely lost its options is
readable rather than silent.

## 35. A token-authenticated application could only be visited as a stranger

**Symptom.** The fourth target — a JSON API with a bearer-token sign-in — was driven for the
first time and mapped three public pages, no forms and no endpoints. Every test it wrote
then failed.

**Diagnosis.** Two separate things, and the first one hid the second.

The lab server died mid-run. A scan sent a request for `//`, `new URL("//", base)` raises
`ERR_INVALID_URL`, and uncaught in a request handler that stops the process — so twenty-three
tests failed with `ECONNREFUSED` against a target that was no longer there. The product got
that part right: the classifier attributed all twenty-three to the environment and concluded
nothing about the application. The lab now answers 400, as a real server would.

Underneath it, the real gap. `bearerToken` wants a token somebody has already obtained and
pasted in. The ordinary shape of a JSON API is an endpoint that takes a username and a
password and answers with a token, and there was no way to describe that — so an application
built that way could only be mapped as an anonymous caller. The security engine had been
doing this exchange for its own probes since the HTTP Basic work; the browser-side
authenticator had never been taught it. The same pattern as nine of the entries above: a rule
one half of the product knows and the other does not.

**Fix.** A `tokenLogin` strategy. The endpoint, the field the token comes back in, the fields
the credentials go out in and the header it is sent in are all declared in the login flow,
with the common spellings tried when the description is silent. The exchange goes through the
page's own request context, so it shares the cookie jar and the proxy with the browser the
tests run in, and the token is set as a context-level header, which reaches the page's own
fetch calls and the worker's API steps alike.

**Measured.** 23 of 23 tests failing and 0 of 4 defects, to 25 tests with 19 passing and 1 of
4 — the reflected XSS, now found. Discovery's own log is the proof the sign-in works: it reads
"Signed in successfully", and `/api/orders`, which answers 403 to a caller with no token,
came back 200.

## 36. A JSON API was mapped as pages, so it had no attack surface

**Symptom.** With the token sign-in working, the order API was still 1 of 4: three pages,
**zero endpoints**, and the object-authorization check never selected. The planted defect is
that any signed-in caller can read any order — the check written for exactly that, against
identities configured with the orders they own.

**Diagnosis.** Three links in one chain, each hiding the next.

Endpoints were only ever recorded from XHR and fetch traffic, which is how a browser
application calls its API. Open the same URL directly and the browser calls it a document, so
`/api/orders` was filed as a page with no elements and no kind — and the attack surface, built
from endpoints, had nothing on it.

Then, with the endpoint recorded, there was still no path to test: the check needs a template
carrying an identifier, and nothing on the application links to `/api/orders/ord-1`. A
collection answers with the records it holds and points at none of them.

Then, with the instance visited, `normalizeUrl` left `ord-1` alone — correctly, because an
opaque string in a path is as likely to be a route name as an id, which is why the freight
work made the visit key keep it. So the surface held one order's address, not `/api/orders/{id}`.

And underneath all three, the flag that decides whether an endpoint is authenticated was
hard-coded to false on the new path. An authenticated endpoint taking an identifier is the
shape that implies the check; an anonymous one is not.

**Fix.** A navigation that answers JSON is recorded as the endpoint it is. The identifiers in
a collection become addresses the crawler tries — a hypothesis tested by a GET, bounded to a
few per collection, with a 404 recording nothing and saying so, because REST's shape is a
convention and not a rule. A URL the crawler built from a known identifier is templated on
that identifier's own value rather than on what the segment looks like: there is nothing to
infer when you put the id there yourself. And whether the request carried a session is read
from the request's own headers, which include the cookie and the Authorization header a token
sign-in set.

**Measured.** 0 of 4 to 2 of 4 on this target, with the planted object-authorization defect
found by the check meant for it: *"bob can read a resource owned by alice — parameter id —
CWE-639"*.

---

## 37. Two oracles reported their own unmet premise as a defect in the application

**Symptom.** None, in the ordinary sense. These two checks had never once fired against a
real target, so nothing was wrong with any run — which is exactly why reading them was the
only way to find this.

**What they do.** `assertHiddenMeansForbidden` and `assertStateForbidsAction` are the only
two steps in the engine that act on an absence: a control the page withholds, a transition
the page does not offer. Both begin by confirming the premise on the page, because a
question asked of the wrong record answers nothing. `assertHiddenMeansForbidden` checks the
control is still missing or disabled; `assertStateForbidsAction` checks the page still says
the record is cancelled, rejected, void.

**The defect.** Both raised `OracleError` when the premise did not hold, and `OracleError`
means the assertion failed — which the engine reports as a defect in the application under
test. So a control that had become available, or a record that had moved on, would have been
filed against the application as a broken permission or a broken state machine. The engine
already has the right verdict for this and has had since the read-back oracle: an oracle
that cannot be evaluated is `InconclusiveError`, the step is `skipped`, and it counts as no
coverage. These two predate it and were never moved over.

The two existing tests for these branches asserted the message and not the verdict, so they
passed whichever of the two the oracle produced. That is the fourth time this session a test
has been found asserting less than its name claims.

**Fix.** Both premise branches raise `InconclusiveError`, with the reason kept. The tests now
assert the verdict as well as the wording, and a third test asserts the counterpart — that an
accepted request is still a failure — so making premises inconclusive cannot quietly soften
the finding this family exists to report. Reverting the fix fails exactly those two tests.

**Why it matters beyond the two steps.** A false premise could only produce a false defect,
so the premise had to be kept narrow, and the narrow premise is part of why these checks
never fire. Making an unconfirmed premise cost a skip instead of a false accusation is what
makes a wider premise safe to supply.

---

## 38. A map that stopped early said so, but not by how much

**Symptom.** Five of freight's thirty-two planted defects sit on screens discovery never
opened, and the run that missed them reported success with 150 pages and one line of
explanation: *"Stopped: the 900s exploration budget was reached."*

**The defect.** That line says the map is partial. It does not say whether the budget cut
off four pages or four hundred, and a coverage figure computed over the pages that were
opened reads exactly the same either way. The crawler already has two careful notes doing
precisely this job elsewhere — one for links it would not follow because their own words say
they change something, one for a crawl thin enough to need accounting for — and the comment
above the second says why: *"a crawl that found nothing ends up looking like a crawl that
found everything."* All three budget stops were the one case that did not account for itself,
and the frontier is sitting in a local variable at the moment each of them breaks.

The quieter half is the per-route cap. `maxInstancesPerRouteShape` is 3, instances are taken
in crawl order, and each skip was logged one line at a time with no total. On freight that
cap is the whole reason FP_D17 is unreachable: a declaration's release page is only linked
while the record is still releasable, so three instances chosen by crawl order are three
records in the wrong state, and the page where the defect lives is never linked from
anywhere. Nothing in the report connected the cap to the missing screen.

**Fix.** Every budget stop records what was still queued — deduplicated on the crawl's own
visit key and filtered to what it had not already opened, so the number is pages the crawl
would have gone to and not queue bookkeeping — and reports the count with examples and what
to raise. The cap reports its own total per route shape, and says in the same breath that
instances are taken in crawl order, so a defect that only shows on a record in another state
will not be reached. Five tests in `partial-map-accounting.test.ts`, including one that the
crawl finishing cleanly must not trip, and one fixing the count at the three distinct pages
rather than the forty-five skip events that counting raw queue entries produced.

**What this does not do.** It does not reach the five screens. It makes a partial map say how
partial it is, which is what the house rule about evidence requires of it, and it names the
cap as a cause so the next change has a target instead of a hunch.

**A note on my own fixture.** The cap test first failed because its records were `rec-1`
through `rec-6`, and the crawler does not read a one-digit suffix as an identifier — six
pages, six route shapes, no cap. The product was right and the test was wrong; four-digit
ids, as a real application writes them, and it engaged.

---

## 39. Three records of the same route, chosen by document order

**Symptom.** The freight crawl mapped three declarations and the per-route cap stopped it
there. All three were in states the planted defect does not live in, and the one it needs — a
rejected declaration — was further down the list.

**Why that was not recoverable later.** The defect is that a rejected declaration can still
be released. The application draws the Release link only while the record is still
releasable (`customs.js:206`), so a rejected declaration's release page is linked from
nowhere: the only way to it is from the record itself, and the record was never opened. Zero
release pages were mapped on a 150-page crawl. Raising the cap would help by accident;
raising it enough to be sure would mean opening every record of every list.

**The defect.** The cap's reasoning — one more `/accounts/{id}` teaches nothing the first few
did not — is true of a column the records agree on and false of one they differ in. A
declaration that is rejected and a declaration that is accepted are not the same page shown
twice. The cap was right and the selection was arbitrary: whatever document order offered
first.

**Fix.** Where a list shows a column its records differ in by a few values, the crawl takes
one record of each value before a second of any. The column is chosen by its shape, not by a
vocabulary of status words: a column every row agrees on says nothing, a column where every
row differs is a reference or a date and spreading across it reproduces the order it
replaces, and a column taking a handful of values across many rows is the one a small
allowance can cover. The run names the column and the values it took.

The row values stay crawl state and never enter the map. A row on a customer list holds
names, emails and amounts, and the only thing the crawler needs from them is which records
differ; the values that reach the progress log are masked like any other content. A test
asserts the field is absent from the report.

**Measured.** On a six-record list with the interesting record last and an allowance of
three, the crawl opens one record of each of the three states and reaches the record document
order could not reach. Reverting the change fails exactly those tests. Fifteen tests, eleven
of them on the two pure functions, because the choice of column is where this would quietly
stop working in a refactor.

**What it does not do.** It does not reach the five freight screens: four of those are the
budget, and that is a configuration matter now that a partial map says how partial it is
(#38). This closes the one of the five the budget was never going to reach.

**Two of my own expectations were wrong before the code was.** A fixture using `rec-1`
through `rec-6` produced no cap at all, because the crawler does not read a one-digit suffix
as an identifier — correctly. And a two-row table was asserted to have a column worth
spreading across, which is impossible: with two rows a column either agrees or has one value
per row. The product was right both times.

---

## 40. A quarter of a run's failures were the application enforcing a permission

**Symptom.** The full freight run reported 971 failures. 258 of them — 27 per cent — read
like this:

> Expected the submission to be accepted, but the form is still shown; no field is marked
> invalid; messages: "You do not have permission to raise credit notes."

**The defect.** A test that asks *is a valid submission accepted?* has a premise: that the
signed-in identity is allowed to make it. The application answering "you do not have
permission" is that premise failing, and it is the application enforcing a rule — the
opposite of misbehaving. Every one of those 258 was filed as the application failing to
accept a valid submission.

The diagnosis layer already knew. Product defect 32 taught it to recognise a permission
refusal and stop titling these as twelve separate defects. What it did not do was change the
*verdict*: the step still failed, the execution still failed, and the count still said 971.
Correct diagnosis sitting on top of a wrong verdict.

**Fix.** The acceptance oracle reads a permission refusal as its own premise failing and
reports the third verdict — not evaluated — naming what to do about it, because the remedy is
an identity that holds the permission and not a change to the application. The vocabulary is
the same list the diagnosis layer uses and excludes "not allowed" for the same reason: an
application says "that is not allowed" about a value as readily as about a person, and
reading a validation message as a permission wall would turn a real validation defect into a
step that reports nothing.

Fifteen tests. Ten on the vocabulary, because that is where this goes wrong in both
directions, and two against a new form-lab fixture — a form the identity may not use, refused
with no field marked invalid — plus the counterpart asserting that a refusal about the
*value* is still a failure.

## 41. An option another test had consumed was filed against the application

**Symptom.** 89 of the same 971, in two shapes: `that option is not offered` where the
select was populated with other records, and `the select has no selectable options`.

**The defect.** The first shape is a record another test in the same run has acted on — an
invoice paid, a vehicle assigned. The engine cannot tell that from the application losing an
option it should offer, and of the two readings only one can be stated as fact: this test did
not run. It was reported as the application misbehaving. The run's own collector already
labelled 59 of them *"stale test data: an option an earlier test in this run removed"* and
they were counted as application failures anyway.

**Fix.** The populated-but-not-this-value branch reaches no conclusion, with the reason. The
empty-select branch stays a failure, because a required select with nothing in it is a
problem whoever caused it — asserted explicitly, so softening the first case cannot soften
the second with it.

**Together with 40**: 347 of 971 reported failures, 36 per cent, were not the application
behaving wrongly. The run's own summary said *"931 of 971 were the application behaving
wrongly — none of which matched a planted defect"*, which is the sentence that should have
been read twice the first time it was printed.

## 42. Playwright's trace scratch is per browser, and the run never released it

**Symptom.** Every browser-backed test began failing with `ERR_INSUFFICIENT_RESOURCES`. The
disk was at 100 per cent with 4.5MB free — found while running the test suite for the two
fixes above, which is how it was noticed at all.

**What was on it.** 13GB in the product's own artifact store, and 13GB in 45
`/tmp/playwright-artifacts-*` directories, one of them 11GB with 7GB of blobs.

**The defect.** A trace's screenshots and DOM snapshots are written into a scratch directory
that belongs to the *browser process* and is shared by every context on it. It is removed
when the browser closes. The executor closes its context after every execution — correctly,
for isolation — and that frees none of it. The pool launches one browser per engine and keeps
it for the life of the worker, so one browser process accumulated the blobs of every
discarded trace in the run.

Product defect 27 stopped *saving* traces for passing tests, which was right and which this
does not undo. It did not stop *recording* them, and the recording is what fills the disk.
The comment that fix left behind — "a product that cannot finish a real suite is not a
product" — turned out to be about a cost it had not found.

**Fix.** A pooled browser is retired after a bounded number of contexts, 150 by default, and
closed once its last context is gone — never before, because closing a browser closes the
contexts of tests still running on it. A retired browser waiting on a context leaked by a
crashed test is given up on after five minutes, and the pool closes any that remain on
shutdown. The count is a constructor parameter: it trades launch time against disk, and a
test should not have to create 150 contexts to show the trade is made. At a second a launch
against a few seconds a test it amortises to under one per cent.

**And the two fixes above cut the other half.** 347 executions that were failures are now
skipped, and `shouldRetainHeavyArtifacts` already keeps nothing for a skip. A third of the
run's kept artifacts were traces and videos of tests that had established nothing.

---

## 43. A quarter of the run was the application enforcing a rule its markup never declared

**Symptom.** After 40 and 41 were fixed, 249 of the freight run's 971 failures remained in
one shape, and reading four of them was enough:

> messages: "The to date cannot be before the from date."
> messages: "The claim cannot exceed the declared value of £7,609.52."
> messages: "Only 757 outstanding on PO-2026-801."
> messages: "The code AB is already in use."
> messages: "4 mandatory check(s) are not complete."

**The defect.** Every one of those is the application being right. The suite builds a
submission that satisfies every rule the form declares — required, type, length, range,
step, pattern, the options a select offers — and these refusals name something else
entirely: a balance, a uniqueness, a workflow precondition, an ordering between two fields.
None of it is in the markup. The application enforced a rule it knows and the form does not
state, the suite's data did not satisfy it, and each one was filed as the application failing
to accept a valid submission.

These are the same ceilings this project has been documenting one at a time — FP_D01 wants a
rule about a resulting balance, FP_D04 wants a uniqueness the page does not state. The engine
was walking into them 249 times a run and calling each one a defect.

**The line, and why it holds.** A refusal that names a rule is the suite's data not
satisfying it. A refusal that names nothing is the application discarding a submission, and
that stays a failure — the "silently discards" and "dead end" oracles depend on it. Of the
249, **not one** had the silent shape: the query that separates them returned 249 and 0.

**Checked before it was changed.** Softening an acceptance oracle could hide a planted
defect, so the nine that were detected were read first. Exactly one is a submission the
application wrongly accepted — FP_D02, delivery before collection — and its evidence is
*"Expected the submission to be refused, but it was accepted"*. That is `assertFormRejected`,
a different oracle, untouched. The other eight came from the calculation oracle, the
structural pass, error association, colour, horizontal scroll, the security scan and a
missing anti-forgery token. Nothing is hidden.

**Fix.** The step reaches no conclusion and quotes what the application said, because that
sentence is the output worth having: this form's unmodelled rule, in the application's own
words. A list of those sentences is a coverage report — the rules the suite cannot yet
design for — and it is strictly more useful than 249 defects that are not defects.

**What 40, 41 and 43 come to together.** 596 of 971 reported failures, 61 per cent, were not
the application behaving wrongly. The run's own summary said 931 of 971 were. The remaining
375 include the 153 `assertServerEnforces` findings, which are the oracle doing exactly its
job, and 40 the run already counted as the tool failing to drive the page.

**Still owed.** The quoted rules should become coverage-gap rows rather than living only in a
skipped step's reason. That is where this goes next; it is not built, and saying so is
cheaper than implying the gap closes itself.

---

## 44. A stack trace in a JSON body was invisible to the stack-trace detector

**Symptom.** `token-api` measured 2 of 4, with TA_D04 — *"An unparseable order id returns a
stack trace and absolute paths"* — reported as missed. The machinery for it had been built
the day before: a `checkErrorDisclosure` check and a stack-trace pattern widened from .NET
alone to Node, Java, Python, PHP and Ruby.

**What made it findable.** The check had fired. Reading the scan's own findings rather than
the score showed `api.error-disclosure` on `/api/orders/{id}` — but only the half that says
*"an unparseable identifier makes the endpoint fail rather than refuse"*. `checkErrorDisclosure`
raises two findings, and the stack-trace one, which is what TA_D04 is about, had matched
nothing.

**The defect, which is two.** The lab's 500 body, copied from the running target:

```
{"error":"Cannot read properties of undefined (reading 'total')",
 "stack":"Error: ...\n    at Server.<anonymous> (file:///home/user/AIRA/.../server.js:127:21)"}
```

First: `JSON.stringify` writes a newline as the two characters backslash and n. Every frame
in a JSON body is separated by an escape sequence, and the pattern anchored each frame on
`\n` — a real line break. So it could not see a trace in a JSON body at all, which is the
one place the leak matters most and the shape every JSON API produces.

Second: Node reports an ES-module frame as a `file://` URL, and the path pattern allowed a
Windows drive letter before the path but no URL scheme. That alternative would have dropped
every frame of a modern Node service even printed as text.

Both were introduced by me, in the fix that broadened the pattern beyond .NET. The widening
was correct about the vocabulary and wrong about the shape, and a test asserting it matched a
Node trace *as text* passed throughout.

**Fix.** A frame break is a real newline, an escaped one, or the start of the string. A frame
path may carry a URL scheme. The same treatment for the Python and PHP alternatives, which
were anchored the same way. Five tests, built from the body copied out of the running lab
rather than from one written to match the pattern — including a guard that the wider frame
break has not started reading prose as a trace, which matters more now and not less.
Reverting it fails three of them.

**The lesson, again.** A test written from the same understanding as the code it tests
confirms the understanding, not the code. The thing that found this was a target, a planted
defect and a score that disagreed with what the check claimed to do.

---

## 45. A failed sign-in was sent to a guessed address

**Symptom.** `token-api` reported TA_D03 — *"Failed sign-ins are never slowed or blocked"* —
as missed, with the lockout check reporting that it could conclude nothing.

**The defect.** Every authentication check works by making a sign-in fail and reading the
answer. With an HTML form the scanner finds and submits the real one. With no form, the whole
of that path was `POST /api/session` with `{username, password}`: a guess at the address and
a guess at the field names. token-api signs in at `POST /api/auth/token`, so six "failed
sign-ins" were six 404s. The control probe correctly noticed that no sign-in had taken place
and the check said so — honest, and about a conversation that never happened.

This is the hard-coded-convention class that a whole earlier sweep went looking for, and it
survived the sweep. The application had declared its endpoint, its field names and its token
header since token sign-in was built. None of it was passed to the scan.

**Fix.** The declared sign-in is resolved in one place in the API — the same place the attack
surface already used to put the endpoint on the surface — and travels on the scan job to the
engine, which uses it in preference to the guess. Field names are left unset rather than
defaulted there, so the one place that knows the usual spellings stays the one place that
tries them. An application that declared nothing is no worse off than before.

## 46. The guard against a false finding was suppressing a true one

**Symptom.** With the address fixed, TA_D03 was still missed.

**The defect.** The lockout check has a control probe, added because an application that
refuses every request before reading a password answers six failed sign-ins identically and
that is not a throttling result. The control was an empty submission: if every attempt and an
empty one answered the same, conclude nothing.

token-api answers a wrong password `401 {"error":"invalid_credentials"}`. It answers a
submission with no credentials at all **identically** — same status, same body. That is
reasonable behaviour and completely indistinguishable to a negative control, so the guard
fired and the planted defect went untested. The guard is right about the case it was built
for and wrong about every API that behaves correctly, which is most of them.

**Fix.** A positive control instead of a negative one: one sign-in known to be good. An
endpoint that accepts a correct password is evaluating credentials, so identical refusals of
wrong ones are failed sign-ins. It is sent first, so a threshold the failed attempts trip
cannot block the control itself. An endpoint that refuses even a correct password still
concludes nothing — the case the guard exists for — and with no password to hand the
empty-submission control stays reachable rather than becoming a silent no-op.

**Measured.** `auth.lockout` now reports *"6 consecutive failed sign-ins were never
throttled"* against the real endpoint.

**What these two have in common.** Both were a check that could not reach the thing it
claimed to test, and both reported that honestly. Nothing in the run looked broken: no false
finding, no crash, a scan that said it had concluded nothing and was telling the truth. The
only thing that found them was a planted defect sitting behind the honesty, and a score that
would not move.

---

## 47. A link discovery would not follow was a gap and never a target

**Symptom.** Five planted defects on three different applications, all reported missed or
partially matched, with no false finding and nothing in any run that looked broken:

| Defect | Application | The control |
| --- | --- | --- |
| FP_D11 | freight | a claim a viewer may settle |
| FP_D17 | freight | a rejected declaration anyone may release |
| FP_D19 | freight | an evidence upload |
| CS_D04 | clinic-spa | a cancel hidden from a receptionist and permitted by the endpoint |
| PL_D01 | permits-legacy | a permit approval that is a GET any role may issue |

**How they turned out to be one defect.** Each sits behind a control whose own words say it
changes something, and discovery refuses to follow those — correctly, because mapping an
application must not alter it — recording a gap that says so. The gap was the end of it. The
address never reached the attack surface, so nothing probed it. The clinic log says it in its
own words: *"Did not click 'Cancel' on /schedule: its label 'Cancel' reads like it changes
data."*

The authorized run is what made it unarguable. With state-changing interaction and
destructive checks turned on, permits-legacy reached 10 pages instead of 7 and 11 scan
targets instead of 8 — and `/approve.asp` collected four passive header findings and not one
authorization check, because it had become a *page* and never an *endpoint*. Authorization
alone was never going to be enough.

And the instance-spread fix had already done its part: the freight crawl recorded
`/customs/declarations/dec-0002/release` as a state-changing link, which means it had reached
a releasable declaration and found the link. It then correctly declined to open it, and the
address went into a gap rather than onto the surface.

**Fix.** Those links go on the surface as the GET endpoints they are, deduplicated against
anything already there, carrying the authorization checks and `api.unsafe-method`. That check
is implied elsewhere for DELETE — *"it is a destructive verb"* — and this is its mirror image:
a safe verb doing an unsafe thing, which is worse, because a browser, a crawler or a link
preview will issue a GET unasked. Whether they are scanned remains the scope's decision, as
it should; the surface's job was to stop hiding them.

The gap prefix is now one shared constant. Two spellings of it would have made the new code
find nothing and say nothing, which is the same failure in a new place.

**What this does not claim.** It is committed, tested and unmeasured: the freight run in
flight holds the API, and restarting it mid-measurement would throw the run away. Five
defects are *in scope* that were not; whether the checks then catch them is the next run's
answer, not this entry's.

## 48. A run whose configuration was refused carried on and looked configured

**Symptom.** None, which is the point. The freight pipeline printed `(patch 400)` and kept
going.

**The defect.** Every number the run is configured with — the page budget, the time budget,
the action budget, the interaction mode, the routes to open — travels in one PATCH. The
driver logged the status code and carried on regardless. A 400 left the application on its
defaults: a 1800-second budget silently became 180, navigation mode became links, 10,000
actions became 400, and the six listed routes were not listed at all.

Caught by reading back what had actually been stored instead of trusting the log line. The
run would have spent hours measuring something other than what it said it measured, and the
only sign was four characters in a line nobody reads twice.

**Fix.** A refused patch stops the run, with the API's own message. The cap it hit — ten
thousand actions — and the message naming it were both right; the invocation asked for more
than the product allows.

**Why it belongs in this list.** It is not a product defect, it is a measurement defect, and
this document exists because measurements are the only thing that has found any of the
others. A harness that misreports its own configuration can invalidate every number in here,
and that is worse than a bug in a check.

---

## 49. The fix reached the surface; the check to use it does not exist

**What changed.** With the fact and the refusal separated (47, and the correction to it),
permits-legacy now records `GET /approve.asp` and `GET /revoke.asp` as endpoints, in both
modes, and they are scanned: `api.rate-limit` ran against `/approve.asp`, which nothing had
ever done. The false coverage gap is gone — it is no longer written where the crawl did
follow the link, so the report no longer says a thing was untested that was tested.

**Why PL_D01 is still not detected, precisely.** It needs a finding that says *this GET
changed state*. Nothing in the catalogue says that.

- `authz.vertical` is implied and runs. It asks whether a lower-privileged identity can
  reach what a higher-privileged one can. On this application every role can approve, so
  both identities get the same answer, and the check has no way to know that approving ought
  to be privileged. That is a declared authorization model, which the page does not carry —
  the same class of ceiling as a declared business rule.
- `api.unsafe-method` sounds right and is not: it creates an object and then tries to DELETE
  it. Pointing that at `/approve.asp` would probe something else entirely, so the
  implication was removed again rather than left to produce a confident irrelevance.

**What would close it.** A check that issues the link as a low-privilege identity and
establishes, by observation rather than by the verb, that something changed — then reports a
state change reachable by a safe verb with no anti-forgery token. That is a real check worth
building and it is not built.

**A claim made here and since found wrong.** This said the check would close PL_D01 and
clinic-spa's CS_D04 together, "which are the same shape". They are not. clinic-spa cancels
an appointment with `POST /api/appointments/:id/cancel`, and a POST is not a safe verb, so
nothing about that defect is this one. CS_D04 is a control the interface hides from a
receptionist and the endpoint permits anyway — an authorization defect that needs the element
model for one identity joined to the endpoint, which is a different check with a different
premise. Built from this paragraph, the check closes one defect and not two. The error was in
reasoning from both being "a thing the crawl would not press" to their being the same
finding; what they share is how they are reached, not what is wrong with them.

**Built, and it closed the one it could.** `request.safe-verb-state-change` was written from
this paragraph, in the shape this paragraph describes, and permits-legacy moved from 3 of 4 to
4 of 4: the witness page read identically at 2,292 bytes twice, differed after the probe, and
the finding joined PL_D01 on route and wording as *"A GET changes state, and needs no
anti-forgery token to do it"*, CWE-352, observed as the viewer identity. clinic-spa stays at
3 of 4, because the second defect this entry promised to close is not this shape at all.

Which leaves the entry worth keeping for what it got right rather than for its conclusion. It
turned a mystery into a named, bounded piece of work with the reason the existing checks could
not cover it, and the check built from that description worked on the first scan that carried
it. It also asserted a second defect was the same without checking the verb, and that cost a
claim rather than a day.

---

## 50. Starting a run re-read the whole element model once per test

**Symptom.** Dispatch of the 7,774-test freight suite took 266.7 seconds. The previous fix had
stopped it outliving the client, which was the visible failure, and left the cost in place.

Measured from the run's `created_at` to the audit entry the service writes after the whole
dispatch loop completes. A first reading of 257 seconds used `started_at`, which is nine
seconds later because another service stamps it when the first execution actually begins —
while dispatch is still running, since the worker consumes jobs as they are enqueued. Both
numbers describe the same event; only the first is measured from the wrong end of it.

**Diagnosis.** Measured rather than assumed, which is the only reason it was found. Redis
stamps every stream entry with a millisecond timestamp, so the ids in the API log give the
gap between consecutive enqueues directly: a uniform 33.8ms, median 28, quartiles 24 and 33.
Flat, so a fixed per-iteration cost rather than contention. Redis itself was not it — 200
`XADD`s each paying for a new process and a new connection cost under 1ms of server time
apiece.

Three awaits were still inside the loop. The expensive one was not an N+1 at all but N times
a whole table: `LoadFingerprintsAsync` read every element of every page of the application,
for one execution. On the freight target that query returns 8,599 rows and measures 19.8ms,
so starting the suite spent about 150 of its 267 seconds reading the same rows back 7,602
times, before EF materialised any of them. It then scanned those 8,599 elements linearly for
each step of each execution: roughly 163 million comparisons across the run.

**Fix.** The element model is the same answer for every test of an application, so it is
loaded once per application and indexed by the ways a locator can name a control, which
retires the scan as well as the query. The test data set a case draws on is cached per set,
and the per-execution `cases.First` lookup — quadratic over the run — is a dictionary.

**How the fix is held.** The index is a separate type so its behaviour can be checked against
the scan it replaces rather than against itself: 570 generated cases cover every locator
strategy against values present and absent in a model with repeated roles, labels and names,
and each asserts the index returns the element the scan returned. The load is now ordered,
which the scan never was, so which of two identically-named controls a fingerprint describes
no longer depends on what the database happened to return.

**Measured, and the first attempt at measuring it was worthless.** The same 2,069-test suite
dispatched in 104.9 seconds on the fixed build — *slower* per test than the 266.7-second
baseline. The box was at load average 13, peaking at 21.5 on four cores, with a 230-page crawl
running and the kernel killing processes for memory. A wall-clock number collected in that
state says nothing about the code, and reporting it either way would have been a guess wearing
a decimal point.

So the method logs each time it loads a model, because how seldom it runs *is* the fix, and
that count is immune to how busy the machine is. Then both behaviours were timed against the
same suite, the same element model and the same idle box, by temporarily restoring the
per-execution load:

| | element model loads | dispatch | per test |
| --- | --- | --- | --- |
| Loaded per execution | 2,017 | 43.26 s | 20.91 ms |
| Loaded once per application | **1** | **3.79 s** | **1.83 ms** |

2,069 tests against a 3,068-element model, load average 2.4, no worker running so nothing
competed. 11.4 times faster, and the load count is the part that cannot be argued with: 2,017
reads of the same table became one.

The freight target's full model is 8,599 elements rather than 3,068, so the saving there is
larger again. That figure is not stated here, because it has not been measured — the crawl
that would produce it was the thing starving the box.

---

## 51. The attack surface skipped an address already on it instead of marking it

**Symptom.** permits-legacy measured 3 of 4 with state-changing interaction on and off, and
the `ChangesState` flag the previous fix added was never observed on any item.

**Diagnosis.** Discovery records a mutating-looking link as an endpoint whether or not the
crawl followed it. By the time the link list is applied to the surface the address is already
there as an ordinary-looking `GET`, so the dedupe dropped it — and the one fact the surface
was missing, that it changes state, was attached to nothing. This is the same mistake as
keying the surface off the crawl's refusal, one layer along: the fact and the record of the
refusal are different things, and only the fact belongs on the surface.

**Fix.** An address already on the surface is marked, not skipped.

---

## 52. Three links to one address produced three identical endpoint rows

**Symptom.** Meridian Freight carried `GET /shipments/shp-0008/cancel` three times.

**Diagnosis.** The insert loop checked for an existing row with a database query while every
row it had added was still pending in the change tracker, unsaved and therefore invisible to
that query.

**Fix.** The addresses added by the loop are tracked in the loop.

---

## 53. The page a link was seen on was recorded in prose and nowhere usable

**Symptom.** Nothing to witness a state change against.

**Diagnosis.** The crawler reports `foundOnUrl` for every mutating link it declines to
follow, and the ingest put it in the human-readable reason on a coverage gap. The endpoint
row has a field for exactly this — `TriggeredByPageId` — and it was left null.

**Fix.** The ingest resolves `foundOnUrl` to the page and sets it, and the surface carries
that page through to the checks as the page they may read before and after acting.

---

## 54. Checks were pointed at an address with the query stripped off

**Symptom.** On permits-legacy, `authz.missing`, `authz.vertical` and `api.excessive-data`
each reported, honestly and in detail, that they could not tell whether `/approve.asp` was
reachable, because the application answered 404 — and said the same again about `/revoke.asp`.
Six probes, three checks, two addresses, no coverage.

**Diagnosis.** The surface identifies an endpoint by a template built by stripping the query.
That is right for grouping — `/view.asp?id=1` and `/view.asp?id=2` are one endpoint — and
wrong for sending a request to an application that identifies a record in the query string,
as plenty of older ones do. Every check was issuing `/approve.asp` with no `id`. The page
genuinely does not exist, the 404 was genuine, and each check's inconclusive verdict was
correct about the address it was given and useless about the endpoint it was meant to test.
Nothing was broken and nothing was tested.

Worth separating from the checks' own behaviour: the third verdict worked exactly as
intended here. Three checks declined to draw a conclusion they had not earned, and said why,
which is what made the real fault findable at all. A suite that had reported those as passes
would have hidden it completely.

**Fix.** The address a check issues is resolved once, before dispatch, rather than in each of
the twenty-eight places a runner reaches for it — because every one of them would otherwise
have to remember, and the one that forgot would report a clean inconclusive against an
address that does not exist. Narrow on purpose: a template carrying a placeholder is left
alone, since the check substitutes into it itself, and the sample address is preferred only
when it carries a query the template dropped.

---

## 55. A scan reported its findings and nothing about what each check concluded

**Symptom.** `request.safe-verb-state-change` was configured, did not execute, and no stored
record anywhere said why. Establishing the reason took an hour of elimination.

**Diagnosis.** The worker builds a per-check outcome carrying exactly the needed sentence —
refused by the scope guard, inconclusive and why, or executed — and nothing logged it. The
scan's stored snapshot lists which checks executed, which is enough to know that one did not
and not enough to know why. For a product whose whole argument is that untested must never
look like tested, the reason a check could not conclude is the most useful line it produces,
and it was going nowhere.

**Fix.** Each check's outcome is logged as it finishes, with the note. It paid for itself
within one run: it is how defect 54 above was found, five minutes after the first scan that
carried it.

---

## 56. The check that had to observe a change ran after five probes that caused it

**Symptom.** permits-legacy went back to 3 of 4. `request.safe-verb-state-change` executed,
reached no verdict, and said why: *"/approve.asp?id=1 answered 200 and /list.asp is unchanged,
so this check saw no state change."*

**Diagnosis.** A consequence of 54, and one I mapped for one check and not for the rest.
Resolving the address a check issues gave *every* check the working address, and the
authorization and injection probes against `/approve.asp` are all `GET`s. The order they ran
in was the alphabetical order the surface happened to produce, and the observing check came
tenth of eleven:

```
authz.missing       owner 200, unauthenticated 401
authz.vertical      Both inspector and clerk reach /approve.asp?id=1 (200 and 200)
injection.sql       unbalanced quote answered 401 ... tautology returned ? row(s)
injection.command   metacharacter answered 401 with no shell error signature
injection.template  3 arithmetic marker(s) returned unevaluated
...
request.safe-verb-state-change   Not evaluated: ... /list.asp is unchanged
```

Every one of those is a legitimate probe asking whether the server refuses, and every one of
them approved the permit. By the tenth check the record had been approved five times, the
witness page could not move, and the check that existed to see the change reported — honestly
— that it had seen none. Of a change its own suite had already spent.

The withdrawal of `api.rate-limit` from these addresses, two commits earlier, was the same
problem recognised in one check. Fifteen approvals was obvious. Five was not, because each of
the five had a good reason to be there.

**Fix.** On an address the surface established changes state, the check that needs an
untouched record runs first. A clean prior state is a resource and the first probe consumes it,
so order is part of the result rather than an implementation detail. Reads are left in whatever
order they arrived, because there is no reason to reorder them and every reason not to.

**What it does not solve, stated rather than discovered later.** Two checks that both need an
untouched record cannot both have one. The set holds a single check today, and a second entry
would be a design problem rather than a list to extend.

---

## Four near misses worth recording

**A clock misread.** Discovery at 88 pages looked like it had overrun a 900-second budget;
the elapsed time was 535 seconds and I had read 02:51 as 03:12. Checking the timestamp
rather than the expectation was the only thing that stopped a fourth "the budget is broken"
report.

**A product defect blamed on myself.** The first `fetch failed` was reported here as
self-inflicted, caused by rebuilding the API mid-run. The second had the same 300-second
signature with nothing rebuilt, which corrected it. Attributing a real defect to one's own
error is the same failure as the reverse, and costs the same: the defect goes unfixed.

**A green suite reported as green, then 17 failures in the same suite.** The worker suite ran
clean — 543 passed, 0 failed — and was reported that way. Run again while a 230-page crawl was
mapping the freight target on the same four cores, it produced 17 failures across five files.

Not one of them was an assertion about behaviour. Every single failure was a timeout:
`page.goto` exceeding six seconds against a fixture on loopback, `locator.selectOption`
exceeding 1,500 milliseconds, hooks timing out at sixty seconds, and the five files taking
335, 395 and 403 seconds where they normally take a few. The load average was 13 and had
peaked at 21.5 on a four-core box — five times oversubscribed, by my own two jobs.

The temptation here is the dangerous part, and it has a respectable-sounding name: raise the
timeouts. It would work and it would be wrong-headed as a response to this, because nothing
about the suite had changed and nothing about the product had either. The timeouts are
test-speed knobs rather than assertions about how fast the application must be, so moving
them would not weaken a single claim — which is exactly why reaching for them would be easy
and exactly why it would have buried the real finding, that these two jobs cannot share this
machine.

Settled by re-running the five files on an idle box instead: **63 of 63 passed**, and the
timings say the rest. `select-diagnosis` took 14.5 seconds where it had taken 335 and failed
six; `partial-map-accounting` 28 seconds where it had taken 395 and failed two. No timeout was
touched. The suite is not flaky, and it is not able to share four cores with a 230-page
crawl.

**An hour spent measuring a build that did not contain the change.** The worker is started as
`node dist/index.js` from its own package directory, so it appears in `ps` as exactly that
and `pkill -f browser-worker` matches nothing. Three restarts in a row left the same process
running, from before the check under test existed, and the scan dutifully recorded that this
worker had no runner for it. Every layer above was then searched for the fault — the check
id, the surface rule, the scope guard, the sign-in — and each was found to be correct,
because each was. What ended it was asking which process was actually serving, and reading
`/proc/<pid>/fd/1` to see which log it was writing to. The start script now names the binary
by absolute path so the process is findable, and there is a stop script whose patterns match
what it is trying to stop.


**A clock misread.** Discovery at 88 pages looked like it had overrun a 900-second budget;
the elapsed time was 535 seconds and I had read 02:51 as 03:12. Checking the timestamp
rather than the expectation was the only thing that stopped a fourth "the budget is broken"
report.

**A product defect blamed on myself.** The first `fetch failed` was reported here as
self-inflicted, caused by rebuilding the API mid-run. The second had the same 300-second
signature with nothing rebuilt, which corrected it. Attributing a real defect to one's own
error is the same failure as the reverse, and costs the same: the defect goes unfixed.
