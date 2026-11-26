# What QA NXT found on four applications of different shapes

Every number here was produced by `node test-lab/run-target.mjs <target>`, which drives the
product through its own API exactly as a team would: register the application, discover it,
design the deterministic form-level suite, authorize and run a security scan with several
identities, execute the suite in a real browser, then join every failure and finding back to
the defects planted in the target. AI is switched off throughout, so the figures are the
deterministic engines and nothing else.

The run that produced this file is recorded in `test-lab/multi-target-result.json`.

## Why four applications and not one

Meridian Freight — 137 screens, server-rendered, a sign-in form, POST for everything that
writes — was the only application the engines had ever been measured against. One
application can only expose the defects its own conventions reach, and that proved to be
the limit rather than a theory: **fourteen product defects came out of building three more
targets, and nine of them were the same mistake made in a second place.** A rule the engine
had learned and the worker had not. A URL joined correctly in one module and concatenated in
forty-three sites of another. An identity model implemented carefully and then undone by two
lines in a handler no test could reach. They are listed in
`verification/defects-found-by-measuring.md`, entries 13 to 26.

| Target | Built like |
| --- | --- |
| `freight-platform` | server-rendered, 137 screens, 13 domains, form sign-in |
| `clinic-spa` | 244-byte HTML shell; every screen, form and table built by JavaScript; History API routing; JSON API |
| `permits-legacy` | HTTP Basic challenge, state changes through `GET` links, no anti-forgery token, nested-table markup, integer ids in the query string |
| `token-api` | bearer token in a JSON body rather than a cookie, `X-CSRF-Token` header convention, one HTML page over a JSON API |

## Measured

All three columns below come from **one run, in one configuration**, with state-changing
interaction authorised: `node test-lab/run-target.mjs clinic-spa permits-legacy token-api
--destructive` on 2026-11-26.

| | clinic-spa | permits-legacy | token-api |
| --- | --- | --- | --- |
| Pages discovered | 4 | 7 | 4 |
| Forms extracted | 4 | 2 | 0 |
| Tests designed and run | 198 | 203 | 32 |
| Security checks executed | 24 of 29 | 18 of 22 | 16 of 26 |
| Security findings | 11 | 7 | 10 |
| Coverage gaps | 46 | 27 | 6 |
| **Planted defects detected on evidence** | **4 of 4** | **4 of 4** | **4 of 4** |

**The findings row counts facts, not rows, and it did not until 2026-11-26.** The earlier
figures here were 19, 23 and 13, and they were counts of *report rows*. A response header is
set by one piece of middleware, so a scan that looked at forty pages reported it forty times;
the same was true of a session cookie's attributes and of every instance of one parameterised
route. On freight that arithmetic was stark — **173 rows holding 17 distinct facts, 151 of
them two sentences repeated** — and the three privilege escalations worth reading were
somewhere after row 151. Defect 86 has the detail. Nothing is discarded: a collapsed finding
carries how many addresses it stands for and names the first eight, in the description a
person reads.

Every number this file has ever published was a row count. They are corrected above.

**That it is one configuration is the point, and it was not true until 2026-11-26.**

CS_D04 is a control the interface hides from a receptionist and the endpoint permits anyway,
and the only way to learn what that control calls is to press it. Pressing it changes the
application, so it needs the owner's permission. Without that permission the crawl declines,
the endpoint stays off the surface, and clinic-spa reads 3 of 4 — correctly, with the reason
recorded rather than the defect silently missing.

The same permission used to **cost** permits-legacy its PL_D01. Approving a permit there is a
`GET`, so under authorisation the crawl followed the approve link and approved two permits
while mapping; `request.safe-verb-state-change` then read the register either side of
approving permit 1, found it already approved, saw no change and declined to call the endpoint
safe. The check was right and the evidence was already spent. permits-legacy read 4 of 4 in
navigation mode and 3 of 4 with interaction authorised, losing the one defect the
authorisation was supposed to help with. Defect 81 has the evidence and the fix: a link whose
own words say it changes something is never followed, because its address is in its own href
and is recorded either way, while a control's endpoint can be learned no other way.

Until that was fixed there was no single setting under which all three reached 4 of 4, and
saying "all three are at 4 of 4" meant reading each in its own best configuration. One run,
one configuration, is what the table above now reports.

Three checks found it once the endpoint was there: `authz.readonly` reporting *"A read-only
account can perform a write"* against `/api/appointments/apt-1/cancel`, which is the planted
defect, alongside `request.csrf` and `request.origin` on the same address.

**permits-legacy moved 3 of 4 to 4 of 4 on 2026-11-23,** and its *checks executed* figure fell
at the same time, from 18 of 18 to 17 of 21. Both numbers improved. The old one came from the
count the launcher configured; this one comes from the scan's own record of what executed, and
it names the four that did not — `request.csrf` and `request.origin`, which replay a request
with the session's cookie and have none to replay against HTTP Basic; `authz.readonly`, which
could not establish that a write was refused for the reason it was testing; and
`api.input-validation`, which found no parameter to probe. A fifth, `authz.vertical`, now
executes and reports that an inspector and a clerk both reach `/approve.asp?id=1`, which is
true and is not a finding, because nothing observable says either should have been refused.

