# BUG-0042 — The robots-respecting default respected nothing

| | |
| --- | --- |
| **ID** | BUG-0042 |
| **Title** | `RespectRobotsTxt` defaulted to true, reached the worker in every discovery job, and was read by no code; the crawler never requested `/robots.txt` |
| **Severity** | **HIGH** |
| **Found by** | Reading the crawl-boundary controls while answering whether the product can be pointed at a live public website |
| **Environment** | See `verification/environment.md` |
| **Build** | `2e7be4c` |
| **Component** | `apps/browser-worker/src/discovery/crawler.ts`, `apps/api/src/QaNxt.Application/Applications/ApplicationService.cs` |
| **Reproduction rate** | Every discovery run, since discovery was written |
| **Status** | Fixed and re-verified |

## What happens

The flag existed everywhere except where it mattered:

```
apps/api/src/QaNxt.Domain/Applications/Application.cs:28       public bool RespectRobotsTxt { get; set; } = true;
apps/api/src/QaNxt.Application/Discovery/DiscoveryService.cs:208   RespectRobotsTxt = application.RespectRobotsTxt
apps/api/src/QaNxt.Application/Discovery/DiscoveryContracts.cs:50  [JsonPropertyName("respectRobotsTxt")] …
packages/shared-types/src/jobs.ts:50                               respectRobotsTxt: boolean;
```

and then nothing. A search of the worker's own source for the flag, or for the word at all,
returned one line — a test fixture setting it to `false`:

```
$ grep -rn "respectRobots\|robots" apps/browser-worker/src/
(no matches)
```

So the crawler never fetched `/robots.txt`, never parsed one, and opened every path inside the
domain allowlist regardless of what the site published. Meanwhile:

```
docs/architecture-assessment.md:85
| Uncontrolled crawling of a third-party site | Domain allowlist, depth, page count,
  action count, wall-clock budget, robots-respecting default, normalized-URL dedup,
  loop detection |
```

A documented control, defaulted on, enforced nowhere. On the demo bank and the lab this costs
nothing — they are ours. It is the only control in that list that exists for somebody else's
application, so it is exactly the one that matters the first time the target is a live site.

## The second half: the flag could not be changed

`ApplicationDetail` returned `RespectRobotsTxt`, but neither `CreateApplicationRequest` nor
`UpdateApplicationRequest` carried it, and the console's application form had no field for it.
The value was readable, defaulted to `true`, and permanently stuck there.

That was harmless only while nothing read it. Enforcing the flag without making it settable
would have been worse than leaving it unenforced: a site whose `robots.txt` answers 5xx fails
closed, so the application would have become permanently unexplorable with no way to say
otherwise.

## Fix

**Enforcement** — `apps/browser-worker/src/security/robots.ts`, called from the crawler in the
same place as the SSRF guard and the exclusion list, before each navigation. Follows RFC 9309
where it is specific: group selection by user-agent with `*` as the fallback, `Allow` and
`Disallow` as path patterns with `*` and `$`, longest matching pattern wins and `Allow` wins a
tie, 4xx means no rules exist, 429 and 5xx mean the rules are unknown.

An unreadable `robots.txt` fails closed, and says so in the exploration log:

```
robots.txt at https://site.test answered 503, so its rules are unknown and nothing there is
crawled. Set "respect robots.txt" off on the application to explore it anyway.
```

Failing closed is the deliberate choice: a site that cannot tell us what it does not want
crawled has not consented to all of it. A refusal nobody can read, though, is indistinguishable
from an application with no pages, so the reason and the remedy are both in the log.

`robots.txt` is fetched once per origin per run, through the browser context's own request API
so it shares the crawl's cookies and proxy. Concurrent asks for one origin share a single
in-flight fetch.

**Settability** — `respectRobotsTxt` is now accepted on create and on update, and is a checkbox
in the console's application form. Turning it off is a decision about somebody else's
application, so it is written to the audit log with who made it; leaving it on is not audited,
because a default nobody chose is not a decision and would bury the entries that are.

