# Failure diagnosis

When a test fails, AIRA says what kind of failure it is, how confident it is, what the
evidence was, and what to do next. This describes how that verdict is reached — and, since
this phase, what the API was doing when the step failed.

- [The two analysers](#the-two-analysers)
- [What the API was doing](#what-the-api-was-doing)
- [The rules, in order](#the-rules-in-order)
- [Re-analysing a stored failure](#re-analysing-a-stored-failure)
- [Reading the evidence yourself](#reading-the-evidence-yourself)
- [Limitations](#limitations)

## The two analysers

Every failure is classified deterministically first, from its evidence, with no model
involved. The rules' confidence is what decides whether a model is consulted at all: when
the evidence is unambiguous — a 500 response, a connection refused, a locator that matched
nothing — the rules are more reliable than a model would be, and cost nothing.

A model is asked only when the deterministic verdict is below the confidence floor and the
project has AI enabled. Its answer is a refinement, never an override of the run's result:
analysis explains a failure, it does not overturn it.

Every analysis records which produced it, with the provider and model named. An analysis
that says neither who wrote it nor which rules produced it cannot be audited
([BUG-0013](../verification/bugs/BUG-0013/bug.md)).

## What the API was doing

AIRA has always recorded both the steps a test took and the requests the page made. What it
could not do until this phase was say *which step made which request* — the column holding
that link existed and nothing wrote it
([BUG-0020](../verification/bugs/BUG-0020/bug.md)), and the failing step itself was never
identified because the worker streams its actions and the analyser read the completion's
empty list ([BUG-0025](../verification/bugs/BUG-0025/bug.md)).

With both fixed, the diagnosis can say things it could not say before:

```
The step failed because the API call it made returned 500.
  POST /api/session → 500 in 8ms — the fault is in the application or a service it
  depends on, not in the test.
```

instead of

```
The application returned server errors during this execution.
  1 request(s) failed with a 5xx status.
```

The second is true and nearly useless. "Server errors happened somewhere in these twenty
steps" does not tell anyone where to look.

Three windows are considered, in order:

| Window | Why |
| --- | --- |
| **The failing step's own calls** | The direct case. An API test, or a UI step that fetches as it acts. |
| **The step immediately before it** | The common shape of a UI failure: a click starts a fetch and moves on, and the assertion one step later is what notices the page is empty. Reported at slightly lower confidence and worded as "the step before this one", because the causal link is inferred rather than direct. |
| **Anywhere else in the execution** | The fallback, and it says so: "these were not made by the step that failed, so they are a cause rather than the immediate one." |

One step back is a causal chain; three steps back is a coincidence. The window stops at one.

### The interesting negative

The most useful thing correlation says is often that nothing went wrong:

```
The API answered correctly and the page showed something else.
  Every API call the failing step made succeeded (GET /api/dashboard → 200 in 6ms), so
  the data was right and what was rendered from it was not. The defect is in the front
  end rather than the service.
  → Start with the rendering, not the endpoint.
```

That is a diagnosis nothing could produce before, and it saves whoever reads it from
starting in the wrong place.

## The rules, in order

Strongest evidence first, so the most defensible verdict wins rather than the first that
happens to match. Abbreviated; `DeterministicFailureClassifier` is the authority.

| # | When | Verdict | Confidence |
| --- | --- | --- | --- |
| 1 | The execution was blocked | environmentDefect — the test never ran, so this says nothing about the application | 85 |
| 2 | The failing step's own call returned 5xx | applicationDefect, naming the call | 95 |
| 3 | …never completed | networkIssue, naming the call | 90 |
| 4 | …was refused 401/403 *and the locator did not miss* | authenticationIssue | 90 |
| 5 | …was rejected 4xx *and the locator did not miss* | applicationDefect | 85 |
| 6–9 | The same four, one step earlier | as above, worded "the step before this one" | 80–90 |
| 10 | Every call the failing step made succeeded, and an assertion failed | applicationDefect — the front end | 80 |
| 11 | 5xx anywhere in the execution | applicationDefect, "not made by the step that failed" | 90 |
| 12 | A network-level failure anywhere | networkIssue | 85 |
| 13 | 401/403 anywhere *and the locator did not miss* | authenticationIssue | 85 |
| 14 | A healing candidate was found | locatorChange | confidence + 5 |
| 15 | The locator matched more than one element | testDefect | 85 |
| 16 | The locator matched nothing | locatorChange; any 401s are reported as context | 65 |
| 17 | A timeout with console errors | applicationDefect | 70 |
| 18 | A timeout | timingIssue | 60 |
| 19 | An assertion did not hold | applicationDefect | 70 |
| 20 | Console errors | applicationDefect | 60 |
| 21 | Otherwise | unknown — this is where a model earns its cost | 25 |

**The locator guard appears four times on purpose.** A single-page application asks "is
anyone signed in?" as it loads and is answered 401 when nobody is. That is the sign-in page
working, not a symptom, and left ungated it blamed the session for a button that had simply
been removed ([BUG-0015](../verification/bugs/BUG-0015/bug.md)). The 401 is still put in
front of the reader — with the call named — rather than chosen for them.

## Re-analysing a stored failure

```
POST /api/v1/failures/{id}/reanalyse
```

An analysis is a statement made from the evidence available when it was made, and the
evidence outlives it. A failure diagnosed before AIRA could attribute a request to the step
that made it deserves the better answer without anyone re-running the test.

Nothing is re-run. The verdict is rebuilt from the same stored artifacts, so what changes is
only what the platform has learned to read in them.

## Reading the evidence yourself

```
GET /api/v1/testruns/{executionId}         → actions, artifacts, apiCalls, failure, healingEvents
GET /api/v1/testruns/{executionId}/network → every request, with the step that made it
GET /api/v1/testruns/{executionId}/console → every console message, likewise
GET /api/v1/failures?projectId=…           → recurring failures, clustered on their signature
```

`apiCalls` on the execution is the correlation as a person reads it: the failing step and
the request underneath it in one place, rather than two lists sharing a timestamp.

## Limitations

- **Correlation needs the link.** An execution recorded before BUG-0020 was fixed has no
  attribution, and its failures classify exactly as they did — the correlation is additional
  evidence, not a precondition. Re-analysis will not recover it, because the link was never
  written.
- **One step back, no further.** A failure whose real cause is four steps earlier is
  reported as an uncorrelated finding, correctly labelled as not being the immediate cause.
- **Document loads are not API calls.** A navigation that 302s is a page load; counting it
  as a service fault would make every redirect look like an outage.
- **Semantic faults are invisible to correlation.** An endpoint returning the wrong value
  with a 200 is caught by an assertion, not by this. When the assertion catches it and every
  call succeeded, rule 10 at least points at the right half of the system.
- **Failure signatures include the step order** as of BUG-0025. A recurring failure recorded
  before that fix is seen as new once, then settles.

## See also

- [`docs/api-testing.md`](api-testing.md) — API tests and the evidence they record
- [`docs/contract-testing.md`](contract-testing.md) — changes a functional test cannot see
- `verification/evidence/COR-*/`, `FA-*/`, `DET-*/` — the executed evidence