The lower number is the better one, and the reason it was ever the higher one is worth
keeping: the measurement driver was reading fields the API does not return, so every run it
had printed said "? request(s)" and silently dropped the coverage figures. A measurement tool
that discards how much of a scan was real is measuring the thing it is pointed at less well
than it claims to.

token-api moved 2 of 4 to 4 of 4 on 2026-11-22, measured on one build with the other two
columns. The two that changed had both been built and neither had ever fired:

- **TA_D04**, a stack trace from an unparseable order id, now found twice over — the
  error-disclosure check reporting *"An unparseable identifier returns a stack trace"* and the
  passive check reporting *"A stack trace is returned to the caller"*. It was invisible because
  `JSON.stringify` writes a newline as two characters, so every frame of a trace in a JSON body
  is separated by an escape sequence and the pattern was anchored on a real line break. Product
  defect 44.
- **TA_D03**, a sign-in that is never throttled, now found by `auth.lockout` reporting
  *"6 consecutive failed sign-ins were never throttled"* against the real endpoint. Two things
  were in the way: the probe was posted to a guessed `/api/session` while the application had
  declared `/api/auth/token` all along (45), and the guard that stops six anti-forgery refusals
  reading as six un-throttled attempts was suppressing the true finding, because this API answers
  a wrong password and an empty submission identically (46).

**PL_D01, and a claim that was wrong about it.** An earlier version of this section said
clinic-spa's CS_D04 and permits-legacy's PL_D01 were "the same defect in two shapes" and that
one check would close both. The first half is defensible — both sit behind a control the crawl
will not press — and the conclusion drawn from it was not. clinic-spa cancels an appointment
with `POST /api/appointments/:id/cancel`, and a POST is not a safe verb, so the check built
from that paragraph cannot apply to it. What the two share is how they are reached, not what
is wrong with them.

PL_D01 is closed. `request.safe-verb-state-change` issues the link as the lowest-privilege
identity available and concludes from a witness page rather than from the verb: it reads the
page the link was found on twice, changing nothing, and declines to evaluate if those two
reads already differ. On this target the witness read identically at 2,292 bytes twice and
differed afterwards, and the finding joined PL_D01 on route and wording —
*"A GET changes state, and needs no anti-forgery token to do it"*, CWE-352, observed as the
viewer identity.

CS_D04 is closed, and the way it closed is the point. The sentence that used to sit here — that it needs per-identity
discovery, "a feature rather than a fix" — was asserted without being tested and is not
established. That is the second claim about this one defect made from reasoning rather than
measurement; the first was that it shared a shape with PL_D01. Both are recorded in product
defect 49 rather than quietly replaced.

**What is measured.** `POST /api/appointments/{id}/cancel` never reaches the attack surface.
Not with the crawl in navigation mode, and not with it in interactive mode and state-changing
clicks authorised. Without the endpoint on the surface no authorization check can be pointed
at it, so the defect is out of reach before identities enter the question at all — which is
what makes the per-identity story not merely unproven but the wrong layer to be looking at.

Three observations, in the order they were made:

- In navigation mode, the click pass over `/schedule` reported `skipped 1 control(s)` and gave
  no reason. The crawl logged only two refusal reasons, and "it is not navigation and the
  crawl is in navigation mode" is neither of them. It logs this one now.
- The `--destructive` flag set `allowStateChangingClicks` and left the mode at `navigation`,
  where that flag is close to inert for anything but a form submit: the click decision
  consults it for submit and reset controls *before* the mode gate and consults the mode
  afterwards for everything else. The flag now carries the mode with it.
- With both set, discovery did find more — four forms rather than three, five endpoints rather
  than four, `POST /api/appointments` now on the surface — and still no cancel endpoint. In
  that run the click pass over `/schedule` produced no line at all, where the navigation-mode
  run had produced one.

**And then the actual cause, which was none of the above.** Three mentions of "cancel" exist
in the whole fixture: the comment describing the defect, the button markup, and the server
route. No line of client code ever joined the second to the third. The lab drew a Cancel
button that called nothing, so the application never issued the request discovery would have
had to observe, and the endpoint could not reach the surface by any amount of crawling. The
product was behaving correctly the entire time.

Wiring the control — which is what the fixture's own ground truth describes — and authorising
interaction produced the endpoint on the first run, and three checks on it immediately. The
question that settled it was not about the crawler or the identities or the verb. It was
"does the application actually do the thing", and it went unasked through three runs and two
written explanations.

