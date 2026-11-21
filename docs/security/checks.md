# The checks

Every check follows the same shape: establish a control, then make the claim. A refusal
proves nothing without a control — an endpoint that answers 404 to everybody is broken, not
secure, and a scanner that cannot tell those apart reports a broken application as hardened.

Where a check cannot establish its control it returns **inconclusive**, with the reason. That
is not a pass, and it is not a finding.

## The names have to agree in four places

The attack surface says which checks apply, the selector says which to run, the scan record
says which executed, and the gate reads coverage from that record. A check named one way in one
of those and another way somewhere else produces a gate reporting full coverage from a scan
that ran nothing — a false green arriving through a typo.

The first three share one constant, `SecurityChecks`, and `SECPL-027` holds that against the
engine's roster. The fourth is the worker's runner map, whose keys are string literals and are
what a scan actually dispatches on; three tests in the worker hold it against that same
constant, in both directions. A drift there is reported honestly, as a check that did not
execute, which is precisely why it needs a test: coverage drops by one for ever and nothing
else fails.

## Authorization — `checks-authz.mjs`

| Check | Control | Claim | CWE |
| --- | --- | --- | --- |
| `checkBola` | the owner reads their own object and gets 200 | a non-owner gets 200 *and the owner's identifier is in the body* | CWE-639 |
| `checkVerticalEscalation` | the privileged role reaches the route | a lesser role reaches it too, **and the route names itself administrative** | CWE-285 |
| `checkReadOnlyWrite` | an account that should write, writes | a read-only account writes too | CWE-269 |
| `checkMissingAuthorization` | the owner reads it | an unauthenticated caller reads it too **and something came back** | CWE-862 |
| `checkTokenVerification` | the endpoint refuses an anonymous request | it accepts a bearer value it never issued | CWE-345 |

The BOLA check requires the owner's identifier to appear in the intruder's response body. A
200 carrying an empty list is not a leak, and calling it one is how a scanner loses its
reader.

`checkTokenVerification` reports inconclusive when the endpoint answers 200 to an anonymous
request — accepting a forged token says nothing about token verification if nothing is
verified at all. That is a missing-authorization finding instead, reported separately.

`checkVerticalEscalation` reported on "both roles got 200" alone, which is what an
authenticated collection looks like on every application: most routes are reachable by every
role, so a scan raised one finding per collection, each titled "a route intended for the
administrator" about a route intended for everybody. A permit register raised it on the form
clerks use to file applications.

The route's own name is the only evidence available without discovering the application
separately as each role, which this engine does not do. So a route naming itself
administrative — `/admin`, `/users`, `/settings`, `/audit-log` — still produces the finding,
marked **likely** rather than confirmed because a naming convention is not proof. Anything
else is inconclusive, saying that both roles reached it and that nothing about the route says
it was meant to be restricted. The stronger version of this check is the application's own
interface: a control the privileged user is shown and the lesser user is not is the
application declaring the route restricted.

`checkMissingAuthorization` requires that the anonymous caller **received data**, not merely a
200. On an application rendered in the browser every route answers 200 with the same empty
shell to everybody, and the data arrives separately over an API, which does refuse. Reading the
status alone, a scan of a three-screen application raised three criticals about a 244-byte
document holding a script tag and nothing else; fifty routes would have raised fifty.

A body counts as data when it is JSON with fields in it, or markup with more than a page
title's worth of visible text. A JSON error envelope does not count, and a shell shipping
kilobytes of bundled script is still a shell. Where nothing was served the answer is
inconclusive with the reason given — not a pass, which would read as "checked, and safe".

## Authentication and session — `checks-auth.mjs`

| Check | What it compares | CWE |
| --- | --- | --- |
| `checkUserEnumeration` | two failed sign-ins: one for a real account, one for an absent one | CWE-204 |
| `checkAccountLockout` | six failed sign-ins, bounded, looking for a 429 that never comes | CWE-307 |
| `checkSessionInvalidation` | a token before sign-out, the sign-out, the same token after | CWE-613 |
| `checkSessionLifetime` | the lifetime the application *declares* | CWE-613 |
| `checkResetTokenReuse` | the same reset token, twice | CWE-640 |

Enumeration compares **response shape**, not bytes: status, field names, and the stated
reason, with the submitted username masked and high-entropy values dropped. Comparing bodies
literally would flag any application that returns a nonce or echoes the username back, which
is most of them.

`checkSessionLifetime` reads a declared TTL rather than waiting one out. A scanner cannot
observe a 30-day expiry without waiting 30 days, and the finding says the lifetime was
declared rather than witnessed.

`checkSessionInvalidation` uses DELETE, so the scope guard classifies it as destructive. Under
an ordinary scope it is refused, and the refusal is recorded.

## API security — `checks-api.mjs`

| Check | What it needs before reporting | CWE |
| --- | --- | --- |
| `checkMassAssignment` | the privileged field comes back **as applied**, not merely accepted | CWE-915 |
| `checkInputValidation` | all three probes accepted — wrong type, empty, oversized | CWE-20 |
| `checkUnsafeMethods` | an unauthenticated DELETE succeeds on an object the check created | CWE-650 |
| `checkRateLimit` | fifteen requests, none refused | CWE-770 |
| `checkExcessiveData` | a response field *named* like a secret | CWE-213 |
| `checkErrorDisclosure` | an unparseable identifier answered with a 5xx or a stack frame | CWE-209 / CWE-20 |

One accepted validation probe is not a finding — plenty of fields legitimately take an empty
string or a number. All three together mean the field is not validated at all.

`checkExcessiveData` matches on field names rather than values, because a value that looks
like a secret usually is not one and a field called `passwordHash` always is. The values
themselves never reach the finding.

