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

Entries 29 to 58 are dominated by one shape, and it is the most dangerous one here because it
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

**Two claims made here and since found wrong, both about the same defect.**

The first said the check would close PL_D01 and clinic-spa's CS_D04 together, "which are the
same shape". They are not. clinic-spa cancels an appointment with
`POST /api/appointments/:id/cancel`, and a POST is not a safe verb, so nothing about that
defect is this one. The error was reasoning from both being "a thing the crawl would not
press" to their being the same finding; what they share is how they are reached, not what is
wrong with them. Built from this paragraph the check closes one defect, not two.

The second was the replacement for the first: that CS_D04 needs the element model for one
identity compared against another's, and so is a feature rather than a fix. Also written
without being tested, and also wrong.

The cause was three layers below either guess. Three mentions of "cancel" exist in the whole
clinic-spa fixture: the comment describing the defect, the button markup, and the server route.
No line of client code ever joined the second to the third. The lab drew a Cancel button that
called nothing, so the application never issued `POST /api/appointments/:id/cancel`, discovery
never observed it, the endpoint never reached the attack surface, and no authorization check
could be pointed at it. The product was behaving correctly throughout.

Wiring the control, which is what the fixture's own ground truth describes, and authorising
interaction put the endpoint on the surface on the first run and produced three findings
against it — `authz.readonly` reporting *"A read-only account can perform a write"*, which is
the planted defect, with `request.csrf` and `request.origin` beside it. clinic-spa went to
4 of 4, and the matcher joined it without a word of its ground truth being touched.

Two wrong sentences about one defect is the lesson worth keeping. Both times the reasoning was
sound and the premise was untested. The question that settled it was not about the crawler or
the identities or the verb; it was "does the application actually do the thing", and it went
unasked through three runs and two written explanations by someone who had just spent the day
insisting that a check must observe rather than assume.

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

## 57. A map never said it was one identity's view

**Symptom.** None, which is the point. Freight's `/claims/:id/settle` sat unreached across
every run and every report of this project, and nothing anywhere said why.

**Diagnosis.** Established with a control group rather than inferred. `ops.lead`, the account
the freight measurements sign in as, holds `role-operations`: `shipment:cancel` yes,
`claim:settle` no. An interactive crawl as that account reached `/shipments/:id/cancel` three
times over and never reached `/claims/:id/settle`. Not because it declined to press Settle —
the application does not render Settle for a role without the permission, so there was nothing
on the page to press. The same crawl as an administrator logged
`Found .../claims/clm-0001/settle by clicking "Settle"` on the first pass.

So a map is bounded by the identity that made it, and the reader of one had no way to learn
that. The crawl already reports its unopened frontier and its per-route caps, which are the
two limits anyone thought to report; this third one was invisible, and an invisible limit is
indistinguishable from no limit.

**Fix.** The crawl says so at the end, where the other limits are said: this map is what the
signed-in identity can see, a control the application does not render for that identity is on
no page here, and mapping again as an identity holding other permissions is how to find out
what that leaves out.

**What it deliberately does not do, twice over.** It does not name the identity. The first
version interpolated the username, the masker redacted it as the personal data it is, and the
note read *"This map is what \*\*\*REDACTED\*\*\* can see"* — worse than silence, because it
looks like information and carries none. Whoever reads it configured the identity; what they
could not see anywhere was that the map is bounded by it. And it does not count what it
missed: a control absent from the page leaves nothing to count, so any number would be
invented. Both are asserted by tests, because both are the kind of thing a later edit
helpfully adds back.

---

## 58. A check wrote the reason it could not run and the reporting threw it away

**Symptom.** `api.error-disclosure` was the one check on the freight scan that produced no
outcome anyone could read: *"Refused by the scope guard: unknown."* Nothing had been refused.

**Diagnosis.** Two mistakes in one line, and the per-check logging added in 55 is what made
either visible.

```js
return { skipped: true, decision: 'This endpoint takes no identifier, …', findings: [] };
```

`skipped` means the scope guard refused the request — the worker's note for it says exactly
that — and nothing was refused. The check cannot evaluate an endpoint with no identifier in
its path, which is what `inconclusive` is for. Reporting "not permitted" where the truth is
"not evaluable" inverts the one distinction this product is built on, and does it in the
reader's direction: a refusal sounds like a setting somebody can change.

And `decision` is the scope guard's decision object everywhere else it appears, so the worker
read `.reason` off a string, got `undefined`, and printed `unknown`. The check had written a
perfectly good sentence — *"this endpoint takes no identifier, so there is nothing to make
unparseable"* — and the reporting layer discarded it, which is the same fault as 55 one layer
along: a reason that exists and does not arrive.

It was the only check in the engine doing this. Swept rather than assumed: one occurrence of
`decision: '` in the whole package.

**Fix.** The check returns `inconclusive` with a `reason`, as the convention has it. The
worker reads the guard's `explanation` first, then its `reason`, tolerates a decision that is
itself a string, and when there is genuinely nothing says so — *"no reason was given, which is
itself worth fixing"* — rather than `unknown`, because the two are different and only one of
them is a bug in this file.

**The test pinned both mistakes**, asserting `skipped: true` and the sentence in `decision`.
It now asserts the corrected contract and says in the body why the old one was wrong, because
a test that pins a false statement is worse than no test: it defends the behaviour from the
next person who notices.

---

## 59. Two checks existed, ran, and were absent from the list that governs them

**Symptom.** None, which is the point. Both checks worked. `request.safe-verb-state-change`
found permits-legacy's GET-that-settles and `api.error-disclosure` found freight's stack
trace. Neither was in `SecurityChecks.All`.

**Diagnosis.** That list is not a catalogue, it is a gate. Two code paths read it:

```csharp
if (string.IsNullOrWhiteSpace(check) || !SecurityChecks.All.Contains(check))
{
    notes.Add($"An open {finding.Category} finding names no known check ('{finding.TestId}'), "
            + "so nothing could be selected to cover it. It is not being re-tested by this run.");
    continue;
}
```

That block exists for one reason, stated two lines below it: *"a check that found something
and then stopped running is how a regression hides."* An open finding keeps its own check
selected whatever the change touched. A check absent from `All` fails that membership test, so
the finding it raised reads as naming an unknown check and is dropped from selection. The
permits-legacy CWE-352 finding, earned the same week, would not have been re-tested by the
next change-driven scan — defeated by its own safeguard, through the omission of one
identifier from one array.

The class's own doc comment had already named this failure: *"a check named one way in the
selector and another way in the scan record produces a gate that reports full coverage from a
scan that ran nothing."* Absent is worse than misnamed. A misnamed check is in the universe
and wrong about itself; an absent one cannot be reported as untested, because as far as the
coverage arithmetic is concerned it does not exist.

**Why nothing caught it.** The guard was there and was correct. `SECPL-027` compares the
platform's vocabulary against the engine's, in both directions, and would have failed on
either check. It asks the running platform for its list over HTTP, so it runs when somebody
runs the whole product verification and not otherwise. Nobody had. A guard that only fires in
the expensive suite is a guard against the wrong thing.

Read off disk, the drift was: 34 constants declared, 33 in `All`, 32 in the engine's mirror.

**Fix.** Three parts, because the omission and the reason it survived are different faults.

- `StateChangeBySafeVerb` added to `All`; `api.error-disclosure` and
  `request.safe-verb-state-change` added to the engine's mirror. The two lists are now
  identical at 34.
- A C# test that reads the declared constants by reflection and asserts every one appears in
  `All`. It repeats no names, so a check added without being listed fails here rather than in
  a scan.
- A node test that reads the C# source off disk and compares the two lists. No database, no
  API, no browser: it runs with the engine package's own suite, which is the cheapest suite
  that could possibly catch this. It does not replace `SECPL-027`, which proves the *running*
  platform serves what its source declares — something a file read cannot establish.

**Both guards were checked for sensitivity rather than assumed.** The C# test failed before
the one-line fix and passes after. The node test was run against a deliberately mutated
mirror, reported *"only in the platform: request.safe-verb-state-change"*, and went green when
the mirror was restored. A guard that has only ever been seen passing is not known to work.

---

## 60. Personal data in a URL was never a finding, only personal data in a body

**Symptom.** FP_D32, a customer contact search that submits an email address by GET, was
missed by every scan. No check in the engine asked the question.

**Diagnosis.** The sensitive-data check has this in its own file, and it is right:

> Email addresses and telephone numbers are deliberately absent. A support address in a
> footer is not a leak, and a detector that reports one teaches its readers to skim — which
> costs more than the finding is worth.

That reasoning holds for a response body and does not transfer to a URL. An address in a body
is read by whoever was already entitled to the page. The same address in a query string is
written to the web server's access log, every proxy log in between, the browser history of
what may be a shared terminal, and the `Referer` header of every request the page then makes
to a third party. The data has left the conversation it was part of. Same data, different
exposure, and the second one is CWE-598.

So this is not a correction of that decision. It is the question that decision did not cover.

**Fix.** A new check, `passive.pii-in-url`, on two kinds of evidence, neither of which is a
guess about a value:

- A query parameter whose *name* says what it holds. The name is better evidence than the
  contents: a value that looks like an email in one record may be empty in the next, and the
  parameter is a leak either way. A validated value raises confidence when one is there and
  its absence never lowers the finding.
- A form that will submit such a field by GET, read from the page's own markup — so it is
  found before anyone has used it. **A form with no method attribute submits by GET**, which
  is how most instances arrive: nobody chose it, and the check says so in the finding.

The name list is deliberately short. Every entry is a name whose only ordinary meaning is
personal data about an identifiable person: not `name`, which is as often a product's, nor
`id`, `account` or `reference`. A test holds fourteen ordinary parameter names — `q`, `id`,
`name`, `page`, `tier`, `reference`, `customerId`, `search` and the rest — and asserts every
one stays quiet, because a check that reports them all would be read once and skipped
thereafter.

**Measured against the live application, both ways.**

```
defect ON : 1 finding  — A form on /customers submits contactEmail by GET   (CWE-598)
defect OFF: 0 findings — the same form, method="post"
```

The control group is the half that matters: with the planted defect switched off the markup
becomes a POST and the check goes silent. Pointed at the address the form produces,
`/customers?contactEmail=…`, it raises both findings and gives the one with a real value in
it Medium confidence against the markup-only Low — the confidence model doing its job
unprompted.

The value itself is never written into a finding, and a test asserts that by searching the
serialised output for it.

---

## 62. The cookie check read the one request that issues no session cookie

**Symptom.** FP_D30 — the "remember me" branch reissuing the session cookie without HttpOnly —
was missed by every scan. `passive.cookies` ran, reported nothing, and looked clean.

**Diagnosis.** The check did one passive GET of the page under test and judged whatever
`Set-Cookie` came back. A page GET is close to the only request that does *not* issue a session
cookie: the cookie worth judging is minted by the authentication response, which this check
never made. It was looking at the wrong exchange and reporting a clean result from it.

The same fault had already been found and fixed one check along. `passive.sensitive-data`
carries this comment:

> Read as a signed-in identity where the job carries one. Anonymously, this check examined
> whatever an application shows a stranger — on anything behind a sign-in, the sign-in page —
> and reported it clean.

Cookies was left behind.

And one authentication exchange would not have been enough. `readSignInForm` had this:

```js
if (type === 'checkbox' || type === 'radio') continue;   // left as the form defaults
```

Leaving the box unticked is right — a scan should authenticate the way the form does. Throwing
away the fact that the box exists is not. A form offering "keep me signed in" has two
authentication paths, they are often written by different people at different times, and that
is how one of them ends up assembling its `Set-Cookie` by hand and losing `HttpOnly` doing it.

**Fix.** `signInExchanges` returns one exchange per way the form will authenticate: the default
submission, then one per optional control, each on its own rather than in combination, capped
so the number of requests is not decided by how many boxes somebody put on a login page. The
cookie check judges all of them and names which branch set the cookie, because "the session
cookie lacks HttpOnly" and "it lacks HttpOnly when you tick remember me" are different bugs to
go and fix.