The driver now prints which ground-truth routes nothing reached, so that question is asked by
the instrument rather than remembered. It cannot say whether an unreached route is a gap in
the product or a fixture that does not exercise itself — but naming the route is what was
missing, and the line says plainly that it does not know which case it is.

Discovery working at all on `clinic-spa` is the first result worth stating: the server sends
no content, and the form extractor still found all three forms, because discovery drives a
real browser rather than reading responses.

**Which build each column came from.** The three columns were measured on different commits
of the same day's work, and saying which matters more than tidiness.

That was resolved on 2026-11-23: all three were re-measured, and the table above is from those
runs. `clinic-spa` and `token-api` come from one run of the driver over both; `permits-legacy`
comes from a run one commit later, which added the rule that a check needing an untouched
record is probed first against an address that changes state.

That commit is the only difference between the two, and it cannot move the other two columns:
neither target has an address the surface believes changes state, so there is nothing for the
rule to reorder. `clinic-spa`'s own check count confirms it independently —
`request.safe-verb-state-change` is configured on `permits-legacy` and is *not* configured on
`clinic-spa`, which is also the measurement that corrected the earlier claim that one check
would close a defect on each.

The earlier prediction in this paragraph held, which is worth recording because predictions
here have not always: both counts went up by one apiece, and `api.error-disclosure` is the
check that did it.

`clinic-spa`'s blocked tests are the read-back oracle declining to run: its
session lives in the page and does not survive a page load, so reopening the record is a
sign-out and the empty page that follows is not evidence. Blocked is the honest verdict there,
and blocked is not coverage.

### token-api: what four links in one chain cost

The fourth target was driven for the first time this round, and the first attempt measured
nothing at all — a scan request for `//` crashed the lab server, and twenty-three tests then
failed against a target that was no longer running. The product got that part right: all
twenty-three were attributed to the environment and nothing was concluded about the
application. The lab answers 400 now.

What the attempt did expose was a shape the product could not test:

| | before | after |
| --- | --- | --- |
| Signed in | no — only `bearerToken`, which needs a token already in hand | credentials exchanged for one at the endpoint |
| Endpoints on the surface | 0 — a JSON navigation was filed as a page | 2, including `/api/orders/{id}` |
| Authorization checks implied | none, for want of a path with an identifier | the object-authorization check ran |
| Planted defects found | 0 of 4 | 2 of 4 |

Each link hid the next: with no sign-in there was nothing behind the public pages; with the
sign-in there was still no endpoint, because a JSON body opened directly is a document to a
browser; with the endpoint there was still no identifier to compare two identities against,
because a collection lists its records and links to none of them; and with the instance
visited, the flag that says an endpoint needs a session was hard-coded false on the new path —
and that flag is the one that implies the check.

The two still missing are named rather than rounded. `TA_D03`, failed sign-ins never slowed,
needed the sign-in endpoint to be on the surface at all, which it now is. `TA_D04`, a stack
trace from an unparseable identifier, needed two things the product lacked: a check that
provokes the error, and a stack-trace pattern that knows more than one runtime — the detector
matched .NET's format only, so a Node application's stack was invisible to it. Both are built;
neither is measured yet, because the build carrying them has not been run against this target.

## Correction, 2026-11-25: freight's figure was 10 of 32 and should not have been

The join from a planted defect to a signal is by keyword, and thirteen of the thirty-two
defects carry words the oracles never use. The detector already printed them under *"Keyword
lists that match nothing in this run"*, with the warning that this is how two defects had
previously read as missed while both were being detected. The list was printed and not acted
on. All thirteen were published as "missed", which states as a fact about the product
something that was only ever a fact about the measurement.

One of the ten was also a misattribution: FP_D18, a 500 on a long search at `/shipments`, had
been credited to a CWE-209 stack-trace finding on `/api/shipments/{id}` — FP_D31's endpoint.
The two share the keyword `stack trace`, they tied, and order decided. D31 was published as
missed while the finding that evidences it was credited elsewhere.

Re-derived from the same stored run and the same data:

| | before | after |
| --- | --- | --- |
| found | 10 | **11** |
| possible | 1 | 1 |
| missed | 17 | **5** |
| unscoreable | — | **11** |
| unreachable | 4 | 4 |

FP_D27 is recovered on *"Expected the page to load within 3000 ms but it took 3425 ms"* and
FP_D28 on *"'q' is reflected into HTML without encoding"*. FP_D18 is withdrawn.

**So of 32 planted defects this measurement can speak to 17: it found 11 and missed 5.** For
the other 15 — 11 unscoreable, 4 on screens nothing reached — it now says so rather than
counting them against the product. Defect 61 carries the detail.

Everything below this heading was written against the old figure. Where it says "10 of 32",
read the table above; the reachability finding it reports is unaffected, because that was
measured against the map rather than through the keyword join.

## Where freight's 10 of 32 actually is, which is not where it looked

Asked properly for the first time on 2026-11-23, with
`test-lab/scripts/ground-truth-reachability.mjs` against the 185-page map:

