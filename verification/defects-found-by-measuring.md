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