**Three things fell out of it.**

A check that saw no cookies used to return exactly what a check that saw well-configured ones
returned. "Correct" and "never looked at" read identically. It is now `inconclusive` with the
reason, in three forms: credentials were examined and no session cookie appeared, credentials
were supplied but no sign-in form was found to use them on, or no credentials were given at
all. They are different states and a reader can act on each.

`attributesOf` only matched `name="value"`, so a bare HTML boolean — `checked`, `required`,
`disabled`, `readonly` — was invisible. A pre-ticked checkbox read identically to an unticked
one, and the loop above dropped it from the submission entirely, so the scan quietly signed in
differently from the form for any application that pre-ticks one.

**Measured on the live application.** The scan reports, twice:

```
[medium] Session cookie "lab_session" is missing HttpOnly when "remember" is enabled
```

The two headers side by side, from the same endpoint, are the whole defect:

```
no remember-me:   lab_session=…; Path=/; HttpOnly; SameSite=Lax
with remember-me: lab_session=…; Path=/; Max-Age=2592000; SameSite=Lax
```

---

## 63. A comparison check was handed one identity twice and called it inconclusive

**Symptom.** `authz.vertical` reported on five freight targets: *"Both administrator and
administrator reach this route."* Nothing had gone wrong, as far as the report was concerned.

**Diagnosis.** The worker resolves four identity slots. `privileged` and `readOnly` matched on
the role the caller declared — one of them had already been fixed once for only recognising
"admin" when the documentation said "privileged". `owner` and `intruder` were left taking
whatever came first and second:

```ts
const owner = (context: ScanContext) => [...context.identities.values()][0];
const intruder = (context: ScanContext) => [...context.identities.values()][1];
```

The freight launcher declares `privileged`, `owner`, `readonly`, in that order, which is the
order its own documentation uses. So `owner` returned the administrator, and `authz.vertical`,
which asks for the privileged identity and a lesser one, got the administrator twice. It
compared him with himself and reported that both roles reached the route — on evidence that
could not have come out any other way.

**This is the worst shape a false negative can take.** It was not a wrong finding, which
somebody would check. It was `inconclusive`, with a true and reasonable sentence attached
about most routes being reachable by every role — a limitation a reader would accept, standing
in for a check that could never have failed. The lesser identity held every privilege.

**Fix.** Both sides, because either alone leaves the hole.

The worker resolves every slot by declared role, falling back to position, and the lesser
identity for a vertical comparison is explicitly not the privileged one. The resolvers are
exported so a test can reach them, for the same reason `asActor` already was.

The engine refuses the comparison itself rather than trusting its caller. `checkBola`,
`checkVerticalEscalation` and `checkReadOnlyWrite` all establish that they have two distinct
identities first, and say how they know: the same object, the same label, the same session
cookie, or identical authentication headers. Label alone is not enough — a caller may hand the
same credential under two names. A refused comparison issues no request, which a test asserts
by giving it a scanner that throws.

**Verified on the live application.** Before: five occurrences of "administrator and
administrator". After: none, and the comparison reads "administrator and operations" — two
identities, so the check can now fail.

**A test's failure message is the bug in one line.** Reverting `owner` to position with the
test in place prints:

```
expected 'administrator' not to be 'administrator'
```

---

## 64. The check that finds an IDOR had never run

**Symptom.** `authz.bola` reported *"No resource belonging to the owning identity was supplied,
so there is nothing for another identity to try to read"* on every target of every run. FP_D12,
a planted IDOR, sat untested.

**Diagnosis.** The check is honest and the message is correct: it needs to know which record is
the owner's, and nothing ever told it. Every scan driver in this project declares identities as
label, username, password and role, because that is what signing in needs. `resourceId` is in
the type and no caller sets it.

**Fix.** The product already knows a record the identity can see. Discovery walks the
application *signed in*, so every address it recorded is one that identity reached and was
shown. `identifierFromSample` reads the concrete identifier off the sample URL the surface
already carries, and the bola runner uses it when no resource was declared.

A declared `resourceId` still wins: a caller who knows which record belongs to whom is a better
authority than a crawl.

**And the first version of this fix manufactured a false positive.** Measured against the live
application with two real identities, it reported:

```
CWE-639 | readonly can read a resource owned by ops.lead
```

The application is right and the finding was wrong. `/api/shipments/{id}` has no ownership
check because shipments do not belong to users, `role-viewer` holds `shipment:read` by design,
and a read-only auditor reading a shipment is the feature. **The control group is what caught
it: the finding persisted with the planted defect switched off.** Had I checked only that the
defect was now found, this would have shipped — a scanner reporting an IDOR on every record two
roles may legitimately share, which is worse than one that reports none.

The mistake was treating two halves of a premise as one. BOLA needs a record that one identity
may see *and another must not*, and an address the crawl reached establishes only the first
half. The vertical-escalation check already had this written down — *"Both roles reached it.
That is only a defect if the route was meant to be restricted, and nothing observed here says
it was"* — and I did not carry it across.

So a derived resource now carries `resourceOwnership: 'assumed'` and cannot found a finding. It
can still establish a **pass**, which is what the derivation is for: an endpoint that refuses
the second identity is access control working, and that verdict was previously unreachable.
When both read the record, the check says what is actually missing:

> Not evaluated: ops.lead and readonly both read shp-0001, and nothing establishes that it was
> private to the first. Its identifier was taken from an address discovery reached, which shows
> the record is visible to that identity and says nothing about whether the other was meant to
> see it — and a record two roles may both read is the ordinary case. Name a resource one
> identity owns, or map the application again as each identity and compare what each is shown.

That is more useful than the sentence it replaces, because the identifier is no longer what is
missing. **FP_D12 is therefore not claimed as found**, and the claim earlier in this session
that it was is withdrawn.

The matching is per path segment rather than by regex over the whole string, because the
failure that matters here is a *wrong* identifier, not a missing one — a check pointed at the
wrong record produces a finding or a clean result that means nothing. A sample that does not
line up with the template segment for segment yields nothing, as do a template with two
placeholders, a sample that is itself still a template, and a literal segment that disagrees.

---

## 65. The oracle that names a defect in its own error message could not report it

**Symptom.** FP_D10 — a listing whose count is computed before the filter is applied — was
missed. The product generates 5,709 tests named *"counts the rows it shows"*, one ran on
`/shipments`, and it passed.

**Diagnosis.** It passed correctly. The unfiltered page shows 25 rows of 40 and states 40,
which is what a pager is for. The defect only shows once a filter has removed rows, and
nothing ever filtered. The test opens the page and asserts.

So the first fault is that the one arrangement where the defect is visible was never visited —
while the oracle's own error message describes it exactly:

> A count and a list that disagree mean one of them is built from the wrong collection; the
> usual cause is **counting before filtering, which leaves the heading and the pager
> advertising rows the filter has already removed.**

**And pointing it at a filtered page was not enough.** Measured, with a browser, against the
live application: `/shipments?status=delivered` (4 rows, states 40) and
`/shipments?q=zzzznomatch` (0 rows, states 40) both passed. Two guards, each written against
a real false positive, between them made the oracle blind to its own subject.

```ts
const shown = snapshot.largestTableRows;
if (shown === 0) return found;        // ← discards the most informative case there is
...
if (snapshot.hasPagination) continue; // ← and freight's listing always renders a pager
```

The first was reaching for "this page has no table, so there is nothing to count" and was
written as "no rows", which also silences a filter that matched nothing — a result set with
nothing in it, beside a heading still advertising the whole population. The second is sound
for a bare claim on a paginated page, where the other rows are legitimately elsewhere, and it
applies to every page in this application.

**A third thing had to be true and wasn't.** Many applications, this one included, render an
empty state *instead of* an empty table:

```html
<div class="empty" data-testid="shipments-empty">No shipments match zzzznomatch.</div>
```

So "no table" and "not a listing" are not the same thing, and a page reading *"No shipments
match"* beside a heading advertising forty of them looked exactly like a page that was never a
listing at all. Recognising the empty state is what finally made the case judgeable.

**Fix.**

The snapshot now carries `hasTable`, `hasEmptyState` and `pagesClaimed`. Nothing is counted
only where the page is not a listing at all. Two new rules cover the empty case, and neither
needs to know the page size:

- A positive count stated beside an empty table or empty state. Pagination does not excuse it:
  no pager, however many pages it offers, makes the first page of a non-empty result set empty.
- A pager claiming more than one page while the first is empty. That is the page asserting its
  result set does not fit on one page, contradicted by what it rendered, on its own evidence.

And a new test, `count-matches-filtered`, navigates to the listing with its search parameter
set to a value no data contains — fixed rather than random, so a failure reproduces by pasting
the URL — and then asserts. Where discovery recorded no such field, it records a coverage gap
instead of a test, because a parameter the application ignores produces an unfiltered page and
a pass that establishes nothing.

**Measured on the live application, both ways.**

```
defect ON   /shipments                    PASS   (25 of 40 with a pager: correct)
            /shipments?status=delivered   PASS   (needs the page size; see below)
            /shipments?q=zzzznomatch      FAIL   "page 1 of 2" — the pager says there are 2
                                                 pages, so the first one cannot be empty,
                                                 but 0 row(s) are shown
defect OFF  all three                     PASS
```

**What this still cannot do**, stated rather than left to be discovered: the four-row case.
`?status=delivered` shows 4 rows under a pager claiming two pages, which is wrong, and proving
it needs the page size — knowable only by comparing against another page or by following the
pager to an empty page 2. The oracle judges one page at a time and says nothing here rather
than guessing. The zero-match filter is the probe that works without that knowledge, which is
why the test uses it.

---

## 66. The duplicate-submission test counted requests the browser sent, not orders the server placed

**Symptom.** FP_D16 — submitting the booking form twice creates two consignments — was missed.
The product generates 648 tests named *"sends one submission when the submit control is pressed
twice quickly"*, one ran on the booking form, and it passed.

**Diagnosis.** The assertion is on the wire, not on the application:

```csharp
var requests = JsonSerializer.Serialize(new { method, urlContains = path, maxCount = 1, countUnrefusedOnly = true });
...
new(BrowserActionType.AssertRequests, $"Confirm at most one {method} was sent", Value: requests)
```

Press submit twice, 120 ms apart, and assert at most one submission reached the server. When
the page's own script disables the button after the first press, one request goes out,
`maxCount: 1` is satisfied, and the test passes — having established that *this browser*
would not send the second. The handler, which is the only place the guard can do any good,
was never asked the question.

**The product's own test lab proves the distinction**, and had it the wrong way round. The
form-lab `/checkout` form is described as *"Order form whose submit control disables itself,
so a double click places one order"*, and its guard is:

```js
guarded.addEventListener('submit', () => {
  const button = guarded.querySelector('button[type=submit]');
  setTimeout(() => { button.disabled = true; ... });
});
```

That is all of it. Asked directly, with one token and one cookie — which is exactly what two
presses send — the endpoint places an order every time:

```
POST /checkout → 303  location: /checkout/done?ref=CHE-0003
POST /checkout → 303  location: /checkout/done?ref=CHE-0004
```

Two orders. The oracle test asserting a pass there was asserting a fact about Chromium.

**Fix.** A request expectation can now state how many requests the test was *trying* to
cause, separately from how many it will allow. The two are different questions, and the
duplicate-submission test needs both: it allows one submission to succeed and needs two to
arrive, because judging what a handler does with a second submission requires a second
submission to reach it.

Fewer than that and the premise did not hold, so it reports inconclusive with the reason —
*"the page prevented the rest in the browser, which is worth having and is not the same thing:
anything that is not this browser can still send them"* — rather than a pass.

Counted before the `countUnrefusedOnly` filter, deliberately. A second submission the server
*refused* is still a second submission that reached it, and that is the application working.

**What this changes in practice.** Three outcomes where there were two:

| what happened | before | after |
| --- | --- | --- |
| two reached the server, one record | pass | pass |
| two reached the server, two records | fail | fail |
| the page stopped the second | **pass** | **inconclusive** |