| | |
| --- | --- |
| Planted defects | 32 |
| Routes mapped | 166 |
| **Defect screens something reached** | **28 of 32** |

So freight's gap is not mainly a reachability gap. Twenty-eight of the thirty-two defects sit
on a screen the crawl walked to, and were still not reported — which is a detection problem,
and a different piece of work from the crawler entirely. Anyone reading "10 of 32" and
reaching for the crawl would have spent the day in the wrong file.

The four that were never reached are the documented class, and all four sit behind a control
the crawl correctly declines to press:

- `FP_D11` `/claims/:id/settle` — a claim a viewer may settle
- `FP_D14` `/shipments/:id/cancel` — a cancel that orphans a route stop
- `FP_D17` `/customs/declarations/:id/release` — a rejected declaration anyone may release
- `FP_D19` `/claims/:id/evidence` — an oversize upload

Three more are reached by path and carry their defect in a query parameter — `?q=` for the
long-search crash and the reflected XSS, `?step=2` for the wizard. Worth keeping separate: a
defect living in a query is on a screen that *was* mapped, and counting it as unreached sends
somebody to look at the crawler for something the crawler did fine.

This question went unasked for most of the project, and the reason it is asked now is
clinic-spa: CS_D04 read as undetected through three runs and two written explanations, and the
cause turned out to be that the fixture drew a control wired to nothing, so the application
never issued the request discovery would have had to see. The instrument now asks.

### Two of the seventeen misses, run down to the cause

The detection analysis records 17 missed with the screen reached, and the largest cluster is
security (4). The first thing to check was whether the form-engine run even scans — it does,
`includeSecurity: true, securityProfile: 'standard'` — so those four were in scope and
genuinely unreported. Two of them are now explained, and neither is a detector failing.

**FP_D28, reflected XSS in search: the product finds it.** A scan run on its own against the
freight target on 2026-11-23 reported `xss.reflected` — *"'q' is reflected into HTML without
encoding"* on `/shipments`. The earlier note in this project recording "no `xss.reflected`
finding at all" as unexplained was a property of that one run and not of the product.

Worth knowing how narrow the defect is: the raw term reaches the markup only through the
*"No shipments match X"* message, so a probe has to return zero rows to trigger it at all, and
`q` has to be on the surface. `/shipments?q=&status=&carrier=&page=1` is mapped, so it is.

**FP_D31, stack trace from an unparseable API id: the check finds it when pointed at it.**
Verified in three steps against the live application rather than inferred.

The defect is there and needs no session: `GET /api/shipments/%00bad` answers 500 with
`{"error":"lookup_failed","stack":"Error: … at Object.handler (file:///home/user/…)"}`. The
detector matches that body, both as JSON-escaped text and as the raw stack field, so defect
44's fix holds. And the check itself, pointed at `/api/shipments/{id}`, returns two findings —
*"An unparseable identifier returns a stack trace"* (CWE-209) and *"An unparseable identifier
makes the endpoint fail rather than refuse"* (CWE-20).

So whether a run finds FP_D31 depends on whether its crawl mapped `/api/shipments/{id}`. The
185-page map did. The 69-page partial map the standalone scan produced did not, which is why
`api.error-disclosure` had one target that day and it was the wrong one.

**What is not claimed.** The full freight detection count has not been re-measured — that
needs the 7,774-test suite — so there is no new number here. What there is: two of the
seventeen explained, with evidence, and neither one a check that cannot see what it is
looking at.

### Why those four were never reached, established rather than assumed

Four probes with `test-lab/freight-platform/discover-with-interaction.mjs`, each one answering
a question the previous one raised.

**The controls are neither links nor forms.** Settle is
`<button type="button" data-route="/claims/{id}/settle">`. No `href`, so the mutating-link
record that put permits-legacy's `/approve.asp` on the surface cannot see it. No form, so the
declared-write-endpoint path cannot either — and that path demonstrably works on this target,
since 69 distinct form actions were extracted including `/billing/invoices/inv-0004/pay`.
Freight is also server-rendered, so its submissions are document POSTs rather than XHR and
nothing lands in the observed-endpoint capture. An interactive click is the only route in.

**The crawl identity's role decides whether the control exists to click.** `ops.lead` holds
`role-operations`: `shipment:cancel` yes, `claim:settle` and `customs:release` no. The
interactive crawl signed in as `ops.lead` reached `/shipments/:id/cancel` three times over and
neither of the other two. One permission held, one screen reached; two permissions missing, two
screens missing. That is a control group at both ends rather than a hypothesis.

**Given the permission, the crawl finds the screen.** Signed in as `admin`, the crawl's own log
reads `Found http://127.0.0.1:4400/claims/clm-0001/settle by clicking "Settle"`, with
`/evidence` and `/investigate` beside it. `/admin/api-keys` and `/admin/audit`, unreachable as
`ops.lead`, were mapped.

