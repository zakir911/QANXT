# What QA NXT has been run against

Every claim about how the platform behaves comes from running it against something. This is
the list of those somethings, and — the part that matters more — the list of what it has
never been pointed at.

The distinction the brief asks for is kept throughout: **VERIFIED** means it ran and the
expected behaviour was observed with evidence; **NOT TESTED** means nothing covers it. There
is no third state where something is assumed to work because it resembles something that does.

## Applications

| Application | What it is | Who wrote it | Status |
| --- | --- | --- | --- |
| **banking-app** (:4300) | React SPA — async data, modals, pagination, validation | Written for QA NXT | VERIFIED |
| **ecommerce-app** (:4310) | Multi-step dependent journey, plus a silent-failure case | Written for QA NXT | VERIFIED |
| **forms-app** (:4320) | Dependent fields, cross-field rules, file-size limits | Written for QA NXT | VERIFIED |
| **dynamic-app** (:4330) | Regenerated ids, changing hierarchy, lazy panels, infinite scroll | Written for QA NXT | VERIFIED |
| **failure-app** (:4340) | Every failure class: 4xx, 5xx, timeout, dropped connection, JS error | Written for QA NXT | VERIFIED |
| **self-healing-app** (:4350) | Healing that should happen, and four cases where it must be refused | Written for QA NXT | VERIFIED |
| **security labs** (:4400–4408) | Planted flaws across the OWASP categories, and corrected twins | Written for QA NXT | VERIFIED |
| **demo-bank** | The product demo application | Written for QA NXT | VERIFIED |
| **Verdaccio 6.10.4** | Private npm registry — Vue over Express | **Independent** | VERIFIED, once, partly — see below |

Everything above the last row was written alongside the platform that tests it. That is the
right way to build a test platform and it establishes nothing about unfamiliar code. **One**
application in this table was written by people who have never heard of QA NXT.

### What the Verdaccio pass covered, and did not

| | |
| --- | --- |
| Pages the crawl reached | 4 |
| Endpoints the crawl reached | 7 — all of them the web UI's own `/-/verdaccio/data/…` calls |
| The npm registry protocol (`GET`/`PUT /:package`, `/-/user/…`, dist-tags) | **NOT TESTED** |
| Tests generated, executed, passed | 11 / 11 / 11 |
| Defects found in Verdaccio | 0 |
| Defects found in QA NXT | 2 — see `pilot/PILOT-REPORT.md` |

The registry protocol is Verdaccio's actual product surface and the pass never touched it,
because discovery works by driving a browser and no browser calls it. On any application
whose primary surface is an API a browser does not drive, an autonomous pass tests what the
browser can see and is silent about the rest.

## Browsers

| Browser | Status |
| --- | --- |
| Chromium | VERIFIED |
| Firefox | **NOT VERIFIED** |
| WebKit | **NOT VERIFIED** |

Firefox and WebKit are supported in code — the worker's browser pool launches all three, and
a run can be started with any of them — but neither has ever executed a test here. `EXEC-015`
and `EXEC-016` attempt a real run against each and report NOT VERIFIED with the reason: the
binaries are not installed in this environment and the Playwright CDN is unreachable, so they
cannot be downloaded.

That is the right outcome for those tests and the wrong thing to read as support. A browser
whose binary has never been launched is untested, and the earlier draft of this page called
both VERIFIED from memory — which is exactly the mistake this table exists to prevent.

## Application shapes

