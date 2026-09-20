# The autonomous agent

The agent makes one bounded pass over an application: it explores, works out where the risk
is, writes tests for what is uncovered, runs them, looks at what failed, and writes up what
it found.

Then it stops and waits for a person.

## What it is not allowed to do

This is the most important part of the design, so it comes first.

The agent **cannot**:

- delete or disable a test
- change an existing test's steps or assertions
- approve a healing proposal or apply one to a stored test
- create or change a quality gate rule
- raise a defect
- mark a failure as anything other than a failure
- reach any URL outside the target application's allowed domains
- execute a script in a browser, or a command on a server
- exceed the page, test, time or model-spend bounds its pass was started with

What it **can** do is additive and reversible: explore within the crawl budget, create new
tests, run tests, and record findings. Everything it concludes is a proposal with its
evidence attached, and a person decides what happens next.

That narrowness is deliberate. An agent that could quietly relax a gate or rewrite an
assertion to make a test pass would be worse than no agent, because its output would stop
being evidence of anything.

## The loop

Each phase is recorded as it happens, with the reasoning behind it, because nobody watched
the run and its conclusions are worth nothing if they cannot be read back.

| Phase | What happens |
| --- | --- |
| **Explore** | Starts a bounded crawl and waits for it. If exploration is disabled, or the crawl cannot start, the pass continues from the existing knowledge graph and says so. |
| **Model** | Reads the graph. This is the agent's entire picture of the application — it does not browse to form one. |
| **Prioritize** | Scores every page deterministically and picks the top areas. |
| **Generate** | Creates tests for prioritised areas that have *no* coverage. It does not duplicate coverage that exists. |
| **Execute** | Runs what it generated, to find out whether those tests hold against the application as it is now. |
| **Investigate** | Reads the failures and their analyses, and records each as a proposal. |
| **Propose** | Adds regression and instability findings from execution history, then writes the summary. |

Between every phase the agent checks three things: the wall clock, the model spend, and
whether somebody cancelled. Hitting one stops the pass and names which one, so "the agent
found nothing else" is never confused with "the agent ran out of budget".

## Bounds

Every pass is bounded. A pass started with no options at all is still bounded — defaults
exist so the careless path is also the safe one. Values above the ceiling are clamped rather
than rejected: the point of a bound is that it cannot be argued with.

| Bound | Default | Ceiling |
| --- | --- | --- |
| Pages explored | 25 | 200 |
| Crawl depth | 3 | 6 |
| Areas worked on | 5 | 25 |
| Tests generated | 15 | 100 |
| Wall clock | 900s | 3600s |
| Model spend | $1.00 | $20.00 |

Exploration and execution can each be turned off, which is how you get a read-only pass that
only scores risk and proposes.

The bounds are copied onto the run when it starts. Nothing downstream re-reads
configuration, so an agent in flight cannot have its limits widened underneath it, and a
finished run stays explainable after someone changes the defaults.

One pass runs per application at a time. An agent competes with real users for the same
browser workers, and a platform that starves interactive runs to do speculative work has its
priorities backwards.

## How risk is scored

Deterministically, and with every point attributed to a named factor. A risk number that
changes when a model is re-prompted cannot be used to prioritise work, and a team that
cannot see why an area scored highly will not act on it.

| Factor | At most | What it means |
| --- | --- | --- |
| No test coverage | 22 | Nothing tests this route, so there is no evidence it works and no warning when it stops |
| Changes data | 20 | Inputs, submits, credentials, uploads — a defect here writes something wrong rather than displaying something wrong |
| Recent failures | 20 | Proportional to the failure rate of executions touching the route |
| Authentication boundary | 18 | The sign-in page fails closed for every user at once |
| Open defects | 12 | Failures attributed to the application that are still open |
| Unstable results | 10 | Verdicts that changed without the code changing |
| Recently changed | 10 | Element churn since the last exploration — areas being worked on are the areas that break |
| Errors in the browser | 8 | The application reporting a defect about itself |
| Many journeys pass through | 8 | A failure here blocks more than one journey |
| Slow to load | 5 | More likely to time out, and more likely to lose a user |

The weights encode a judgement worth stating plainly: **what a failure costs matters more
than how often it happens.** An untested payment form outranks a flaky marketing page, even
though the marketing page fails more often, because the payment form failing is the one that
ends up in a newspaper.

Scores are capped at 100. Levels are: 70+ critical, 45+ high, 20+ medium, below that low.

## Regression intelligence

"Failed" is not actionable on its own. A test failing for the first time this morning and
one failing for three weeks need different responses, and a test that alternates needs
fixing before either verdict is worth reading.

| Reading | Means |
| --- | --- |
| **Regressed** | Failing now after a stable run of passes. Something changed — the most actionable signal the platform has. |
| **Chronic** | Failing for four or more consecutive runs. Known, not news. |
| **Unstable** | Changing verdict repeatedly without the code changing. Fix the test before reading its result. |
| **Recovered** | Passing again after failures. Worth saying: a fix landed. |
| **Stable** | Passing, and has been. |
| **Unknown** | Fewer than three runs of history. Said plainly rather than guessed at. |

Two rules hold throughout. Instability never turns a failure into a pass — an unstable
failing test is still failing, it is just also untrustworthy. And a single break-and-fix
cycle is not instability: that is a test behaving exactly as it should, and a platform that
called it unstable would be crying wolf.

Only *regressed* and *unstable* become findings. Stable, recovered and unknown are noise on
a page meant to be acted on.

## Using it

From the console: **Agent → Start a pass**. Starting one needs the `agent:run` permission,
which is separate from running tests — an agent explores on its own and spends a model
budget doing it. Reading what a pass concluded needs only `test:read`, because proposals are
for people to look at.

From the API:

```bash
curl -X POST "$AIRA_API_URL/api/v1/agent/runs" \
  -H "authorization: Bearer $AIRA_TOKEN" \
  -H 'content-type: application/json' \
  -d '{
        "applicationId": "…",
        "objective": "Payments and statements",
        "maxPages": 25,
        "maxGeneratedTests": 15,
        "timeBudgetSeconds": 900
      }'
```

The call returns immediately with a queued run; the pass runs in the background. Poll
`GET /api/v1/agent/runs/{id}` for its phase, its steps and its findings, or
`POST /api/v1/agent/runs/{id}/cancel` to stop it.

`objective` steers prioritisation and generation. It is advisory — it cannot widen what the
agent is allowed to do.

## If the platform restarts mid-pass

A pass left running by a restart is marked failed rather than resumed. The loop is not
idempotent part-way through — resuming would generate a second set of tests — and a truthful
failure is better than a duplicate. Start a new pass.