`checkErrorDisclosure` puts three shapes of unparseable identifier into an endpoint's `{id}` —
a word, a negative number, three hundred characters — and reads what comes back. It reports on
two separate grounds, because the remediations differ: the endpoint **failed** where it should
have refused (a 5xx, CWE-20), and the endpoint **disclosed** its internals (a stack frame in the
body, CWE-209). An application can do one without the other. Every probe is a GET and none of
them is attack-shaped: this is error handling, and a probe that looked like an exploit attempt
would be refused by the scope guard for the wrong reason.

## Cross-site scripting — `checks-xss.mjs`

A finding needs three things **together**:

1. the response is HTML, by content type;
2. the marker appears in it;
3. the marker's angle brackets and quotes survived unencoded.

Miss any one and there is no finding. This is what separates `/search` (reflected raw) from
`/greet` (reflected escaped) and `/echo` (reflected into JSON). Reflection alone is never
reported as XSS — the brief names this case, and it is the one that decides whether anyone
trusts the tool.

The markers are inert: no network callback, no cookie read, no navigation. Nothing is asked to
execute, and the finding rests on the encoding of the response rather than on observed script
execution — which it says.

`checkDomXss` returns `notTestable`. See [limitations](limitations.md).

## Injection — `checks-injection.mjs`

| Check | Indicator | CWE |
| --- | --- | --- |
| `checkSqlInjection` | a database error signature, **and/or** a tautology widening the result set against a baseline | CWE-89 |
| `checkNoSqlInjection` | a string value refused while an operator object is accepted | CWE-943 |
| `checkCommandInjection` | one metacharacter producing a shell-shaped error | CWE-78 |
| `checkTemplateInjection` | `{{7*7}}` returning 49, against a baseline that did not contain 49 | CWE-1336 |

Two of those are comparisons rather than payloads. A tautology is only evidence if the same
query without it returned fewer rows; 49 is only evidence if 49 was not already in the
response. Both baselines are taken first, and a check that cannot take its baseline reports
inconclusive.

Error signature alone is Medium confidence — applications return database errors for input
they simply did not expect. Error signature *and* a widened result set is High.

## Request handling — `checks-request.mjs`

| Check | Control | CWE |
| --- | --- | --- |
| `checkCsrfToken` | the request with a token succeeds | CWE-352 |
| `checkOriginValidation` | the same-origin request succeeds | CWE-352 |
| `checkUploadRestrictions` | — (three independent probes) | CWE-434, CWE-770, CWE-22 |
| `checkOpenRedirect` | a relative destination is accepted | CWE-601 |
| `checkSsrf` | an external destination, to see what the endpoint does with one | CWE-918 |

Where the control fails, the result is inconclusive. An endpoint that refuses the request
*with* a token proves nothing about what it does without one.

## Passive — `checks-passive.mjs`

| Check | What it reports | What it deliberately does not |
| --- | --- | --- |
| `checkSecurityHeaders` | missing CSP, HSTS, frame options, content-type options | headers that do not apply to the response type |
| `checkCookies` | a *session* cookie missing HttpOnly / SameSite / Secure | a UI preference cookie missing them — that is how preferences work |
| `checkCors` | an arbitrary origin reflected **while credentials are allowed** | a wildcard origin with no credentials, which is how a public API works |
| `checkSensitiveData` | credentials, keys and stack traces by pattern, with context; **personal data** whose own check digits confirm it | `example@example.com`, `your-api-key`, anything already redacted; email addresses and telephone numbers |
| `checkMisconfiguration` | `/debug`, `/files`, `/app.js.map`, `/.env` when reachable | anything that answered something other than 200 |

The CORS line is the one the brief names explicitly: reflecting an arbitrary origin is
ordinary, and reflecting one *while allowing credentials* is how another site reads a
signed-in user's data. Only the pair is a finding.

A stack trace is its own finding class (`VerboseErrorDisclosure`, CWE-209) rather than generic
sensitive data, because it has its own remediation and its own audience.

### Stack traces

One runtime's format is not the pattern. This matched `at Namespace.Method(args) in
/path/File.cs:line 42` — .NET, and nothing else — so a Node application answering with
`at handler (/srv/app.js:42:17)`, a Java one with `at com.acme.Orders.read(Orders.java:42)`, a
Python traceback, a PHP frame list or a Ruby backtrace all passed unreported. Measured on two
targets at once: an order API returning a Node stack to an unparseable id, and the same leak in
a freight application's API.

Each alternative is anchored on something only a frame has — a path with a line *and* a column,
a file in parentheses with a line, the `Traceback` header — so prose that happens to contain the
word "at" does not match. The pattern is exported, and the test imports it rather than
declaring its own copy: a test carrying a copy would not have caught the original defect.

### Personal data

`PersonalDataExposure` reports a payment card number, an IBAN, a UK national insurance number
or a US social security number served in a response. Each is **checked, not matched**: Luhn for
a card, mod-97 for an IBAN, the issuing rules for a national insurance number, the issued
ranges for a social security number. That arithmetic is the whole reason the precision holds —
a sixteen-digit invoice reference is not a card number and the check knows it.

Email addresses and telephone numbers are deliberately absent. A support address in a footer is
not a leak, and a detector that reports one teaches its readers to skim, which costs more than
the finding is worth.

Distinct values are counted as well as matched. One identifier on a page about one person may be
that person's own record; eleven on one page is a register nobody meant to publish, and it is
reported a band higher. No finding quotes the value: a sample is masked, because a report that
reproduces the data copies the leak.

This check reads the page **as a signed-in identity** where the scan was given one. Read
anonymously it would examine whatever the application shows a stranger — on anything behind a
sign-in, the sign-in page — and report it clean.