Only the third row moved, and it is the row that was lying. The test on freight's booking form
is in that row, which is why FP_D16 was missed: not a wrong answer, an answer to a question
nobody asked.

**Not claimed.** FP_D16 itself is not confirmed by this. Two attempts to exercise it through
the booking wizard were contaminated — the first by the draft being cleared after a confirm,
so a second sequential confirm creates an *empty* consignment rather than a duplicate, and the
second by seeded records matching the probe's own identifying fields. Both were withdrawn
rather than written up. What is established is read from the product's source and from
form-lab's endpoint: the oracle asserts the wrong thing, and the shape of application it
passes on is one that books twice.

**A fixture fault found on the way**, recorded because it is mine: the freight booking handler
does not re-validate at its confirm step, so a POST with no draft behind it creates a
consignment with no customer, no pieces and no weight. Several such records exist in the lab's
state from earlier runs.

---

## 67. The new personal-data check, measured end to end, and what the same run did not establish

**What the scan found.** `passive.pii-in-url`, added as defect 60, now runs as part of an
ordinary freight scan: 32 of 32 implied checks, up from 31, with 25 executed over 1,736
requests. It reports:

```
[critical] A form on /customers submits contactEmail by GET
    category PersonalDataInUrl   /customers
    CWE-598 · A01:2021
```

FP_D32, found by the product's own scan rather than by a harness calling the check directly.
The cookie finding from defect 62 appears in the same run, twice — *"Session cookie
`lab_session` is missing HttpOnly when `remember` is enabled"* — so both fixes hold in place.

**What the same run did not establish, and why.** `authz.bola` ran on one target,
`/api/view?path={v}`, whose identifier sits in a query parameter rather than a path segment, so
nothing could be derived for it. `/api/shipments/{id}` — the one FP_D12 needs — was not in the
surface at all. The crawl recorded **two** API endpoints for this application, because
discovery finished `partiallyCompleted` at 69 pages against the 185 a full map reaches.

**Correction.** This paragraph first called that the breadth-against-depth trade recorded
elsewhere in this document. It was not, and the run said so in its own words. See defect 71:
the crawl stopped on a 400-action budget this scan driver never set, at 69 of the 180 pages it
asked for, in 434 of the 1500 seconds it allowed. The ceiling was a default in the harness, not
a property of crawling.

**A discovery fault found while looking.** The endpoint templates include these:

```
/api/shipments/shp-0001/{id}   sample: /api/shipments/shp-0001/BOOKED
/api/shipments/shp-0002/{id}   sample: /api/shipments/shp-0002/BOOKED
/api/shipments/shp-0003/{id}   sample: /api/shipments/shp-0003/BOOKED
```

The application has one route here, `/api/shipments/:id`. The parameteriser kept the record
identifier as a literal and turned the status value into the parameter — backwards, and it
names the result `{id}`. One template per record follows, so the surface fills with
near-duplicates of an endpoint that does not exist, while the real one is a separate row that a
shorter crawl may miss entirely. Not yet fixed: recorded here with the evidence, because the
next thing to do about FP_D12 is this rather than another scan.

---

## 68. A guess the application refused was recorded as an endpoint

**Symptom.** Twelve rows on freight's attack surface for a route that does not exist:

```
/api/shipments/shp-0001/{id}   sample: /api/shipments/shp-0001/BOOKED   404
/api/shipments/shp-0002/{id}   sample: /api/shipments/shp-0002/BOOKED   404
/api/shipments/shp-0003/{id}   sample: /api/shipments/shp-0003/BOOKED   404
```

The application has one route here, `/api/shipments/:id`. Every one of those answered 404.

**Diagnosis.** Reading identifiers out of a collection and appending them is how the crawler
puts instance endpoints on the surface, and it is a good idea: REST's shape is a convention, so
the guess is tested with a GET rather than assumed. The handling of the answer was wrong.

"BOOKED" is not a record identifier. It is the `code` of the first entry in a shipment's
`events` array, and `identifiersIn` reads a nested array as a collection and `code` as its
record identifier. Reproduced exactly, on the live application's own response:

```
identifiers harvested from one shipment record: [ 'BOOKED' ]
```

So the crawler asked for `/api/shipments/shp-0001/BOOKED`, the application said 404 — and it
was recorded as an endpoint anyway, because the 404 body is JSON and the recording happens
before the status is looked at. The comment above it is right about the case it was written
for and was carrying more than it should:

> The endpoint, whatever it answered: an API that 403s is still an API, and the surface wants
> to know it is there.

A 403 on an invented URL means the route is there and refused, which the surface does want. A
404 means it was never there.

**Why it costs more than tidiness.** The templates are named `{id}`, so they read as record
endpoints to anyone and anything selecting by shape. One is produced per record, so the surface
fills with near-duplicates of a route that does not exist — and under a page or time cap those
displace real ones. `/api/shipments/{id}`, the single row an object-level authorization check
needs, is one entry among them that a short crawl can miss entirely. It did: the scan in defect
67 recorded two API endpoints for freight and that was not one of them.

**Fix.** A URL the crawler built itself — `instanceId` is set only for those — that answers 404
is not recorded as an endpoint. The note says so, because a hypothesis that failed is still
information. A 404 on a URL the *application* linked to is a dead link, which is a different
report and still reaches the notes.

The harvesting is left alone deliberately. Teaching `identifiersIn` that a record's nested
array is not a collection of that record's own instances would be a second change with its own
regression surface across four other targets, and it is not needed: the hypothesis is tested,
and testing it is what makes the answer available. The 404 gate is right whatever gets
harvested.

**The test was wrong before it was right.** The first version passed with the fix disabled —
worthless. Its fixture served records of `{ id, status, reference }`, and nothing in that shape
produces the fabrication. Rebuilt faithfully, with the nested `events` array carrying a `code`,
it fails with the gate removed:

```
× no endpoint is recorded for a route the application answered 404 for  → expected [ …(2) ] to deeply equal []
× no template is built below a record, where there is no route          → expected [ …(2) ] to deeply equal []
```

and passes with it restored. It drives the real crawler in a real browser against a real
server, so the mechanism under test is the one that ran against freight.

**Not claimed:** that freight's surface is now clean. That needs another full crawl, which is
eighteen minutes and has not been run since the fix. What is established is the mechanism, in
the crawler, with a test that fails without it.

---

## 69. A whole class of rule the engine was silent about

**Symptom.** FP_D04 — two invoices carrying the same reference — was missed, and the
measurement could not even score it. There is no uniqueness test anywhere in the product: a
search for one found 25 test names containing "duplicate", every one of them a form accepting
the literal string *"Duplicate invoice"* as a **Reason**.

**The defect is real and observable.** Measured both ways on the live application:

```
defect on    submit 1: "Invoice MF-U-9560 raised."    submit 2: "Invoice MF-U-9560 raised."
defect off   submit 1: "Invoice MF-U-16963 raised."   submit 2: "Invoice MF-U-16963 already exists."
```

Two submissions of one form, and the application's own words distinguish the cases. The engine
could perform that and does not.

**Why it is not simply asserted.** Because the engine cannot know the rule exists.

Freight's Reference field declares nothing about uniqueness. Its only hint is *"Leave blank to
generate one."* And a field named `reference` is as often a counterparty's own purchase-order
number — which several records legitimately share — as it is a key. Asserting uniqueness would
fail every application that allows duplicates by design.

That is the same mistake as defect 64: half a premise held as if it were the whole one. There,
a record the crawl reached was treated as a record the crawl's identity *owned*, and a shared
record became a reported leak; a control group caught it. The lesson transfers directly, and
this is the first place it was available to apply.

**Fix.** The engine stops being silent without pretending to a verdict. For a field whose name
says it holds a record's own reference, on a form that creates something, it records a coverage
gap marked `HumanRequired` and a human task with the steps written out:

> Open the form. Submit it with a Reference of your choosing, then submit it again with the same
> Reference and everything else valid.
>
> If Reference is meant to be unique, the second submission is refused and says so. If it is
> not, both are accepted and that is correct — say so, and this stops being asked.

Both answers are named, so the question can be closed rather than accumulating.

The name list is short and excludes the near misses on purpose: `name` is a person's or a
product's, `number` alone is a quantity as often as an identifier, and `email` is unique on an
account form and shared on a contact form. Across all of freight it matches nine fields, so the
answer sheet stays shorter than the report. A test asserts that an ordinary form — name,
contactEmail, pieces — raises nothing, and that a GET filter form raises nothing either,
because it creates no records to collide.

**What this does and does not change.** FP_D04 is still not found by the automated engine, and
is not claimed to be. What changed is that the gap is now named, with the steps to close it, in
the place a reader looks — and a stated requirement turns it into an automated test through the
requirement path, which is the right instrument for a rule somebody has written down.

---

## 70. The check that would have caught it could not be pointed at the wizard

**Symptom.** FP_D15 — stepping back from step 3 of the booking wizard empties step 2 — was
missed. Unlike most of these, the product already has exactly the right check.

`RetainsAnswersGoingBack` fills through a step, presses back, and asserts with `AssertValue`
that every field still holds what was entered. That is FP_D15's question, word for word. It
produced no test for freight's booking wizard, and neither did anything else in the multi-step
family.

**Diagnosis.** Two gates, both missed, both silently.

```csharp
if (!_form.IsMultiStep) return;
...
if (_previous is null) return;
```

`IsMultiStep` means one form whose fields are in groups — a wizard the *browser* runs. Freight's
is a wizard the *server* runs: one page per step at `?step=1`, `?step=2`, each with its own
`<form>`, and the control back to the previous step is an `<a href="…?step=1&back=1">Back</a>`
rather than a Previous button. So the form is not multi-step by that definition, there is no
previous button, and `MultiStep()` returned without a word.

Both shapes are ordinary. The server-rendered one is what checkouts, applications and
onboarding flows have looked like for twenty years.

**The defect is real and the oracle is right.** Measured by following freight's own Back link:

```
defect on    step 2 after Back: pieces "",  weight "",    declaredValue ""
defect off   step 2 after Back: pieces 9,   weight 777,   declaredValue 4242
```

**Fix.** The gap is named rather than guessed at. A form on a page whose address carries a
numeric step — `step`, `stage`, `phase`, `wizardstep`, `currentstep` — now records a coverage
gap saying that this is one step of a wizard spread across addresses, that nothing here fills a
step and checks what survives going back, and that a recorded journey is the instrument that
carries state across addresses.

`page=2` is excluded deliberately: that is a listing showing its second page, not a flow on its
second step, and without the distinction every paginated form in an application would carry a
gap about wizards. A test holds that line.

**Not fixed: reaching the wizard.** Modelling a flow across four addresses is a journey, not a
form, and building that is a feature rather than a correction — the product has a journey
recorder, which is where it belongs. What changed is that the engine no longer passes over the
shape in silence, and the reader is told which instrument to use.

---

## 71. The harness could not pass on the one budget that was binding

**Symptom.** Every freight security scan reached 69 pages and stopped. I attributed it, three
times in writing, to the breadth-against-depth trade recorded elsewhere here, and used it to
explain why `/api/shipments/{id}` was missing from the surface and why FP_D12 could not be
verified.

That was wrong, and the run had said so all along:

```
Stopped: the 400-action budget was reached.
```

**Diagnosis.** A crawl stops on whichever of four limits it meets first: pages, depth, time, or
actions. The numbers from the run's own record:

| budget | asked for | used |
| --- | --- | --- |
| pages | 180 | 69 |
| time | 1500s | 434s |
| actions | **400 (never set)** | **400** |

Nothing was blocked by policy. The scan driver set three budgets generously and left the fourth
at the application's default, and a crawl of this application spends roughly six actions a page
— so 400 actions is about 69 pages however high the other three are set.

**And the harness could not have set it.** `runDiscovery`, which every driver in the
verification suite uses, took `maxPages`, `maxDepth` and a timeout, and built its request body
from those three:

```js
const body = { applicationId, maxPages, maxDepth };
if (crawlSeconds !== undefined) body.timeoutSeconds = crawlSeconds;
```