**Visibility and change afterwards** — there is no separate application detail route; the card
on the Applications page is the detail view. It now says which way the setting is: quiet prose
when robots.txt is respected, and a badge when it is not, because that is the state where a
crawl ignores what the site asked for and somebody reading a list should not have to parse a
sentence to find it. A checkbox beside **Run discovery** changes it, and the off direction
confirms first, naming the application and saying the change is recorded. The state is shown
to anybody who can read the page; only `application:write` gets the control. `RespectRobotsTxt`
had to join `ApplicationSummary` for any of this: it was on `ApplicationDetail` only, and the
list endpoint is what the cards are built from.

## Two approximations, both documented

| | |
| --- | --- |
| **Group selection** | The worker drives a real browser and sends a real browser's user-agent, so there is no bot token to match on. A group header matches when its token appears anywhere in that user-agent string. A site writing `User-agent: Chrome` is therefore honoured — wrong in the direction of honouring more rules, not fewer. |
| **`Crawl-delay`** | Honoured, capped at 10 seconds. It is not in RFC 9309 but is widely published, and an unbounded one would spend a whole exploration budget waiting. The log records when the cap applied. |

Both are in `docs/compatibility.md` under *Application shapes → robots.txt*, with what is
verified and what is not.

## Regression tests

`apps/browser-worker/test/robots.test.ts` — 33 tests. 29 drive the parser and the per-origin
policy directly; 4 drive a real Chromium against a local server that publishes

```
User-agent: *
Disallow: /private
Allow: /private/brochure
```

and assert that `/private/accounts` is not mapped, that `/private/brochure` still is, that the
log names the rules it read, and that the same crawl with the flag off does map
`/private/accounts`. That last one is the other half of the proof: without it, an absent page
could be a crawl that failed to find the link rather than a rule being honoured.

Against the unfixed crawler, with the module present but never called:

```
FAIL  does not map a page robots.txt disallows, and says why
AssertionError: expected [ '/', '/open', …(2) ] to not include '/private/accounts'

FAIL  records which rules it read
AssertionError: expected '[…] robots.txt…' to contain '1 disallow and 1 allow rule(s)'
```

A stub would not have caught the original defect. The parser did not exist, but neither did
the call, and only one of those is visible from a unit test.

`apps/api/tests/QaNxt.IntegrationTests/RobotsPolicyTests.cs` — 7 tests on the settability half,
asserting the stored row as well as the response, because the worker reads the row. The seventh
covers the summary the cards are built from, and asserts both states: a field hardcoded to one
value satisfies an assertion on that value alone, which an earlier draft of it did. Four of the
seven fail against the unfixed service:

```
Failed The_flag_can_be_changed_afterwards_and_the_change_is_audited
  Expected (StoredFlagAsync(created.Id)) to be False, but found True.
```

`apps/web-console/src/pages/ApplicationsPage.test.tsx` — 9 tests. Three on the form: the box is
on by default and the form states the consequence, and the request body carries `true` when it
is left alone and `false` when it is unchecked. Six on the card: each state as it is rendered,
the confirmation before turning it off, that declining it sends nothing, that turning it back
on needs no confirmation, and that the state is still visible without `application:write`
while the control is not. All six fail with the card changes removed.

Removing only the one line of the form that reads the checkbox fails two of the three form
tests:

```
× sends true when left alone     AssertionError: expected undefined to be true
× sends false when unchecked     AssertionError: expected undefined to be false
```

The `undefined` is the point: an unchecked checkbox submits no field at all, so reading the
absence as "not specified" would have left the default on and discarded the choice silently.

## Suites after the fix

| | |
| --- | --- |
| .NET unit | 896 passed |
| .NET integration | 67 passed (60 before, 7 added) |
| Node | 313 passed across five packages: 141 in the worker (108 before, 33 added) and 64 in the console (55 before, 9 added) |
