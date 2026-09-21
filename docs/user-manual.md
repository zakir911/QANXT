# AIRA user manual

How to use the platform, screen by screen.

This assumes AIRA is installed and running. If it is not, start with
**[the installation guide](installation.md)**.

Every screenshot here is of the real product, holding real results. They were captured by
driving a live installation, not assembled by hand — see
[About these screenshots](#about-these-screenshots) at the end.

---

## Contents

1. [What AIRA does](#1-what-aira-does)
2. [Getting around](#2-getting-around)
3. [Setting up a workspace](#3-setting-up-a-workspace)
4. [Discovery: teaching AIRA the application](#4-discovery-teaching-aira-the-application)
5. [Getting tests](#5-getting-tests)
6. [Running tests](#6-running-tests)
7. [Reading a result](#7-reading-a-result)
8. [When a test fails](#8-when-a-test-fails)
9. [When the application changes: self-healing](#9-when-the-application-changes-self-healing)
10. [The autonomous agent](#10-the-autonomous-agent)
11. [Asking questions](#11-asking-questions)
12. [The Verification Center](#12-the-verification-center)
13. [Settings: people, providers and quality gates](#13-settings-people-providers-and-quality-gates)
14. [Running from a pipeline](#14-running-from-a-pipeline)
15. [Glossary](#15-glossary)
16. [What AIRA will not do](#16-what-aira-will-not-do)

---

## 1. What AIRA does

AIRA tests a web application by driving a real browser, and keeps the evidence.

The loop it runs, and which section of this manual covers each part:

```
   Register an application  ──▶  Discover it        ──▶  Get tests        ──▶  Run them
        (§3)                       (§4)                    (§5)                 (§6)
                                                                                  │
   Approve or reject a repair ◀──  Understand why  ◀──  Read the evidence  ◀──────┘
        (§9)                          (§8)                  (§7)
```

Two ideas run through all of it, and the product is easier to use if you know them:

- **A pass means it ran.** The action executed, the expected behaviour was observed, the
  assertion held, and there is evidence. AIRA would rather tell you it could not check
  something than tell you it passed.
- **Nothing changes itself without asking.** The agent proposes; a repaired locator is a
  suggestion until you approve it; the platform never edits your tests behind your back.

---

## 2. Getting around

Sign in at `http://localhost:5173`.

![The AIRA sign-in page with an email and password filled in](images/manual/01-sign-in.png)

Once you are in, two controls in the top bar matter more than anything else:

| | |
| --- | --- |
| **Project** | Almost every page shows one project at a time. If a page looks empty, check this first. |
| Your name / **Sign out** | Your account and role live under **Settings**. |

The **dashboard** is the landing page. It computes everything from stored executions — there
are no estimates on it — and says so plainly when nothing has run yet.

![The quality dashboard showing pass rate and execution counts from real runs](images/manual/02-dashboard.png)

---

## 3. Setting up a workspace

### Create a project

**Projects → New project.** A project groups applications, tests and runs, and carries
settings such as the healing policy and what evidence to capture.

The **key** you choose (`BANK`, `RETAIL`) appears in every test reference and in the CLI, so
keep it short.

![The projects page listing a project with its key](images/manual/03-projects.png)

### Register the application under test

**Applications → Add an application.**

| Field | What to put in it |
| --- | --- |
| **Name** | What your team calls it. |
| **Base URL** | Where the crawl starts. **Point this at a page behind the sign-in**, such as `/dashboard` — see the warning below. |
| **Login URL** | The sign-in page. |
| **Credentials** | A test account. Encrypted before storage; the API never returns them, and a password typed during a run is stored as `***REDACTED***`. |
| **Allowed domains** | Where AIRA may go. Anything else is refused, and a test that tries is reported `blocked` rather than failed. |

![The applications page listing the registered Demo Bank application](images/manual/04-applications.png)

> **Choose the base URL with care.** AIRA crawls outward from it. If the root of your
> application bounces every visitor to the sign-in page, a crawl starting there can reach
> exactly one page — and discovery will report "completed" while it does it. Give it a page
> a signed-in user would land on.

---

## 4. Discovery: teaching AIRA the application

Everything downstream works from a model of your application, and discovery is what builds
it. **Discovery → run it** against an application.

AIRA signs in with the credentials you stored, crawls within the bounds you set, and records
each page, the elements on it, how pages link to each other, and the API calls the pages make
while it drives them.

![The discovery page showing a completed crawl](images/manual/06-discovery.png)

Open the model from **Applications → (your application) → map**:

![The application map: nine pages grouped by depth, each with its kind, element count and whether it needs authentication](images/manual/05-application-model.png)

Worth understanding here:

- **Pages are grouped by how many clicks they are from the entry point.** Depth is what the
  crawl bounds limit.
- **Each page has a kind** — login, list, form, dashboard, settings. The test generator uses
  this to decide what kind of test is worth writing.
- **`authenticated`** marks pages only reachable when signed in.
- **Elements carry a preferred locator** — a test id, a role and name, or a label — rather
  than a position in the page structure. This is what makes a test survive a redesign, and
  what self-healing later reasons about.

Re-run discovery whenever the application changes shape. It does not overwrite your tests.

---

## 5. Getting tests

Two ways in, and they coexist.

### Generate them from a requirement

**Test cases → Generate.** Write the requirement in plain English — *"Customer can sign in
and view their account balance"* — and AIRA plans tests against the model discovery built.

![The test case list, showing generated and imported tests](images/manual/07-test-cases.png)

Open one to see exactly what it will do. A generated test is not a black box: every step
names its action, its target and its expectation, and you can edit it.

![A generated test case showing its steps, targets and assertions](images/manual/08-generated-test.png)

> **Read generated tests before you trust them.** They are a first draft written from the
> model, not from your intent. Where AIRA cannot tell what a success looks like, it says so
> in the expected result rather than inventing an assertion — a test that cannot fail is
> worse than no test.

**With no model provider configured**, generation uses AIRA's built-in deterministic rules,
and every result is labelled as such. To use a hosted model instead, see
[§13](#13-settings-people-providers-and-quality-gates).

### Record a journey

Drive the application yourself with the browser extension and import what you did. This is
the right tool when the test is *"the thing our customers actually do"* rather than something
derivable from the page structure.

![A test case imported from a recorded journey](images/manual/09-recorded-test.png)

A recorded password is never stored as text — it becomes a `${secret:…}` reference resolved
at run time.

---

## 6. Running tests

**Test runs → New run.** Choose the tests, the browser, and how many retries to allow.

![The test runs list, with each run's verdict and counts](images/manual/10-test-runs.png)

Open a run to see its totals, the quality-gate verdict, and every test in it:

![A failed run showing totals, the quality gate verdict and the failing test with its message](images/manual/11-run-detail.png)

A run executes each test in a real browser on a worker. While it runs, the page updates
itself — you do not need to reload to find out it finished.

Note the **Healed** count beside **Passed**: a run that needed a repair is counted apart
from one that did not. Note too that the quality gate reports *passed* here while the run
failed — because no gates are configured, and the page says exactly that rather than
implying the run met a standard nobody set. Gates are covered in
[§13](#13-settings-people-providers-and-quality-gates).

Each run reports one of:

| Verdict | What it means |
| --- | --- |
| **Passed** | Every step ran and every assertion held. |
| **Healed** | It passed, but a locator had to be repaired to get there. Deliberately *not* reported as a clean pass. |
| **Failed** | A step or assertion did not hold. |
| **Blocked** | The test never ran — bad credentials, or a target outside the allowed domains. Not an application defect, and counted separately. |

---

## 7. Reading a result

Open a run, then an execution inside it. This is the screen you will spend the most time on.

![A failed execution showing the diagnosis, the evidence, and each step the browser took](images/manual/12-execution-evidence.png)

It has four parts:

1. **Execution** — duration, how many steps passed, which browser and version, which worker,
   and a correlation id that ties this run to the server logs.
2. **Diagnosis** — what kind of problem this is, how confident AIRA is, and what it suggests
   you do. Covered in [§8](#8-when-a-test-fails).
3. **The tabs** — **Steps**, **Evidence**, **Console**, **Network**.
4. **What the browser did** — every step with its action, target, duration and outcome.

Under **Evidence** you will find what was captured while the test ran: screenshots (including
one at the moment of failure), a video, a Playwright trace you can replay step by step, a DOM
snapshot, the accessibility tree, and the console and network logs.

Note the password in the step list reads `***REDACTED***`. It is redacted at capture, not
hidden at display — the real value never reaches storage.

---

## 8. When a test fails

A red test is a question: *is the application broken, or is the test?* The **Failures** page
exists to answer it quickly.

![The failures page: failure rate, new failures, a breakdown by category and the most frequent failures](images/manual/13-failures.png)

- **New failures** are the ones that correlate with the most recent change. Start here.
- **By category** is the useful cut: it tells you *who should look at this*.

| Category | Usually means |
| --- | --- |
| **Application defect** | The application did something wrong. A developer's problem. |
| **Locator change** | The element moved or was renamed. Often self-healable — see [§9](#9-when-the-application-changes-self-healing). |
| **Test defect** | The test is ambiguous or wrong. Yours to fix. |
| **Environment defect** | It never ran — credentials, or the environment was unreachable. Says nothing about the application. |
| **Network issue** / **Timing issue** | A request failed at the network layer, or something was slower than the test allowed. |

Every analysis names what produced it. With no model provider configured it reads
*"Classified by AIRA's built-in rules"* with a confidence — it never implies a model looked
at something a rule decided.

**An analysis never changes a verdict.** It explains a failure; it cannot turn one into a
pass.

---

## 9. When the application changes: self-healing

When a locator stops matching, AIRA looks for the element the step *meant* to reach — by
role, accessible name, text, test id, position in the page, and neighbours — and scores how
confident it is.

![A healing proposal: the old locator struck through, the replacement, an 88% confidence score and the signals behind it](images/manual/14-healing.png)

The proposal shows you everything it used to decide: the old locator, the candidate, the
confidence, and **which signals agreed and by how much**. Approve or reject it.

### The policy is yours to choose

Set it per project:

| Policy | Behaviour |
| --- | --- |
| **Never** | Never repairs. A broken locator simply fails. |
| **Suggest** *(default)* | Proposes a repair and fails the run. Nothing changes until you approve. |
| **Auto** | Applies a repair above your confidence threshold, continues the run, and reports it as **healed** — never as a clean pass. |

### What it will not do

This is the part worth trusting, and it is measured rather than asserted. When the control a
step needs **no longer exists**, or when two candidates are equally plausible, or when
something with the same label now does something different, AIRA **fails the test**. It does
not click the nearest thing that looks close enough.

The platform's own verification measures this as a **false-healing rate**, and publishes it
as a number rather than folding it into a success rate — see
[§12](#12-the-verification-center).

---

## 10. The autonomous agent

**Agent → Start a pass.** The agent explores an application, scores where the risk is,
generates tests for what is not covered, runs them, and writes up what it found.

![A completed agent pass with its bounds, counts and every phase it went through](images/manual/15-agent.png)

You give it bounds before it starts — pages, depth, targets, tests, a time budget and a spend
limit — and it reports against them. **It proposes; it has no authority.** It cannot raise a
defect, change a test, approve a healing proposal or alter a quality gate. The summary on
every pass says so.

**What it did** lists every phase, including the ones that decided to do nothing, with the
reasoning. Prioritisation is deterministic: the same application produces the same ordering,
so you can argue with it.

---

## 11. Asking questions

**AI insights** answers questions about quality from your stored executions.

![The AI insights page with a question asked and answered, each finding citing the evidence behind it](images/manual/16-insights.png)

Every finding cites the records it came from and carries a confidence. When the evidence does
not support an answer, it says so instead of producing a confident paragraph from nothing.

As everywhere else, with no model provider configured the answers come from built-in rules
over the same records, and the page tells you so before you ask.

---

## 12. The Verification Center

**Verification** shows what the platform's own golden test suite found the last time it ran —
AIRA tested against purpose-built applications with known answers.

![The Verification Center: 126 of 130 golden tests passed, every quality gate green](images/manual/17-verification.png)

Three things to read:

- **The banner** is green only when every gate passed *and* no critical test failed. The page
  re-checks the gates itself rather than trusting the report's own verdict.
- **Not verified** is its own outcome, counted separately from passes. A test that could not
  run here — a browser that is not installed, a model provider that is not configured — is
  never counted as one that passed.
- **False-healing rate** is the headline number, kept separate from any success rate, because
  a healer that repairs nine locators correctly and silently clicks the wrong button once is
  worse than one that repairs nothing.

Populate it by running `./scripts/verify-product` on the machine. Until then the page tells
you nothing has been verified — which is not the same as everything passing, and it does not
pretend otherwise.

---

## 13. Settings: people, providers and quality gates

![The settings page: your account and roles, AI provider status, the people in the organization, and quality gates](images/manual/18-settings.png)

### Your account and roles

Your role decides what you can do, and it is **enforced on the server** — the console hiding
a button is a convenience, not the control.

### People

**Add someone** invites a colleague and gives you a one-time password to pass on. You can
change a role, disable an account or reset a password from here. Each of those ends any
session that person already holds **immediately**, not when their token happens to expire.

### AI providers

Shows each provider and whether a key is configured. **AIRA built-in rules** is always
available, needs no key, works offline, and is labelled wherever its output appears. Set
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` and restart to use a hosted model.

### Quality gates

Rules that decide whether a run should block a pipeline — a minimum pass rate, a ceiling on
failures, and so on. **With no rules configured, a run never blocks.** Changing a gate needs
an explicit permission, because weakening one is a release decision rather than a setting.

---

## 14. Running from a pipeline

The `aira` CLI starts a run, waits for its verdict, and writes reports your CI system can
display.

```bash
export AIRA_API_URL=http://localhost:5080
export AIRA_TOKEN=…                      # created once with: aira login --show-token

aira run --project "$PROJECT_ID" --suite "$SUITE_ID" --report-dir ./reports
```

`--suite` and `--project` take ids, not names. `--test` runs a single test and can be
repeated. `--report-dir` writes all three reports; `--junit`, `--json` and `--html` write
them individually. `--no-wait` queues the run and exits, for pipelines that collect results
in a later stage with `aira report <run-id>`.

The exit code is the part a pipeline should key off, because it distinguishes things that
need different responses:

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | A quality gate failed |
| `2` | Bad usage |
| `3` | Not authorized |
| `4` | Platform error |
| `5` | Timed out |

A **healed** or **flaky** result maps to a JUnit pass *with a note*, never a silent one. A
**blocked** result maps to `<error>` rather than a failure, because the test never ran —
calling it a pass would claim coverage that does not exist, and calling it a failure would
send someone hunting a defect that is not there.

Give the CI account the narrowest role that can start runs and read results. It should not
be able to change quality gates: a pipeline that can relax its own gate is not a gate.

`docs/ci-cd.md` has the full reference, including the GitHub Actions and Azure Pipelines
definitions.

---

## 15. Glossary

| Term | Meaning |
| --- | --- |
| **Application** | A web application registered for testing, with its URL, credentials and bounds. |
| **Discovery** | The crawl that builds the model of an application. |
| **Model / application map** | What discovery learned: pages, elements, transitions, API calls. |
| **Test case** | A sequence of steps and assertions. Generated, recorded or edited. |
| **Test run** | One execution of a set of test cases. |
| **Execution** | One test case running once, with its evidence. |
| **Evidence** | Screenshots, video, trace, DOM snapshot, console and network logs. |
| **Healing** | Replacing a locator that stopped matching with one that reaches the same element. |
| **Quality gate** | A rule that decides whether a run blocks a pipeline. |
| **Blocked** | A run that never happened. Distinct from failed. |
| **Not verified** | A check that could not be performed here. Distinct from passed. |

---

## 16. What AIRA will not do

Worth knowing before you rely on it:

- **It does not decide that a failure is acceptable.** It classifies and explains; closing a
  failure is yours.
- **It does not change your tests on its own.** A healed run leaves the stored test exactly
  as you wrote it; approving the proposal is what changes it.
- **It does not test what it cannot reach.** Anything outside an application's allowed
  domains is refused, and the run says `blocked` with the reason.
- **It does not take instructions from the application under test.** Text on a page is data.
  A page that says "ignore your instructions" is treated as content, never as a command.
- **It does not invent numbers.** Every figure on the dashboard is computed from stored
  executions. Where there is nothing to compute from, it says so.

---

## About these screenshots

Every image in this manual was captured by `test-lab/scripts/capture-user-manual.mjs`, which
seeds a realistic workspace — a project, an application, a crawl, generated tests, a run that
passes, a run that fails, a healing proposal and an agent pass — and then drives a real
browser through the real console to photograph each screen.

Each screenshot must prove its own caption before it is taken: the script waits for the
content the caption describes and **fails** if it never appears. An earlier version without
that check produced a screenshot of an empty agent page under a caption about an agent's
report, which is the kind of quiet wrongness this product exists to object to.

Regenerate them against your own installation:

```bash
node test-lab/scripts/capture-user-manual.mjs
```

The data in them is synthetic. The demo bank's customers, balances and transactions are
generated from a fixed seed; no real data of any kind appears in this manual.