**Whether a found screen is then mapped is a budget question, and the crawl says so.** That
run ended `251 URL(s) were still waiting to be opened when the budget stopped the crawl, so
this map is partial by that much` — the settle page among them. Defect 38's fix earning its
keep: a crawl that reports its own unopened frontier is the single most useful product
behaviour in this entire investigation, because every other step was readable only against it.

**Interactive mode is a trade, not an upgrade.** On the same budget it mapped 128 routes where
navigation mode mapped 166, because clicking costs an action apiece — so it reached 21 of 32
defect screens against navigation's 28. It reaches what navigation cannot and misses what
navigation gets. Neither alone reaches everything.

**Closed by doing it.** Signed in as `admin`, interaction authorised, seeded at the claim
detail pages and given 900 seconds, the crawl mapped `/claims/clm-0001/settle` — FP_D11's
screen — along with `/claims/clm-0001/evidence` and `/claims/clm-0005/evidence`, which is
FP_D19's. With `/shipments/:id/cancel` from the `ops.lead` run, three of the four are
demonstrably reachable. The fourth, `/customs/declarations/:id/release`, is the one no run
seeded a declaration *detail* page for; there is no evidence it behaves differently from
settle, and no evidence it does not.

| map | configuration | defect screens reached |
| --- | --- | --- |
| navigation, whole site | the default | 28 of 32 |
| interactive as `ops.lead` | interaction authorised | 21 of 32 |
| interactive as `admin`, seeded | narrow and deep | 18 of 32 |
| **all three together** | | **31 of 32** |

**The union is what is reachable; it is not what a run achieves,** and the difference is the
real finding. Every one of those rows is a different configuration of the same product, and a
customer runs one of them. Breadth and depth trade against each other under a time budget:
navigation mode walks furthest and never presses a control, interactive mode presses controls
and walks less far, and the identity it signs in as decides which controls exist at all. No
single configuration reached everything, and the product does not currently tell anyone that
— the crawl reports its own unopened frontier, which is most of the way there, but nothing
says "the identity you gave me cannot see these controls".

So what freight's four needed was configuration rather than code, which is worth saying
plainly because "10 of 32" invites the opposite conclusion. What the product still owes is a
word about the identity it mapped as.

## The security scan on the big application, 2026-11-26

Six faults in the write checks came out of one afternoon's re-measurement of
`freight-platform`, four of them in series over a single endpoint. The run history is worth
printing because every intermediate state looked like progress:

| run | CSRF rows | origin rows | escalation rows | what had just been fixed |
| --- | --- | --- | --- | --- |
| r10 | 12 | 12 | 0 | — |
| r11 | 20 | 20 | 20 | the checks could finally send a body the endpoint accepts (82, 83) |
| r12 | 10 | 10 | 2 | a redirect-to-the-record read as acceptance (84) |
| r13 | 1 | 1 | 3 | the scan held no anti-forgery token at all (85) |
| r14 | 1 | 1 | **0** | one fact, one row (86) — and the cautious branch ate every escalation |
| r15 | 3 | 3 | 2 | a page stable when read again was changed by the request (87) |
| r16 | 6 | 6 | 5 | the application's own confirmation, read rather than diffed (88) |
| r17 | 13 | 13 | 11 | the same build, with the exploration budget raised to 300 pages |

**r11's forty findings were mostly false.** Defects 82 to 87 in
`verification/defects-found-by-measuring.md` carry the evidence for each step; the short
version is that giving a check the ability to issue a request it had never been able to issue
exposed three further faults behind it, and each one, left alone, made the product *more*
confidently wrong than the silence it replaced.

### What r17 reports, and what was verified by hand

**56 rows, 20 distinct facts, 219 pages.** r16 ran on the same build with the default
160-page budget and reached 141; it found six write endpoints and reported, in its own log,
that *"budget stopped it"* with pages still queued. One of those queued pages carries
FP_D29. Raising the budget is a configuration knob and not a fix to anything, and the two
runs are listed separately for that reason.

Every endpoint reported was checked against the handler, and the discrimination is exact:

| | reported | correct |
| --- | --- | --- |
| no effective anti-forgery check | 13 | **13** |
| no permission check, escalation reported | 11 | **11** |
| permission check present, escalation **withheld** | 2 | **2** |

The two withheld are `/routes/planner` and `/claims/:id/investigate`. Both carry a `can(...)`
gate and neither got a privilege finding, while both correctly got the missing-token one.

`/warehouse/stock/:id/adjust` is the subtle one: its handler *does* name `csrfValid`, behind
`if (!faults.on('FP_D29_NO_CSRF_ON_ADJUSTMENT') && !await csrfValid(ctx))`. With the fault on,
the check is skipped — so reporting a missing token there is right, and it is **FP_D29**.