The platform was configurable and honest the whole time. `StartDiscoveryRequest` accepts
`MaxActions` and clamps it to 1–100,000; `DiscoveryRunDetail` carries it with a comment saying
exactly why — *"MaxActions is here because a crawl that stops on its action budget cannot
otherwise be explained from its own record"*. Somebody had already thought this through. The
helper in front of it dropped the setting, so no caller could reach it.

**Fix.** `runDiscovery` forwards `maxActions` when asked. The freight scan driver sets it, and
now prints whichever budget stopped the crawl, in the run's own words, instead of leaving the
reader to infer it from a page count:

```js
const stoppedBecause = String(discovery.progressLog ?? '')
  .split('\n').filter(note => /^Stopped: /.test(note.trim()));
```

**The lesson is about me, not the code.** The product reported the cause accurately, in a
sentence naming the exact number. I read "partiallyCompleted, 69 page(s)" beside a cap of 180
and inferred the cap was the limit — the one explanation the numbers ruled out. Three write-ups
carried that inference as though it were a finding, and the corrections are made in place rather
than edited away.

It is also the second time in this session that the fix for a "fundamental limit" turned out to
be a default nobody had set. The first was `authz.bola`, which had never run because no driver
supplied a resource identifier.

---

## 72. FP_D24: the defect hides itself from the model that would find it

**Established, not fixed.** Recorded because the reason is exact and worth stating rather than
leaving as one more "missed".

**The defect, from the live page.** `/orders/sales/so-0002`, the approval dialog:

```html
defect on    <div class="modal" id="approve-modal" data-testid="approve-modal" hidden>
defect off   <div class="modal" id="approve-modal" data-testid="approve-modal"
                  role="dialog" aria-modal="true" aria-label="Approve this order" hidden>
```

No `role`, no `aria-modal`, no accessible name. A screen-reader user is never told it opened.

**Why nothing finds it.** Discovery classifies an element as a dialog from the `<dialog>` tag
or a `role` attribute:

```ts
if (tag === 'dialog') return 'dialog';
...
if (element.getAttribute('role') === 'alert') return 'alert';
```

The faulty version is a bare `<div>`, so it enters the element model as nothing at all. **The
omission that is the defect is the same omission that hides it from the model.** A check over
the element model cannot find a dialog that never became one, however the check is written.

Axe does not help either: a hidden `div` with no role carries no violation. There is nothing
wrong with the markup *as markup* — it is wrong as a dialog, and only behaviour says it is one.

**What would find it, and why it is not built here.** The dialog has to be recognised by what
it does rather than what it says: a control opens it, it covers the page, it holds a form and a
dismiss control, and only then is its lack of `role="dialog"` a finding. That is a behavioural
model of an overlay, and it needs interaction — the same class of work as reaching a wizard
spread across addresses in defect 70.

A markup-only heuristic is available — a hidden container holding a form and a button whose
only text is ✕ — and it is not being added at the end of this session on this much evidence.
Extending a premise past what the evidence supports is how the BOLA false positive in defect 64
was nearly shipped, and a new accessibility heuristic firing on every collapsed panel in an
application would cost more than this finding is worth.

So FP_D24 stays missed, with its cause named: not a check that asked the wrong question, but an
element model that cannot hold the subject.

---

## 73. A complete crawl of a server-rendered application reports a near-empty API

**Symptom.** With the action budget finally set (defect 71), freight's discovery **completed** —
not partially — mapping **164 pages and 221 targets**. It found **two API endpoints**.

The application has a JSON API. One of the addresses missing from those two was
`/api/shipments/{id}`, which is the only kind of address an object-level authorization check
can be pointed at, so `authz.bola` again had nothing to run on.

**Diagnosis.** A crawl follows what the pages link to. An application rendered on the server
does not link to its own API, and its pages fetch little or nothing, so the API surface a crawl
sees is whatever happened to be fetched — not what the application serves. Freight renders on
the server, so its two endpoints are the two its pages touched.

Nothing about that is a bug in the crawl. The problem is what it reads like. "Discovery
completed, 164 page(s), 221 target(s)" invites the conclusion that the surface is whole, and as
a map of what was walked it *is* whole. The scan's standing caveat — *"it describes what
discovery walked rather than the application"* — is true and too general to act on. I read
both and still spent the afternoon looking for the endpoint in the wrong place.

**Fix, in two parts.**

The crawl now says so when its own numbers show it. A page-heavy crawl that found almost no API
notes that a crawl follows what the pages link to, that an application rendered on the server
does not link to its own API, and that seeding the API's collection addresses is what maps the
rest — because the instance addresses are built from the identifiers a collection names.

The rule is a pure function so both answers can be tested, and the threshold is asserted in
both directions: `(164, 2)` and `(137, 0)` say yes, `(40, 12)` and `(164, 30)` say no — a
client-rendered application's pages fetch, so its API arrives as traffic — and `(19, 0)` says
no, because under twenty pages almost anything looks API-poor and the note would be noise.

And the freight scan driver seeds `/api/shipments`. That is not a workaround: it is the
configuration a server-rendered application needs, and the product has had the setting all
along. The driver also now fails loudly if its configuration PATCH is refused, rather than
running on and looking configured.

**The pattern worth naming.** Three times today the ceiling was a setting: the action budget
the harness could not pass on, the resource identifier no driver supplied, and now the seed
addresses nobody set. In each case the product was configurable and said what it had done, and
the thing in front of it either could not pass the setting through or never set it. A product
this careful about its own honesty deserves drivers that read what it says.

---

## 74. Seven high-severity findings calling a finance team's job an administrative breach

**Symptom.** With the action budget set, r8's larger surface produced seven findings the
previous runs had not:

```
high | operations reaches /billing/payments, which names itself administrative
high | operations reaches /billing/credit-notes/new, which names itself administrative
high | operations reaches /billing/surcharges, which names itself administrative
high | operations reaches /billing/invoices/new, which names itself administrative
high | operations reaches /reports/builder, which names itself administrative
high | operations reaches /reports/export, which names itself administrative
high | operations reaches /reports/scheduled, which names itself administrative
```

CWE-285, Improper Authorization, high severity, seven of them. All seven wrong.

**Diagnosis.** `authz.vertical` reports a finding when two roles both reach a route *and* the
route's own name says it was meant to be restricted. That second condition is a word list, and
the list contained `billing`, `invoices` and `reports`.

Those are not administrative. They name what a finance team does all day. Any application with
a billing or reporting area produces one of these for every route in it that two roles can
both reach — seven on freight, and hundreds on a real finance system.

Confirmed against the application: `ops.lead` receives 200 from `/billing/payments`,
`/billing/invoices/new` and `/reports/builder`. The write actions are guarded —
`/billing/invoices/new` checks `invoice:write` on its handler — so what the scan found was a
finance *page* being readable, which is the application working.

**Why it appeared now.** It was always there and could never fire. Until defect 63, the check
resolved both of its identities by position and compared the administrator with himself, so it
reported inconclusive and never reached the line that consults this list. The identity fix was
right, and what it exposed was this.

**Why this is the costliest kind of wrong.** Not because seven is many. Because a reader who
checks two of them, finds the application behaving correctly, and stops reading has been taught
that this report is noise — and the report also contains a real reflected XSS, a real
GET-that-settles, and real missing-HttpOnly findings. A scanner's credibility is spent per false
finding and is what every true one is cashed against.

**Fix.** The three business domains are out. The list now holds only words that name the
administration of the application itself: `admin`, `administration`, `superuser`, `root`,
`manage`, `console`, `backoffice`, `internal`, `users`, `roles`, `permissions`, `members`,
`staff`, `settings`, `config`, `system`, `audit`, `logs`.

Tested in both directions, which is what makes it a rule rather than a patch: the seven freight
routes and `/invoices/5003`, `/shipments`, `/customers`, `/claims/new` are not administrative;
`/admin/users`, `/admin/api-keys`, `/administration/roles`, `/settings/permissions`,
`/system/config`, `/back-office/staff`, `/internal/console` and `/admin/audit` still are. The
test was checked for sensitivity by putting `billing` back, and it failed with
*"/billing/payments is not an administrative route"*.

**Left standing, and named rather than guessed at:** `accounts`. In an administrative console it
means user accounts; in a bank it is the entire business. This project's own demo bank is where
that evidence would come from, and settling it is a measurement rather than a judgement to make
from here.

---

## 75. The largest finding family is wrong against the commonest architecture

**Established, not fixed.** Found while checking a number before quoting it, and it is the
most serious open item in this document.

**Symptom.** Scan r9 reported 283 findings. **108 of them — 38% — are one family:**

```
A state-changing request succeeds with no anti-CSRF token   ×54
A state-changing request is accepted from any origin        ×54
```

Fifty-four endpoints, two checks each. Freight carries an anti-forgery token on its forms and
enforces it.

**Diagnosis.** Asked directly:

```
POST /claims/new   (no token)   →  302   location: /claims/new
```

Redirected **back to the form it came from**, and no claim was created. That is how a
server-rendered application refuses: re-show the form, with a flash. Freight's handler does
exactly that — *"That form expired."*

The check's criterion, from its own source:

```js
if (withToken.status >= 400)   { /* inconclusive: refused even with a token */ }
if (withoutToken.status >= 400) { /* ok: refused without one */ }
// otherwise: "The request succeeded with a token and succeeded identically without one"
```

A 302 is under 400, so both requests "succeeded" and the finding is raised. **Every
server-rendered application that refuses by redirect-and-reshow produces one of these per
protected form** — the dominant idiom on the web. Fifty-four on this application; hundreds on
a real one.

**The product already knows how to judge this.** Its form engine says, in so many words:

> POST … accepted the submission: it answered 302 and redirected to /x with nothing that reads
> as a rejection.

Where it redirected, and whether a rejection is visible. The security check was left behind —
the same shape as the cookie check being left behind by sensitive-data in defect 62, and the
third time in this session that one half of the product knew something the other half did not.

**Why this one outranks everything else open.** Not the count. A scanner's credibility is spent
per false finding and every true one is cashed against it, and this family is 38% of the report.
A reader who checks two, finds the application correct, and stops reading will never reach the
reflected XSS, the GET-that-settles, the missing `HttpOnly` or the unauthenticated shipment API
— all of which are in the same file and all of which are real.

**Fix.** A shared `stateChangeAccepted(response, path)`, used by both checks, judging where the
answer went rather than only its number:

| answer | verdict |
| --- | --- |
| 4xx, 5xx | refused |
| 3xx back to the address posted to | **refused** — the form being shown again |
| 3xx to a sign-in | refused |
| 3xx to an error page | refused — "onward" alone is not acceptance |
| 3xx onward to somewhere else | accepted — a saved form redirects to what it saved |
| 3xx with no `Location` | refused; a redirect to nowhere settles nothing |
| 2xx | accepted |

Host and query are ignored when comparing paths, so `http://app.test/claims/new?error=1` is
recognised as the same address.

The error-page rule was added on a second reading of my own fix: an application that answers a
rejected write with `302 -> /error` redirects *onward*, so the first version called it
acceptance — the same confusion as the redirect-back case, one step along. It takes two patterns
rather than one, because the boundaries differ and merging them breaks real records: a word may
follow a hyphen, so `/access-denied` is an error page, but a status code may not, because
`/claims/clm-403` is a claim and reading it as an error page would turn a real finding into
silence. Both directions are tested, including `/customers/errorsmith` and `/reports/terrordome`
staying acceptances.

**Measured against the live application.** The two endpoints that were false findings:

```
/claims/new      inconclusive — it redirected back to /claims/new, which is how a form is shown
                 again after a refusal
/customers/new   inconclusive — the same
```

Eleven tests, and the four that matter were checked for sensitivity by disabling the
redirect-back rule: they fail, naming the exact case.