| Shape | Status | Note |
| --- | --- | --- |
| Client-rendered SPA (React, Vue) | VERIFIED | The lab and Verdaccio |
| Form-heavy application with rules | VERIFIED | forms-app |
| Multi-step dependent journey | VERIFIED | ecommerce-app |
| Unstable DOM — regenerated ids, lazy content | VERIFIED | dynamic-app |
| REST API discovered by watching a browser | VERIFIED | Every lab app, and Verdaccio |
| Server-rendered multi-page application | **NOT TESTED** | Nothing in the lab is one |
| An API with no browser front end | **NOT TESTED** | Discovery has no way to reach one |
| GraphQL | **NOT TESTED** | |
| WebSocket or server-sent events | **NOT TESTED** | |
| Canvas, WebGL or a custom rendering surface | **NOT TESTED** | |
| Native mobile, or a mobile web view | **NOT TESTED** | |
| An application behind SSO or an identity provider | **NOT TESTED** | Only form login is exercised |
| Multi-factor authentication | **NOT TESTED** | |
| An application larger than a 25-page crawl | **NOT TESTED** | Every application tested is small |

### robots.txt

Discovery enforces an application's `robots.txt` when the application asks it to, which is
the default. Two things about that enforcement are approximations, and are worth knowing
before you point a crawl at a site you do not run:

| | Status | Note |
| --- | --- | --- |
| `Disallow`, `Allow`, longest-pattern-wins, `*` and `$` | VERIFIED | Parsed and enforced; a real crawl against a server publishing rules is in `test/robots.test.ts` |
| A missing `robots.txt` (404) permits everything | VERIFIED | |
| An unreadable `robots.txt` (429, 5xx, a failed request) permits nothing | VERIFIED | Fails closed, and the exploration log says why |
| Group selection by user-agent | **APPROXIMATE** | The worker drives a real browser and sends a real browser's user-agent, so there is no bot token to match on. A group header matches when its token appears anywhere in that user-agent string, which can select a group a site did not mean for us. It errs towards honouring more rules, not fewer. |
| `Crawl-delay` | **CAPPED AT 10 SECONDS** | Honoured up to the cap. A longer delay would spend a whole exploration budget waiting; the exploration log records when the cap applied. |
| A site that serves different rules per path or per request | **NOT TESTED** | `robots.txt` is read once per origin per run |

## Environments

| | Status |
| --- | --- |
| Local, loopback | VERIFIED |
| A registered non-production environment | VERIFIED |
| An environment nobody has described | VERIFIED — observation permitted, writes refused |
| **Production** | **NOT TESTED.** Only the refusal is verified. The permitted form of a production pass has never been exercised, and nothing establishes what it would do. |

## The autonomous agent specifically

| | Status |
| --- | --- |
| A full pass, questions answered, against the lab | VERIFIED — 253 golden tests |
| A full pass against an independent application | VERIFIED — once, on Verdaccio |
| A pass resumed after stopping for a person | VERIFIED |
| A pass against a broken, unreachable or unauthenticated application | VERIFIED |
| A pass under a live model provider | **NOT TESTED.** Spend is $0 throughout: the deterministic planner was used. The cost ceiling is verified as a bound, never as a bound that has bitten. |
| A pass with destructive actions permitted | **NOT TESTED.** Only the refusal is verified. |
| Concurrent passes over different applications | **NOT TESTED** |
| A pass over an application with recorded journeys | **NOT TESTED.** Every pass so far had none, and each said so. |

## The model provider

**No model provider has been configured in any run recorded here.** `AI_PROVIDER=local`
throughout, so every test the platform generated came from the built-in deterministic
planner, and `GEN-016` records NOT VERIFIED for the model-backed path with that reason.

This affects more than the agent's spend figure. Test generation, failure analysis and the
insights page all have a model-backed path and a deterministic one, and only the
deterministic one has ever run here. Where a report says a model contributed nothing, that is
accurate and is not evidence that the model-backed path works.

## Scale

Nothing here has been run at scale. The largest application tested has 25 pages; the largest
pass generated 12 tests. Timings in any report describe these sizes and should not be
extrapolated.

## How to read this page

A row marked NOT TESTED is not a row marked broken. It means nobody has established anything,
and the platform should not be described as supporting it. Where a capability exists in code
but nothing reaches it, that is recorded in `verification/reports/AUTONOMOUS-QA-REPORT.md`
under "Implemented, not verified end to end" rather than counted as delivered.