Three `BrokenFunctionLevelAuthorization` findings were checked the same way. Signed in as
`ops.lead`, `GET /admin/settings`, `/admin/users/new` and `/admin/api-keys` all answer **200**
and serve their content — the API keys page returns its own `<h1>API keys</h1>` to an
operations user.

### The three write findings r15 reported, checked by hand at the time

| endpoint | handler has | `ops.lead`, no token | `readonly`, no token | product said |
| --- | --- | --- | --- | --- |
| `/fleet/drivers/new` | `requireAuth` only | — | 302 → `/fleet/drivers/drv-025`, driver created | CSRF, origin, escalation |
| `/orders/purchase/new` | `requireAuth` only | — | 302 → `/orders/purchase/po-0019`, order created | CSRF, origin, escalation |
| `/routes/planner` | `requireAuth` + `can(user, 'route:plan')` | 302 → `/routes/rte-0017`, route created | 302 → `/routes`, refused | CSRF, origin — **and no escalation** |

The third row is the one worth reading. `/routes/planner` enforces its permission and not its
token, and the product reported exactly that: the missing token, and nothing about privilege.
An audit viewer posting cross-origin with no token created `drv-025` on the first row — list
24 → 25, the name visible on the page.

**None of these three is a planted defect.** `test-lab/freight-platform/defects.js` has no
entry for drivers, purchase orders or route planning. They are real flaws in the lab
application, found by the product rather than seeded for it, which is the result this file has
least right to take credit for and most reason to report.

### Two planted defects the product still does not find

Stated rather than rounded away.