**What this does not yet do, stated rather than left to be found.** The check now reaches no
verdict at all on a form endpoint, because its probe does not look like the application's own
request: it sends JSON with the token in a header and an empty body, so a handler wanting a
urlencoded body with fields in it refuses — and refuses for the right reason. On freight that
includes `/warehouse/stock/{id}/adjust`, which genuinely has no token. Nothing is lost by it:
FP_D29 is found by the form engine checking the token field's presence, which is how it was
found before.

Turning those inconclusives into verdicts needs the control request shaped from what discovery
recorded — the endpoint's declared content type and a sample body. `SecurityTarget` carries
neither today, so that is a change across shared types, the surface builder and the worker, and
it is the next thing this check needs rather than something to guess at here.

**The trade is the right way round.** 108 confident false findings became 54 honest "not
evaluated"s with the reason attached. A reader can act on the second and was being trained by
the first to ignore the report.

---

## 76. The BOLA fix cost a real detection, and the measurement caught it

**What happened.** Re-measuring the three small targets after the day's changes — which is why
the re-measurement was worth doing — clinic-spa came in at 2 of 4 in navigation mode, with
CS_D03 surfacing as a *gap* rather than a finding. CS_D03 is *"a clinician can read a patient
record belonging to another clinician"*: a BOLA case, and BOLA was changed today.

**Diagnosis, and it is mine.** Defect 64 stopped a *derived* resource from founding a BOLA
finding, because on freight that produced a false positive — a read-only auditor reading a
shipment, which is the application working. On clinic-spa the same mechanism was producing a
**true** positive, because a patient record genuinely is private to one clinician.

So the fix traded a true detection on one target for removing a false one on another. Both
halves were real; the design was underdetermined. `clinic-spa/target.json` declared three
identities and no `resourceId` on any of them, so ownership was never stated and the check had
to guess — and guessing is what produced both outcomes.

**Fix: supply what the check asks for.** It had been asking all along, in the sentence defect 64
added — *"Name a resource one identity owns, or map the application again as each identity."*
`dr.okafor` is clinician `cl-1` and `pat-1` belongs to `cl-1`, so the target now declares it.

**Measured against the live application, both ways:**

```
declared  (target.json says pat-1 is okafor's)   CWE-639 | dr.nilsen can read a resource owned by dr.okafor
assumed   (what a crawl-derived id gets)         0 findings, inconclusive — "nothing establishes
                                                 that it was private to the first"
```

Which is the whole design working: the finding is founded where ownership is known, withheld
where it is guessed, and freight — which declares nothing — stays correctly silent.

**Why this is the argument for re-measuring after a change.** The BOLA fix was right, tested in
both directions, and verified against the application that motivated it. It still cost a
detection on a target I was not looking at, and nothing in the unit tests could have told me,
because the loss was in configuration rather than code. A green suite is not a measurement.

**One concern checked and dropped**: the uniqueness questions from defect 69 looked likely to be
noisy — 24 human tasks on a three-form application. None of the 24 come from that change;
clinic-spa has no reference-shaped field, which is what the short name list is for.

---

## 77. Two checks blamed the application for their own missing premise

**What the reader saw.** On permits-legacy and token-api, `request.csrf` and `request.origin`
each reported:

> An authenticated session is needed to send a cross-site request.

Which reads as the scan having failed to sign in. It had not. It was holding that identity's
headers at the time, and `authz.readonly` on the same target ran as the same identity and
reported a status code back from it — *"clerk could not write either (400)"*. A reader
reaching the first sentence concludes the product could not authenticate against the target,
and stops trusting the rest of the file.

**What was actually true, and is a better answer.** Both checks guard on the identity having
a *cookie*, and that guard is right. A browser attaches a cookie to a cross-site request by
itself, which is the entire mechanism forgery depends on. It never attaches an Authorization
header, because only the application's own code sets one. permits-legacy authenticates with
HTTP Basic and token-api with a bearer token, so **neither is exposed to this at all** — and
that is a property of the application worth stating, not a gap in the scan worth apologising
for.

**Fixed** by naming the scheme, read off the headers the scan is holding rather than off the
target's configuration, so the sentence stays true to what happened:

> Not evaluated: clerk authenticates with HTTP Basic credentials and the application set no
> session cookie. A browser attaches a cookie to a cross-site request on its own, which is
> what makes forgery possible; it does not attach HTTP Basic credentials, which only the
> application's own code sets. So there is no cross-site request here for an anti-forgery
> token to defend. That is a property of how this application authenticates, not a gap in the
> scan.

The verdict is unchanged — still `inconclusive`, because nothing was established about an
anti-forgery control. Only the reason changed, and the reason was the part that was wrong.

**A note on where the bar is.** `request.safe-verb-state-change`, written in this same area,
already explained itself this way: *"an anonymous GET that is refused says nothing about
whether a safe verb changes state for someone who is signed in."* Two checks in the same file
answered to two different standards. Eight tests now cover the scheme naming, including that
no branch of it can produce a false sentence — a function that would describe a cookie as
"headers rather than a cookie" is one caller away from printing that.

**Not a fix for the thing it looks like.** permits-legacy's CSRF-shaped defect, PL_D01, is
found — by `request.safe-verb-state-change`, as *"A GET changes state, and needs no
anti-forgery token to do it — CWE-352"*. That target is 4 of 4.

---

## 78. The product could not find record routes on any client-rendered application

**The defect.** Reading record identifiers out of a collection and trying them as addresses
under it — the thing that finds `/api/shipments/{id}` when no document anywhere links to it —
ran *only* on a JSON collection the crawler had navigated to as a document.

A client-rendered application never serves one. clinic-spa's screens fetch
`/api/patients?q=` from their own JavaScript. The collection arrived on the network listener,
its body was recorded as a response sample **with `pat-1` and `pat-2` in it**, and nothing was
ever derived from it. So:

```
endpoints discovery recorded for clinic-spa
  /api/patients?q={v}      GET   200     <- the collection, with the ids in its body
  /api/appointments        GET   200
  /api/appointments/apt-1/cancel  POST 200
  ...
  /api/patients/{id}       — never reached
```

`authz.bola` therefore had no record route on which to compare two clinicians, and **CS_D03 —
a clinician reading another clinician's patient record, a critical planted authorization
defect — came back as a gap** on an application whose own traffic carried the addresses needed
to find it.

**Which is exactly the wrong way round.** Record-level routes are where object-level
authorization defects live. They are the routes no document points at. And a client-rendered
application's API is *nothing but* background fetches. The derivation was absent precisely
where it is the only thing that would work.

**Fixed** by deriving from the collections the application fetches for itself, not only the
ones the crawler opens. The same policy guard the queue applies is applied at derivation, so
an analytics or CDN host the application talks to does not get addresses invented under it.

**Why the tests for this are end to end.** `identifiersIn` and the URL building were both
correct and unit-tested throughout, and never called. No unit test could have caught this,
because nothing was wrong with any unit. The test runs a real client-rendered application —
a mount point, a `fetch` for its collection, no anchor and no record id anywhere in the
markup — in a real Chromium, and asserts the record route reaches the surface *and* that the
application's own request log shows the GET that put it there. With the derivation disabled,
those two fail and the two shape guards beside them still pass, which is the right split.

**The runner had already said which branch this was.** Its note reads: *"ground truth names 1
route(s) nothing reached: /api/patients/:id — either a gap in discovery or a fixture that does
not exercise its own route."* It was the first branch. The note is worth keeping for the next
one.

---

## 79. An API address pushed through a client-side router, and the phantom pages it made

**Found by my own fix for defect 78, in the measurement that followed it.** The derivation
worked: discovery reached `/api/patients/pat-1` and `/api/patients/pat-2`, which it never had.
The numbers around it were wrong in a way worth reading carefully:

```
before:  4 page(s)   4 form(s)   199 test(s)   6 endpoint(s)
after:   7 page(s)   7 form(s)   396 test(s)   6 endpoint(s)
```

Three pages and 197 tests appeared, and **not one new endpoint**. `/api/patients/{id}` — the
whole object of the exercise — was still missing from the surface.

**What those three pages were.** Each recorded `visible_text_excerpt` was clinic-spa's
*schedule screen*, and each carried that screen's booking form, with `http_status` null:

```
url                                        http_status  text
/api/patients/pat-1                        (null)       "Schedule Schedule Patients Patient Start End Status pat-1 ..."
/api/patients/pat-2                        (null)       same
/api/appointments/apt-1                    (null)       same
```

Duplicates of one screen, filed under three addresses that answer JSON. The form engine then
designed a full suite against each: 396 tests where 199 were real.

**Why.** The crawl log says it plainly, in a sentence the product writes about itself:

> This application signs out on a page load (its session lives in the page), so discovery
> moves through it from inside: by its links and its router, **never by loading an address**.

That is right, and it is why clinic-spa can be crawled at all. But a client-side router does
not fetch `/api/patients/pat-1` — it does not recognise it, so it renders whatever its
fallback renders, and the crawl recorded that screen under the address it had asked for. The
derived addresses were correct; the way they were retrieved could not work.

**Fixed** by retrieving them instead of routing to them. An entry carrying `apiInstanceId` is
an API address *by construction* — built from an identifier read out of a JSON collection — so
in this mode it is fetched from inside the page, which carries the in-page session that a
fresh document load would not have, and recorded as an endpoint. A 404 records nothing. A 401
or 403 is recorded, because "this route exists and refuses me" is what an authorization
comparison needs.

**The test fixtures an application of this shape rather than asserting the branch.** It keeps
its token in a JavaScript variable — no cookie, no storage — so a document load genuinely
signs it out and the crawler genuinely enters this mode. With the branch disabled all three of
its assertions fail: the endpoint is missing, the application's request log never shows the
record address, and a phantom page appears under `/api/`. That last one is the assertion worth
keeping: `expect(pages.filter(p => p.url.includes('/api/'))).toEqual([])`.

**What this cost to find: one measurement.** The unit tests for defect 78 passed, the
end-to-end test passed, the fix was right, and the first run on a real application of the
shape it was written for still produced three phantom screens and doubled the test count. A
green suite said the derivation worked. Only the run said what it derived was unreachable.

---

## 80. The same false premise in a third check, and what the measurement cost

The shell rule was applied to the anti-forgery and origin checks, and the run that followed
showed it working: both false findings on `/` were gone, `CWE-639` on `/api/patients/{id}` and
`CWE-269` on `/api/appointments/apt-1/cancel` both survived. One finding remained:

```
CWE-269 | A read-only account can perform a write | http://127.0.0.1:4600/
```

`authz.readonly` compares the answer a writing identity gets with the answer a read-only one
gets. On an address with no handler for POST both receive the application's shell, the answers
match, and the finding is true exactly as worded and says nothing. The same premise, missed
because I fixed the two checks I had been looking at rather than the class.

**Fixed** by sharing `changedNothing` with it. Its two tests are the pair that matters: the
address that answers a shell founds nothing, and clinic-spa's cancel endpoint — which is
CS_D04, a planted defect — still founds `CWE-269`.

**The scoreboard for this one rule**, measured across the runs rather than reasoned about:

| | findings | targets |
| --- | --- | --- |
| before | 28 | 19 |
| after | 20 | 12 |

Seven of those targets were the crawler's own probe traffic recorded as the application's API
surface, and three of the findings were the shell read as a state change. Nothing a planted
defect depended on moved: all four are still found.

**Worth saying plainly.** Three checks shared one false premise and I fixed them one at a
time, each time believing I was done, because each time the only thing that disagreed with me
was the next run. The lesson is not about this premise. It is that a check which reports a
finding on evidence it cannot distinguish from nothing happening is not a check, and the only
thing that reliably exposes one is pointing the product at an application and reading every
finding it produces.

---

## 81. Authorising interaction cost the detection it was meant to enable

**Found by running permits-legacy with `--destructive` for the first time.** Every earlier
permits measurement had been in navigation mode. Under authorisation it read **3 of 4**, and
the defect it lost was PL_D01 — *"Approving a permit is a GET any signed-in role may issue,
with no token and no check"* — the single most authorisation-shaped defect in the target.

**The product said why, in its own words.** `request.safe-verb-state-change` reported:

> `/approve.asp?id=1` answered 200 and `/list.asp` is unchanged, so this check saw no state
> change. It cannot conclude there was none — the request may have changed something this page
> does not show — and it will not record an untested endpoint as a safe one.

That is the check working exactly as designed, refusing to call an endpoint safe on evidence
it does not have. The evidence was missing because **the crawl had already spent it**:

```
discovery log   [01:58:15] Explored /approve.asp (6 elements)
                [01:58:16] Explored /approve.asp (6 elements)
the register    BP-2026-0001  approved     (it is seeded "submitted")
                BP-2026-0002  approved
```

Mapping approved two permits. By the time the check read the listing before and after
approving permit 1, permit 1 was already approved, so nothing changed and the check correctly
declined.

**Why the existing guard did not cover it.** `probe-order.ts` exists for this exact failure —
its comment describes "a check whose whole job is observing a change reported that it had seen
none, of a change five earlier probes against the same address had already spent." That orders
probes *within* a scan. Nothing ordered discovery against the scan that follows it.

**The fix: a link that says it changes something is never followed, authorised or not.**

The authorisation is for a *control* whose endpoint cannot be learned any other way.
clinic-spa hides its cancel button from a receptionist, and pressing it is the only way to
discover `/api/appointments/{id}/cancel` — which is how CS_D04 is found. A link is not that.
Its address is in its own href, and the crawler already records it either way; a previous fix
in this same block separated the record from the refusal, with the comment *"The fact and the
refusal are separate things."* This change completes that thought: having separated them,
there is no longer any reason to follow the link.

**The accepted cost, stated rather than hidden:** a page reachable only by following such a
link is not mapped. That is the right trade. A check that exercises the address deliberately,
reading the application either side, learns strictly more than a crawl that walks into it —
and mapping an application still must not alter it.

**Nothing in 612 worker tests asserted the old behaviour**, which is why following these links
under authorisation survived as long as it did. The new test asserts the thing the application
itself can answer — `expect([...approved]).toEqual([])` — and fails on the old behaviour.

**What this says about the two configurations.** Before this, there was no single setting under
which all three small targets reached 4 of 4: clinic-spa needs interaction authorised to find
CS_D04, and permits-legacy was broken by the same authorisation losing PL_D01. The claim "all
three are at 4 of 4" was true only by reading each in its own best configuration, which is the
kind of bookkeeping this file exists to stop.

---

## 82. The write checks sent a body no form endpoint would accept

**Found by re-measuring freight after the shell rule and the derivation landed**, which is the
run I had told the user was outstanding because "its 11-of-17 figure predates them". The
comparison showed something I had not predicted: `MissingCsrfToken` fell from 54 findings to
12 and `MissingOriginValidation` with it, and among the 42 endpoints that went quiet was
`/warehouse/stock/:id/adjust` — **FP_D29_NO_CSRF_ON_ADJUSTMENT**, a planted defect.

My first reading was that the `changedNothing` rule I had added that morning had suppressed a
true finding. It had not. The reason the run itself gave was a different one:

> `request.csrf on .../adjust: Inconclusive: Not evaluated: the endpoint did not accept the
> request even with a token and a same-site origin — it redirected back to
> /warehouse/stock/stk-fxt-sku-001/adjust, which is how a form is shown again after a
> refusal.`

That is the redirect rule from defect 75 working exactly as designed, on a request that
genuinely was refused. Before that rule, the same refusal had been read as an acceptance, and
the finding had been raised **for the wrong reason**: the scan had never performed a state
change at all, so it had no evidence about the token either way. FP_D29 had been scored found
on a verdict reached by a broken premise, and fixing the premise exposed that.

**Why the endpoint refused.** Not the content type, which is what the reason text at the time
guessed at. The checks hard-code `body: {}`:

```ts
return request.checkCsrfToken(scanner, {
  baseUrl: context.baseUrl, path: target.identifier,
  session: { cookie: a.cookie, csrf: a.csrf }, body: {}
});
```

The handler reads `delta` out of the body and refuses a value that is not a whole number. With
FP_D29 on, the token check is skipped entirely — so the request was never failing on the
token. It was failing on the field the form declares.

**The A/B, against the running application, signed in as `warehouse`:**

| what was sent | answer | meaning |
| --- | --- | --- |
| `{}` as JSON | 302 → `/…/adjust` | the form again: refused |
| `{"delta":1,"reason":"Damage"}` as JSON | 302 → `/…/stk-fxt-sku-001` | the record: **accepted**, on-hand moved |
| `delta=1&reason=Damage` urlencoded, no token anywhere | 302 → `/…/stk-fxt-sku-001` | **accepted** |

The third row is the finding. An endpoint that accepts a state-changing POST carrying no
anti-forgery token, from a request that differs from the application's own only in that one
respect. The product could not reach it because it had never sent a request the endpoint would
take.

Note what the second row rules out: freight's `ctx.body()` parses JSON perfectly well. The
content type was never the blocker. The empty body was.

**What was built.** The form already declares everything needed, and the surface already had
the fields to carry it — `RequestContentType` and `RequestSampleJson` existed on the endpoint
input and were simply never populated for a form-declared write, under a comment that said
`what they are called is the form model's business rather than this one's`. That deferral is
what this defect is.

- `FormRequestShape.Of(form)` builds the body from the discovered form model, taking values
  from `ValueSynthesizer` — the same source the form test designer fills a happy-path
  submission from. Nothing is invented here that the product does not already use to fill
  that form.
- The anti-forgery token is deliberately **left out of the body** and its field name carried
  separately. A sample carrying a token would make the probe identical to the control, and the
  check would report a missing token on an application that enforces one.
- The control request places the token in that field *and* in a header; the probe places it in
  neither. A server that reads the token from the body does not look in a header, so without
  this an endpoint that enforces its token refuses the control and the check reaches no verdict
  against an application doing the right thing.
- `encodeBody` sends a urlencoded body as a form rather than as a JSON document.
- Two selects over the same list do not take the same option — a transfer form's "From site"
  and "To site" are the same list of warehouses, and an application that refuses a transfer
  from Felixstowe to Felixstowe is right to. The form test designer already carries that rule;
  this carries it for the same reason.
- An inconclusive reason now names what was sent: the content type, the fields, and where the
  token went. A reason that does not say that cannot be acted on.

**A side effect worth naming.** The fields a form declares now reach `Parameters`, so
`api.input-validation` and the injection checks stop reporting *"No parameter was discovered on
this endpoint to probe"* on every form endpoint of a server-rendered application.

**What the suites had to say about it beforehand: nothing.** 1789 C# tests, 202 engine tests
and 612 worker tests were green with `body: {}` in three checks. The failure is silent in the
worst way — each check correctly reported that it could reach no verdict, so nothing was red,
and 37 endpoints were simply never evaluated. The new tests are 17 in C# and 17 in the engine,
and the four that pin the write verdict fail on the old code.

---

## 83. A successful write read as a refusal, and a viewer settled a £5,953 claim

**Found while writing a test for defect 82**, when a scripted scanner that should have founded
a privilege-escalation finding returned none. `checkReadOnlyWrite` judges its two arms with
`refusal()`:

```js
if (status >= 300 && status < 400) {
  ...
  return { refused: true, how: `answered ${status} with no body, so nothing was served` };
}
```

That is right for every other check in the file. `checkBola`, `checkVerticalEscalation`,
`checkMissingAuthorization` and `checkTokenVerification` all ask whether a resource was
*served*, and a 3xx means it was not. `checkReadOnlyWrite` is the only one that sends a POST,
and on a write the same signal means the opposite: an application rendered on the server saves
and then redirects to what it saved. The 302 that `refusal` reads as *nothing was served* is
the write having succeeded.

**Both directions were wrong.** A read-only account that successfully wrote was reported
clean. And an endpoint that refused *both* accounts by re-showing its form passed the
`control.status >= 400` guard with 302 and founded a privilege-escalation finding against an
endpoint that wrote nothing for anybody.

This is the same inversion as defect 75, in the authorization family, found a day later and
only because a test fixture disagreed with the code.

**The live proof, one request, as `readonly` on freight.** The claim page tells that account:

> *Settling a claim needs the claim:settle permission, which your role does not hold.*

| | `data-status` | settled |
| --- | --- | --- |
| before | `submitted` | — |
| the viewer posts `settledAmountGbp=1` → 302 → `/claims/clm-0001` | | |
| after | `settled` | £1.00 |

A £5,953.11 claim settled for £1.00 by an account the application itself says may not settle
claims. That is **FP_D11_VIEWER_CAN_SETTLE_CLAIM**, and freight's r10 scan reported zero
`PrivilegeEscalation` findings.

It needed both fixes to be reachable: without defect 82's body the endpoint refuses the
settlement for want of an amount, and without this one the successful 302 reads as a refusal.
Two independent faults in series over one planted defect, which is the argument for measuring
rather than reading.

**The fix** is one check. `stateChangeAccepted` replaces `refusal` on both write arms — the
primitive defect 75 built for exactly this question — and the finding now says what each
account's request did rather than quoting two status codes that mean the opposite of what they
appear to.

---

## 84. Forty confident findings, most of them wrong, because a refusal and a success land in the same place

**Found by distrusting my own improvement.** The run after defects 82 and 83 looked like a
clear win: `MissingCsrfToken` 12 → 20, `MissingOriginValidation` 12 → 20, and
`PrivilegeEscalation` **0 → 20** where freight had never produced one. Forty findings that had
not existed the run before.

Two things about that list were wrong before I checked anything. The CSRF and the escalation
endpoints were **the same twenty**, which is the sort of coincidence worth a second look. And
neither FP_D29 (`/warehouse/stock/:id/adjust`) nor FP_D11 (`/claims/:id/settle`) was among
them — the two planted defects the previous two fixes had been built to reach.

**What the twenty actually are.** Freight's shipment edit, checked against the running
application:

```
POST /shipments/shp-0005/edit   _csrf=wrong      ->  302  location: /shipments/shp-0005
POST /shipments/shp-0005/edit   _csrf=<real>     ->  302  location: /shipments/shp-0005
```

Identical. And the endpoint enforces its token correctly: after the first, `pieces` was
unchanged at 18; after the second it was 9. The handler's own line says it:

```js
if (!await csrfValid(ctx)) { setFlash(ctx, 'error', 'That form expired.');
                             return ctx.redirect(`/shipments/${shipment.id}`); }
```

A refusal and a success go to the same address and differ only in the flash message waiting on
the page they land on. `stateChangeAccepted` reads the Location header, sees "redirected
onward, not back to the form" for both arms, and calls both accepted. So the check reports a
missing anti-forgery token on an endpoint that has one, and a privilege escalation against an
account whose write was refused.

So defect 82's fix — finally sending a body the endpoint would take — did not turn 37 silent
inconclusives into verdicts. It turned them into **confident wrong answers**, which is worse
than the silence it replaced. This is defect 75's failure mode reached from the opposite
direction, and it is the reason the r11 numbers are not in `multi-target-results.md`.

**The fix is the one the commit that caused it already named.** `bee41cd6` was called *"A
redirect is not an answer: the CSRF and origin checks now read where it went"* — and it read
where it went from the header. The next step is to actually go there. `arrivedAt` follows each
arm's redirect once and reads the page, and `distinguishedTheTwo` compares what the
application said:

- **An error only the probe was shown** → the probe was refused → clean, quoting the
  application's own words back (`the application answered "That form expired."`).
- **The same page for both** → the application did not distinguish them → the finding stands.
  This is FP_D11: writer and viewer both told *"Claim settled."*
- **Different for some other reason** → `inconclusive`, saying so. A page carrying a view
  counter or a timestamp is not evidence either way, and reporting a finding on it would be
  guessing. This costs real detections on applications whose pages vary, and that cost is
  taken deliberately: the alternative is manufacturing findings, which is the thing this file
  exists to stop.

An alert both arms see — a maintenance banner, a stale-rates notice — says nothing about
either request and is ignored.