**FP_D29 — the stock adjustment form carries no anti-forgery token. Found, in r17.** It took
four fixes and one knob. The checks had to be able to send a body the endpoint accepts (82),
the value had to be one the application's own business rule allows — `min="-100000"
max="100000"` makes the range midpoint exactly zero and the handler answers *"Enter a whole
number other than zero"* (86) — the refusal-by-redirect had to stop reading as acceptance
(84), and the application's own confirmation had to be read rather than two pages diffed (88).
Then the crawl had to actually reach the page: at the default 160-page budget it does not,
and the run says so.

**FP_D11 — settlement is hidden from a viewer and permitted by the handler. Named, not
found.** Proven by hand in one request: `readonly`, on a page that tells it *"Settling a claim
needs the claim:settle permission, which your role does not hold"*, settled a £5,953.11 claim
for £1.00 — status `submitted` → `settled`.

The product cannot reach it, and not for want of a crawler. `claim:settle` belongs to
administrator and finance; discovery signs in as `ops.lead`; the control is not rendered for
that role and `GET /claims/clm-0001/settle` answers **403** to it. Verified across three
identities. **No amount of crawling as the identity the map was built with finds that
address** — while the scan is given `administrator`, which sees it.

So the scan now reports it as a gap carrying its own address:

> *surface on /claims/clm-0001/settle: Not covered: the map was built as a different identity,
> and administrator can see a control ("Settle") on /claims/clm-0001 that points here. Nothing
> probed this address, because it was not on the surface to probe.*

That is a named gap, not a detection, and the difference is not cosmetic. Closing it means
letting discovery map as more than one identity, which changes what an application record
holds — a design decision, flagged rather than made. Defect 89.

## The control group: the application the engines were built against

`freight-platform` was re-run after every change above, because a fix made for one shape of
application is worth nothing if it costs another. Before and after:

| | before this round | after |
| --- | --- | --- |
| Pages discovered | 152 | 150 |
| Forms extracted | 73 | 72 |
| Tests designed | 6,354 | 6,344 |
| Stopped because | the 900s budget | the 900s budget |
| Links discovery refused to follow | — | 0 |

Unchanged, and the small differences are the budget boundary rather than capability: both
runs stopped on the same 900-second exploration budget with pages still queued.

Two details worth stating, because they say *why* nothing changed. The link guard refused
nothing here: Meridian Freight changes state through POST forms and buttons, which were
always left alone, so the rule that stopped a permit register being approved costs this
application nothing. And its 150 pages carry 150 distinct route shapes — its identifiers are
`SH-1001` and `inv-0004`, never a bare number — so the visit-key fix changes nothing here
either. It only ever changes behaviour on an application that keys records by a numeric path
segment or a query string, which is precisely the case it was built for.

## The two that were not detected

Neither is counted, and neither is quietly dropped.

**PL_D01 — approving a permit is a `GET` any signed-in role may issue.** Reported as a
coverage gap, not a finding: *"The link "Approve" at /approve.asp?id=1, on /list.asp, says it
changes something, and a GET that changes something can be triggered by anyone who gets a
user to open the URL. Discovery did not follow it: mapping an application must not alter it.
Whether it really changes state, and whether it checks an anti-forgery token, was therefore
not established."* The remedy is named — authorize destructive testing, or open it once by
hand. Claiming the defect would be asserting what was not observed; saying nothing would
hide it.

Discovery refusing to follow that link is itself a fix from this round. A crawl approved all
three permits in the register before the rule existed.

**CS_D04 — cancel is hidden from a receptionist and the endpoint allows it.** Not detected
and not surfaced. The cancel endpoint is reached only by pressing a control that changes
state, which discovery correctly never presses, so the endpoint was never observed and the
scanner cannot test what it has not seen. The check that would settle it is the application's
own interface: a control one role is shown and another is not, with the endpoint accepting
both. That needs discovery to run separately as each identity, which the product does not
do.

## The big application's remaining misses, by reason

Seven classes of defect on Meridian Freight had never been detected. Working through them
produced one fix, one that was already covered and awaiting a verdict, and five limits worth
naming rather than rounding away. The useful output of this exercise was the reasons, not the
score.

**Fixed: FP_D15, going back in the booking wizard empties step two.** The retention test
existed and looked only at step one — the step that kind of bug spares — and read only text
fields, while the step that loses data holds numbers and a selector. Every step that can be
returned to now gets its own test, with numbers, dates and selects read back. Recorded as
product defect 27.

**Already covered, verdict pending: FP_D18, a search term over 500 characters returns 500
with a stack trace.** The input-validation battery now sends 5,000 characters to any
free-text field that declares no maximum, and the test
`Shipments: handles 5000 characters in Search` exists in the current suite. Whether it fires
is a matter for that run, not for a code change.

**FP_D01, a stock adjustment that drives on-hand below zero.** The form declares its own
range and the engine tests that range on both sides, in the browser and at the endpoint. The
defect is not a range: it is a rule about the *resulting* balance, which needs the on-hand
quantity and the arithmetic that relates it to the adjustment. Nothing on the page states
that rule.

**FP_D03, a weight entered in pounds stored as kilograms.** Reading the record back cannot
settle this, and the attempt would be worse than the miss. The corrected application shows
453.6 kg for 1,000 lb — the unit submitted appears nowhere, and neither does the number — so
an oracle demanding either back would report the *correct* application for losing data. What
would settle it is a differential: the same number under two units must produce two different
results. That needs the engine to know which selector qualifies which number, which is a
declared relationship the page does not carry.

**FP_D04, two invoices with the same reference.** The reference is generated by the server,
so the test cannot submit a duplicate and watch it be refused; it would have to create two
records and compare the identifiers the application assigned them, which means reading
identifiers out of a list and knowing which of them is meant to be unique.

**FP_D14, cancelling a shipment leaves its route stop active.** A rule between two entities,
stated in requirements and nowhere on either page.

**FP_D24, the approval modal is not announced and does not trap focus.** Reaching the modal
means pressing "Approve", which is a state-changing control that discovery correctly never
presses — the same limit as PL_D01 above, and for the same reason. Authorizing destructive
testing would reach it.

## The full run on the big application: 9 of 32, and what the 971 failures were

Run `475528a6`, 6,372 tests, finished 2026-11-22 02:15. 5,190 passed, 971 failed, 147
skipped, 64 blocked, 2 errored. **9 of 32 planted defects detected — the same as the
previous full run.** No regression, and no gain: the two fixes made the same evening
(products 37 and 39) were not in the build this run executed, and the six defects in the
section below were never in its scope.

What the run is worth is not the 9. It is the 971.

| What the failure was | Count | Is it the application? |
| --- | --- | --- |
| "You do not have permission to …" on a happy path | 258 | no — the application enforcing a rule |
| An option another test in the run had consumed | 89 | no — contended test data |
| `assertServerEnforces`: the endpoint took what the browser refused | 153 | yes, and this is the oracle working |
| Overflows a small screen | 31 | yes |
| Everything else | 440 | mixed; not yet classified one by one |

The run's own summary read *"931 of 971 were the application behaving wrongly — none of
which matched a planted defect"*. 347 of those 931 were not the application behaving wrongly
at all, and both causes are now fixed as products 40 and 41: each one reports the third
verdict rather than a failure. A tool whose failure list is a third noise is a tool nobody
finishes reading, which is the difference between a score and a product.

The same run filled the disk — 13GB of kept artifacts and 13GB of Playwright scratch that
nothing released — and that is product 42. A third of the kept artifacts were traces and
videos of the 347 executions that had established nothing, so 40 and 41 cut it from both
ends.

**None of the three is measured yet.** They are code with tests, and the next full run is
what turns them into a result.

## Six defects on screens the map never held

Separate from the seven above, and a different kind of limit: these were never missed by an
oracle, because no test was ever generated for them. The screens they live on are not in the
model, so nothing downstream could have reached them. Established from run `475528a6` by
reading the crawl's own log and querying the pages it recorded, rather than inferred from the
score.

The crawl mapped 150 pages and ended with `Stopped: the 900s exploration budget was reached`.

| Defect | Screen | In the map? | Reason |
| --- | --- | --- | --- |
| FP_D13 | `/admin/api-keys` | no | budget — `/admin` was mapped, its children were not |
| FP_D27 | `/admin/audit` | no | budget — same |
| FP_D11 | `/claims/{id}/settle` | no | budget — `/claims` was mapped, no `/claims/{id}` at all |
| FP_D19 | `/claims/{id}/evidence` | no | budget — same |
| FP_D17 | `/customs/declarations/{id}/release` | no | the per-route cap, now fixed |
| FP_D31 | `/api/shipments/{id}` | no | not linked from any document |

**Four of the six are one cause: 900 seconds is not enough for 137 screens.** The crawl
averaged six seconds a page and ran out of time with a deep queue. That is a configuration
limit and not a defect, but it was reported as one line with no magnitude, so a 150-page map
read the same whether it had left four pages behind or four hundred. Fixed as product defect
38: every budget stop now reports the frontier it abandoned.

**FP_D17 was the cap, not the budget, and that one was ours.** Three instances of
`/customs/declarations/{id}` were opened, chosen by document order, and all three were in
states the defect does not live in. The defect needs a rejected declaration, and the
application draws the Release link only while a record is still releasable — so the page is
linked from nowhere, and raising the budget would never have reached it. Fixed as product
defect 39: the crawl now spreads its per-route allowance across the values a column takes.

**FP_D31 is the honest remainder.** `/api/shipments/{id}` is a JSON endpoint no page links
to. The machinery to reach it was built this session and proven on the token-api target —
a JSON collection's identifiers become addresses the crawler tries — but it fires from a
JSON collection the crawl has opened, and on freight the crawl never opened
`/api/shipments`. Reaching it needs either the route listed on the application or the
budget to get that far.

**What this changes about the score.** Six of thirty-two planted defects were never in scope
for the run that missed them, and that is a statement about the map and not about the
oracles. A number quoted without it describes a different experiment from the one that was
performed. The two fixes above are measured on the next full run; until then they are code
with tests and not a result.

Two of the five (FP_D01, FP_D14) want a declared business rule. Two (FP_D03, FP_D04) want a
declared relationship between fields or records. One (FP_D24) wants permission to press a
control that changes state. None of them wants a cleverer pattern match, and an oracle built
without the declaration would report correct applications as broken — which is how the three
criticals, the escalation finding and the twelve header findings described below came to be
removed.

## False findings, which matter as much as true ones

A security tool that cries wolf is not used twice, so each class below was verified by hand
before being removed.

| Was reported | Why it was wrong | Now |
| --- | --- | --- |
| 3 criticals, "protected data is served to an unauthenticated caller" | about a 244-byte shell holding a script tag and nothing else; fifty routes would have given fifty | inconclusive, with the reason |
| "clerk can reach a route intended for inspector", high, confirmed | the route is the form clerks use; the check concluded escalation from "both roles got 200" | inconclusive unless the route names itself administrative, and then marked likely, not confirmed |
| 12 missing-header findings naming `/schedule/schedule` | measured on the 404 page, at URLs that do not exist | measured on the real pages |
| 23 of 43 test failures on the SPA | submissions the application had accepted and acted on | 16 failures, of which 2 are the planted defects |
| 20 missing-token and 20 privilege-escalation findings on freight | the application redirects to the record whether it accepted or refused, so both arms of each check read as accepted; and the scan held no anti-forgery token for it at all, so its control request was refused too | 3 and 2, each verified by hand against the running application |
| 135 rows saying one response header is missing, 16 saying one cookie lacks HttpOnly | the fix is one piece of middleware and one cookie; the row count was the number of pages looked at | 1 row each, carrying the count and the first eight addresses |

The 16 that remain on `clinic-spa` were read one by one. Two are the planted defects. The
rest are real and were not planted: the application crashes with `found.body.map is not a
function` when its session expires, tells the user nothing when the network drops, and shows
a form error that assistive technology would not announce with the field.

## What this does not show

- **Firefox and WebKit are not verified.** The environment's network policy blocks the
  Playwright CDN, so only Chromium is available here. `EXEC-015` and `EXEC-016` say so.
- **One run each.** These numbers are a single run per target, not a distribution, so they
  carry nothing about flakiness.
- **The targets are synthetic.** They were written to have known defects in known places,
  which is what makes a detection rate measurable and also means they are kinder than real
  software: the defects are the ones somebody thought to plant.
- **100% is not reachable and is not claimed.** On the three small targets all twelve planted
  defects are detected on evidence. On the big one, FP_D29 and FP_D11 are not, both for
  reasons established rather than guessed and both written up above as open items.
- **Six of the write-check faults found on 2026-11-26 were found by distrusting a good
  result.** Four of the six were only visible once the fault in front of them was fixed, and
  the intermediate states each produced a more confident wrong answer than the state before.
  Nothing in 249 engine tests, 644 worker tests or 1813 C# tests was red at any point during
  that sequence. A green suite said the checks worked; only running them against an
  application showed what they concluded.