**Cost:** two extra GETs per endpoint where both arms looked accepted *and* the answer was a
redirect. A refused control costs none, and a 2xx answer costs none, because nothing was
inferred from a redirect in either case. I had the control's read running before the
control's verdict at first, which spent a request on endpoints that were never going to be
evaluated; a test that pins "the probe is not worth sending once the control failed" caught
it.

**The order these three defects had to be fixed in is the point.** 82 let the checks issue a
request the endpoint would accept. 83 let a write be judged as a write. 84 stopped the result
being a confident lie. Fixing any one or two of them alone would have left the product worse
than before: 82 and 83 without 84 is exactly the 40-finding run above.

---

## 85. The scan never held an anti-forgery token for any server-rendered application

**Found by not believing the improvement either.** With defect 84's destination read in place,
freight's false findings collapsed: `PrivilegeEscalation` 20 → 2, `MissingCsrfToken` 20 → 10.
Then I checked the ten that survived, and `/shipments/shp-0005/edit` was among them — the exact
endpoint I had proven by hand, an hour earlier, **enforces its token correctly**.

So the destination read had not worked there, and the reason turned out to be upstream of all
three of the previous defects:

```js
const readCsrf = (body) =>
  (body && typeof body === 'object' && body.csrfToken) ? body.csrfToken : null;
```

That is the only place a scan ever got an anti-forgery token. A JSON field called `csrfToken`.
Freight serves its token the way every server-rendered application does — a hidden input,
`<input type="hidden" name="_csrf" value="…">` — so `session.csrf` was **null for every
freight scan ever run**, and for every application of that shape.

**Why that was invisible until now, and why it then produced findings rather than silence.**
The anti-forgery check's control request is the application's own request, token included. With
no token the control is refused. Before defect 82 the control was refused anyway, for want of a
body, so nothing downstream could tell the two causes apart. Once the body was right, the
control was refused *for the token alone* — and on an endpoint that answers a refusal with a
redirect to the record rather than by re-showing the form, that refusal is invisible in the
status and the Location. Both arms refused identically. Two identical answers, two identical
landing pages. Defect 84's rule read "identical" as *the application did not distinguish them*,
which is true, and not the point.

Ten findings, each against an endpoint doing the right thing, each caused by the scan not
holding a credential it had never been able to read.

**Two fixes, because one of them is a capability and the other is a guard.**

The capability: `readCsrf` now reads a hidden input whose name says it is a token — the same
spellings the form extractor uses to set `hasCsrfToken`, in either attribute order — and a
`<meta name="csrf-token">`, which is how a single-page application is handed one.

And it reads it **after** signing in. The token on the sign-in page belongs to the session the
caller had *before* it signed in, and freight derives its token from the session cookie:

```js
function csrfToken(ctx) {
  const sessionToken = ctx.cookies.lab_session ?? 'anonymous';
  ...
}
```

So the pre-login value is syntactically a token and wrong, which is worse than none, because
the check would believe it was sending the application's own request. A sign-in POST normally
answers 302 with an empty body, so `antiForgeryTokenFor` reads the response where it carries
one, then the page the redirect led to, then the application's root. One extra request per
identity, at most two.

The guard: the control has to have been *accepted* before the probe means anything, and when
both arms land on the same page carrying an error, the control was refused. That case now
reaches no verdict instead of a finding.

**Telling a flash message from a banner.** An alert on the landing page is only evidence if it
is about the request. A stale-rates notice the page always carries is not, and from a single
page the two look identical. So when both arms land on the same page *and* it carries an alert,
the page is read once more: a flash message is consumed when it is read and is gone, a banner
is still there. One request, in the one case where it decides something.

**Four defects in series over one endpoint.** 82 let the check issue a request the endpoint
would take. 83 let a write be judged as a write. 84 stopped a refusal-by-redirect reading as
acceptance. 85 gave the scan the credential that makes its control request the application's
own. Each one was only visible once the one before it was fixed, and each intermediate state
produced a *more confident* wrong answer than the state before. That is the argument for
re-measuring after every fix and distrusting every improvement, and it is why no freight number
from r11 or r12 was published.

---

## 86. A hundred and seventy-three findings, seventeen facts

**Found by collapsing the report I was about to publish.** Freight's r13 scan reported 173
findings. Grouped by what they actually say:

| | |
| --- | --- |
| 135 | `x-content-type-options is not set` |
| 16 | `Session cookie "lab_session" is missing HttpOnly when "remember" is enabled` |
| 3 | `A read-only account can perform a write` |
| 3 | `Protected data is served to an unauthenticated caller` |
| 3 | `6 consecutive failed sign-ins were never throttled` |
| 2 | `15 requests in quick succession were never rate limited` |
| 1 each | nine more, including the real missing-token hole and an open redirect |

**Seventeen distinct facts in 173 rows.** 151 of them — 87% — are two sentences repeated. The
three privilege escalations and the one genuine anti-forgery hole are somewhere after row 151.

This is not cosmetic. The thing a reviewer is paid to find is the row they will never reach,
and every count the product has published this session was a count of rows rather than
problems. `verification/multi-target-results.md` carries those numbers. I had written "28
findings on 19 targets → 20 on 12" as a measure of improvement without once asking how many
*things* that was.

**Three different ways one fact arrived more than once.**

*The whole application.* A response header is set by one piece of middleware. Missing on 135
pages is one fix. So is a cookie's HttpOnly: the attribute is set where the cookie is issued,
once, whatever page the scan happened to observe it on. The check now says so by setting
`subject` on the finding — `header:x-content-type-options`, `cookie:lab_session:HttpOnly` — and
findings sharing a subject become one.

*Every instance of one route.* `/api/shipments/shp-0001`, `shp-0002` and `shp-0003` are three
samples of `/api/shipments/{id}`, and an endpoint that serves protected data without a session
does it for every id. `routeTemplate` replaces a segment that cannot be a route name — a
number, a prefixed number, a UUID — and leaves a word alone, because `/orders/sales/new` and
`/orders/sales/approve` are two routes and merging them would hide one.

*The same address, spelled two ways.* `/auth/sign-in` and `http://127.0.0.1:4400/auth/sign-in`
reached the surface as separate items, so account lockout was reported against both.

**What is deliberately not collapsed.** Three read-only writes on `/reports/builder`,
`/warehouse/transfers/new` and `/fleet/drivers/new` are three problems and three fixes. A rule
that merged them would be the same mistake pointing the other way, and a worse one: this one
wastes a reader's time, that one loses an endpoint. Only a declared subject, or the same fact
on the same route template with the same method, parameter and role, is treated as one.

**And nothing is dropped.** The survivor carries how many addresses it stands for and lists
the first eight, and the sentence goes into the description a person reads, not just into a
column: *"The same thing is true at 134 other address(es) this scan reached. Also at …"*. A
collapsed report that quietly discarded 134 addresses would be a different kind of dishonesty
from the one it fixes.

---

## 87. The cautious branch threw away every finding it was asked to judge

**Found by reading the collapsed report instead of celebrating it.** The run that reduced 173
findings to 18 facts also reported **zero** privilege escalations, where the run before it had
three — and I had verified all three by hand: `/reports/builder`,
`/warehouse/transfers/new` and `/fleet/drivers/new` each let an audit viewer write, with no
permission check in any of the three handlers.

The scan said why:

> *both operations and audit viewer were answered the same way and both redirected to the same
> address, but the page they led to is not the same for each, and the difference is not an
> error the application is reporting. Founding a privilege-escalation finding on it would be
> guessing.*

That is defect 84's third branch, which I had written one commit earlier and described as
taking a deliberate cost: *"This costs real detections on applications whose pages vary, and
that cost is taken deliberately."*

The cost was not applications whose pages vary. **The page differed because both writes had
landed in it.** Writer creates driver 25, the landing page is read; viewer creates driver 26,
the landing page is read again and now has an extra row. The difference *is* the finding, and
the branch built to avoid guessing discarded it — three for three, every finding that reached
that branch.

**The discriminator I was missing is one more read.** Either the second request changed what
the address shows, or the page varies by itself — a view counter, a relative timestamp. A page
read a third time with nothing sent to it settles which: a page that is stable was changed by
the request; a page that differs from itself was never evidence about either request.

`thePageChangesOnItsOwn` does that, in the one branch where it decides something.

And a case that needs no read at all: when the two arms land on **different** addresses, each
request was given a destination of its own, which on a form that saves and redirects to what
it saved means each one saved something. Comparing two different records establishes nothing;
there is nothing ambiguous to resolve.

**What this says about "cautious".** Preferring no verdict over a wrong one is right, and I
reached for it three times today — 84's third branch, 85's control-refused guard, the alert
check. Two of those were correct. This one was a guess dressed as caution: I had not worked
out *why* two pages would differ, so I called it unknowable, and the commonest reason turned
out to be the very thing the check exists to detect. Caution that has not understood the case
it is declining is not caution.

---

## 88. Error markup inside a script made every page look like it was reporting an error

**Found by running one check against one endpoint and printing what it sent.** FP_D29 — the
stock adjustment form carries no anti-forgery token — survived every fix in defects 82 to 87,
and the reason the scan gave had become wrong in a new way each time. So instead of reading
code I ran `checkCsrfToken` against `/warehouse/stock/stk-fxt-sku-001/adjust` directly and
printed every exchange:

```
SECA-CSRF:control   POST  delta=1&reason=Cycle+count+correction&note=QA+NXT+test+notes
                    -> 302  /warehouse/stock/stk-fxt-sku-001
SECA-CSRF:arrived   GET   -> 200   flash-success "Stock adjusted by +1. On hand is now 254."
SECA-CSRF:no-token  POST  delta=1&reason=Cycle+count+correction&note=QA+NXT+test+notes
                    -> 302  /warehouse/stock/stk-fxt-sku-001
SECA-CSRF:arrived   GET   -> 200   flash-success "Stock adjusted by +1. On hand is now 255."
```

The defect is in that transcript twice over. A request with no anti-forgery token was accepted,
the stock balance moved, and **the application said so in words** — and the check returned
*"the page varies on its own"*.

**Two faults, one of them mine from an hour earlier.**

*Comparing whole page bodies cannot work on an application that reports what it did.* Defect
87 settled the "pages differ" case with a third read: a page stable when read again was changed
by the request. But freight's flash message is consumed when it is read, so the page after the
probe always differs from the same page read again — by exactly the sentence that proves the
probe wrote. Every application that reports its own writes looked like an application whose
pages vary at random. Two consecutive reads with nothing sent between them are byte-identical,
which is how I know the volatility was the flash and nothing else.

The fix is to stop diffing and read what the application said. `successesIn` looks for the
regions a server-rendered application puts a confirmation in — `role="status"`,
`class="flash-success"`, `alert-success` — and a probe whose landing page carries one, with no
error beside it, was accepted. That is better evidence than any comparison of two pages, and it
is what the application volunteers.

*And the reason that branch never fired:* freight ships this in an inline script, on every page
in the application:

```js
root.innerHTML = '<div class="flash flash-error" role="alert" data-testid="flash">'
               + 'That view could not be loaded.</div>';
```

`alertsIn` matched it. So every page in freight appeared to be reporting an error, the
"no error beside it" condition was never true, and the success branch was unreachable.

It was harmless only by luck. The same literal sits on both pages, so neither arm appeared to
carry an error the other lacked — and `distinguishedTheTwo` compares the two sets rather than
testing either alone. An application that embedded error markup in a script on one page and not
another would have produced a confident **"the probe was refused"** on an endpoint that
accepted it. A region that reads as an error has to be a region the application *rendered*:
scripts, styles and comments are stripped before either scanner runs.

**FP_D29 is now found**, with the application's own sentence as the evidence.

---

## 89. Discovery maps as one identity; the scan is given several

**Established by hand, after the extractor turned out to be working.** FP_D11 is a settlement
hidden from a viewer and permitted by the handler, and I had written that the product could not
reach it because every claim reference is a `data-route` button the crawl could not read. That
was wrong twice: the extractor reads them, and the worker log for the latest run says
`Mapped /claims/clm-0001`. I had grepped the scan's log rather than the crawl's and concluded a
fix was not working when it was.

The real reason is upstream of anything a crawler can do:

| signed in as | settle control rendered | `GET /claims/clm-0001/settle` |
| --- | --- | --- |
| `ops.lead` | **no** | **403** |
| `admin` | yes | 200 |
| `finance` | yes | 200 |

`claim:settle` belongs to administrator and finance. Freight's claim page renders the control
only for a role that holds it:

```js
${settleable && maySettle ? `<button data-route="/claims/${claim.id}/settle">Settle</button>` : ''}
```

Discovery signs in as `ops.lead`. The address is not in the markup it reads and is forbidden to
it besides, so **no amount of crawling as that identity finds it.** The scan is nevertheless
given three identities including `administrator`, which sees both.

So the surface is whatever one identity could see, while the scan holds credentials that would
have shown it more. That is a structural gap, not a bug in a crawler, and it is the same shape
as CS_D04 on clinic-spa — a control the interface hides from a role and the endpoint permits —
except that there the crawl *had* the identity that could press it.

**What was built, and what was deliberately not.** The scan now reads each page the surface
already holds as the most privileged identity it was given, and reports every destination that
identity's page declares which the surface does not hold: the address, the control's label, and
the page it was declared on.

It does **not** add them as targets. Which checks an address implies is decided where the
surface is built, from the forms, the observed traffic and the route shape together, and a
second copy of that rule in a worker would be a worse one. Making the product *test* these
addresses means letting discovery map as more than one identity — a change to what an
application record holds, which is a design decision rather than something to infer here. It is
flagged, not made.

So FP_D11 goes from a silent miss to a named gap carrying its own address. That is the standard
the rest of the scan already holds itself to and it is not the same thing as finding the defect,
which this does not claim.

---

## 90. Every route template matched nothing, because a bare path is a file URI on Unix

**Found by the tests, before any run.** The business rules file lets an owner write a rule for
`/billing/credit-notes/{id}` and have it apply to `/billing/credit-notes/cn-0004`, which is the
address a run actually visits. Three tests asserting exactly that failed, and the exact match
beside them passed, which is the shape of a bug worth chasing rather than a fixture worth
editing.

`BusinessRuleFile.Normalise` unwrapped an address like this:

```csharp
if (Uri.TryCreate(path, UriKind.Absolute, out var absolute)) path = absolute.AbsolutePath;
```

On Unix, `Uri.TryCreate("/billing/credit-notes/{id}", UriKind.Absolute, ...)` returns **true**:
a leading slash is a valid absolute `file:` URI. `AbsolutePath` then comes back percent-encoded,
so the screen became `/billing/credit-notes/%7Bid%7D`, the brace the template matcher looks for
was gone, and no template ever matched anything. A plain path survived unharmed, so every exact
match worked and the capability looked fine.

| written as | normalised to | matched `/billing/credit-notes/cn-0004` |
| --- | --- | --- |
| `/billing/credit-notes/cn-0004` | `/billing/credit-notes/cn-0004` | yes |
| `/billing/credit-notes/{id}` | `/billing/credit-notes/%7bid%7d` | **no** |
| `/orders/:orderId/lines` | `/orders/:orderid/lines` | yes, by luck — no encoding needed |

Only http and https are unwrapped now, and what comes back is unescaped. The TypeScript half
was never affected: `new URL('/billing/credit-notes/{id}')` throws, the throw is caught, and the
path is left as written — which is why the same logic in two languages disagreed, and why the
C# tests were worth writing rather than assuming the behaviour carried over.

**What this cost if it had shipped:** a rule written for a detail screen would have been stored,
listed in the application's configuration as a rule, counted among the rules, and silently
applied to nothing. No failure, no skip, no report — the rule simply would not exist at run
time. The product would have said it was checking something it was not.

## 91. Six tests asserting a refusal would have passed had the code never refused

**Found by reading my own new tests rather than their result.** The business rule oracle has to
refuse in six distinct ways — a broken rule, a missing field, a rule written for another screen,
a rule that cannot be parsed, a step carrying no rule, a name the screen gives two figures. Each
was asserted like this:

```ts
await assertBusinessRule(page, RULE).catch((error: Error) => {
  expect(error).toBeInstanceOf(InconclusiveError);
  expect(error.message).toContain('is about /billing/invoices/new');
});
```

If the oracle returned instead of throwing, the callback never runs, nothing is asserted, and
the test passes. All six were green. All six would have stayed green had the oracle silently
approved every rule it was handed.

That is the same failure this product exists to find, inside its own test suite: a pass that
means nothing was observed. The house rule says a pass means it ran, the expected behaviour was
observed and there is evidence, and `.catch(callback)` satisfies none of the three.

Replaced with a helper that throws when the oracle does not:

```ts
const refusalOf = async (rule: string | undefined): Promise<Error> => {
  try {
    await assertBusinessRule(page, rule);
  } catch (error) {
    return error as Error;
  }
  throw new Error('the oracle returned where it was expected to refuse');
};
```

And a test asserting the helper itself fails on a rule that holds, because a guard nobody has
seen fail is a guard nobody has tested. Seven tests now, where six were decoration.

**Worth noting about how it was found:** the six tests were written in the same minute as the
code they test, both by me, and both were green on the first run. Nothing about the result said
anything was wrong. The only reason to look was that a green suite written that fast is itself
suspicious.

## 92. A rule about a refusal passed because the user could not perform the action at all

**Found on the first live run of the submission rule, by the control rule written beside it.**

A submission rule disbelieves a form's own submit button: it forces a value the browser would
refuse, sends it straight to the endpoint as the signed-in user, and judges what comes back. Two
rules were written against freight's credit-note screen, which is where FP_D09 lives — a credit
note can be raised for more than the invoice it credits:

```
rule CREDIT_NOTE_CANNOT_EXCEED_ITS_INVOICE
  submit  invoiceId = inv-0002, amountGbp = 50000, reason = Goodwill
  expect  refused

rule SMALL_CREDIT_NOTE_IS_ACCEPTED
  submit  invoiceId = inv-0002, amountGbp = 100, reason = Goodwill
  expect  accepted
```

Run as `ops.lead`, the identity the measurement uses everywhere:

| rule | verdict | why |
| --- | --- | --- |
| CREDIT_NOTE_CANNOT_EXCEED_ITS_INVOICE | **PASS** | refused — 302 back to the form |
| SMALL_CREDIT_NOTE_IS_ACCEPTED | **FAIL** | refused — 302 back to the form |

Both were refused, and the refusal had nothing to do with the amount. `billing.js:338` gates the
handler on `can(user, 'invoice:credit')`, which `role-operations` does not hold. Every submission
to that endpoint as `ops.lead` is refused, whatever it carries. The first rule passed on a
refusal it had not caused, and reported a rule holding that had never been tested.

Run as `finance`, who holds the permission:

| rule | verdict | why |
| --- | --- | --- |
| CREDIT_NOTE_CANNOT_EXCEED_ITS_INVOICE | **FAIL — FP_D09** | accepted: 302 to `/billing/credit-notes`. A £50,000 credit note against a £778.28 invoice. |
| SMALL_CREDIT_NOTE_IS_ACCEPTED | **PASS** | accepted: the £100 note goes through |

**What this means about the shape of the check, not about one run.** A refusal is not evidence
that a rule is enforced. A permission gate, a missing required field, an expired token, a
read-only identity and the rule itself all produce the same 4xx or the same 302 back to the form,
and the oracle cannot tell them apart — nor could any oracle, because the application does not
say. The only thing that distinguishes them is a second submission that *must* succeed.

So the paired control is not good practice, it is the measurement. Both the rules file and the
manual now say: pair every `expect refused` with an `expect accepted`. Without it, a refusal rule
is a test that cannot fail for the right reason and cannot be told from one that passed.

Worth being plain about how close this came to shipping as a success. Had I written only the
refusal rule — the obvious thing, the one that names the defect — the run would have reported it
passing, I would have recorded FP_D09 as found, and the product would have been wrong about the
one defect the feature was built to catch.

## 61. The measurement reported its own blind spot as the product's failure

**Symptom.** Freight stood at 10 of 32 with 17 "missed". Three of those numbers were wrong,
and the error was in the measurement, not the product.

**Diagnosis.** The detector joins a planted defect to a signal by keyword. Each defect carries
a short list of words, and a failure must contain one to be credited. FP_D27, the audit log
answering in four seconds, had `slow, response time, performance budget`. In the very run that
was analysed, three executions of *"Audit log · Meridian Freight (/admin/audit): loads within
3000 ms"* failed with

```
Expected the page to load within 3000 ms but it took 3424 ms.
```

Same screen, the symptom in numbers, not one of those three words. The product found it and
the measurement could not see that it had.

That is not one defect's bad luck. **Thirteen of the thirty-two were unscoreable by keyword**,
and the detector already said so. It prints a list headed *"Keyword lists that match nothing in
this run"*, carrying its own warning:

> Either the defect genuinely produced nothing, or the list was written against wording the
> oracles do not use — which is how FP_D25 and FP_D26 read as missed while both were being
> detected.

The report fired, named all thirteen, and was not acted on, including by me. Every one of them
was published as "missed" — a claim about the product resting on the measurement's blind spot.

**And one of the ten was a false positive.** FP_D18 is a 500 on a long search at `/shipments`.
It had been credited to this:

```
A stack trace is returned to the caller  CWE-209  A05:2021  /api/shipments/{id}
```

That is FP_D31's endpoint. Both defects list `stack trace`, so they tied on specificity and
order decided; D18 took the signal and D31 was published as missed while the finding that
evidences it sat credited to another defect.

**Fix.** Three parts.

*The verdict.* A defect whose words appear nowhere in the run now reads `unscoreable`, not
`missed`. "The product found nothing" and "nothing here could have found anything" are
different facts about different things, and only the first is about the product. Merging them
attributes the measurement's gap to the thing being measured, in the direction that looks
rigorous — which is the one to distrust.

It is gated on the run having produced signals at all. With no failures, every keyword list
matches nothing for the opposite reason: the product ran and reported nothing, which is a
genuine miss. A test pins both directions, and it caught this exact over-reach when the gate
was missing.

*Structure before prose.* The product records what kind of test each one is and the ground
truth records what kind of defect each one is. Those agreeing, on the defect's own screen, is
stronger evidence than a phrase one side guessed at, so category agreement now counts.

It counts **alone** only where the category is the whole claim — `performance` and
`responsive`. A page is either slow or not; there is one such proposition per page. A form
carries many validation rules, so "a validation test failed here" cannot say which. The first
version of this rule lacked that restriction and credited three defects wrongly in a single
pass: a step-boundary failure about "Net amount (GBP)" read as the duplicate-invoice-reference
defect, and a missing-field validation message read as the crash on an invoice whose shipment
had been removed. Caught by reading the evidence of every newly credited defect rather than
the count.

*A test that never acted is not the application failing.* `"expected at least 1 GET request(s)
to \"%20%3CNode%3E\" but saw 0 (no submission was sent at all)"` was classified as an
application failure by default. The submission never left, so the assertion about how fast it
was answered has no subject. This mattered beyond its own count: that signal is on
`/admin/audit` and carries the Performance category, so once category agreement became
admissible it was eligible to stand for the audit-log defect — and being first in the list it
won over the failure that actually measures the page. A right verdict on the wrong evidence is
still wrong.

**The corrected figures, same run, same data.**

| | before | after |
| --- | --- | --- |
| found | 10 | **11** |
| possible | 1 | 1 |
| missed | 17 | **5** |
| unscoreable | — | **11** |
| unreachable | 4 | 4 |

Two genuine detections recovered — FP_D27 on *"took 3425 ms"*, FP_D28 on *"'q' is reflected
into HTML without encoding"* — and one false positive withdrawn, FP_D18, which is now
unscoreable because its own words appear nowhere in the run.

**The honest reading of the new shape**: of 32 planted defects, this measurement can speak to
17. It found 11 of those and missed 5. For the other 15 it says so, which is the first time
that has been true.

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
