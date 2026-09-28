# Autonomous QA: assessment before building

What is already in the repository, what the brief asks for, and where the two differ. Written
before any code was changed, from reading the code rather than the documentation — several
things the documentation implies turned out not to be connected.

Baseline on the day of the assessment: **637/637 API unit tests pass**, 57/57 integration,
242 security golden tests with 0 failures. Nothing is failing. The gaps below are absences,
not breakages.

---

## 1. There is already an agent, and it is narrower than its name

`QaNxt.Application/Agent/` is 46KB across three files, plus `AgentRun`, `AgentStep` and
`AgentFinding` in the domain, an `/agent` console page, and 10 integration tests.

What it does, from `AgentLoop.cs`:

```
Explore → Model → Prioritize → Generate → Execute → Investigate → Propose
```

That loop is real and it works. Its bounds are frozen onto the run, clamped to ceilings, and
checked between every phase. Every step is recorded with its reasoning. The agent has no
authority: it cannot approve healing, change a gate, close a failure or edit a test, and an
integration test asserts each of those.

**What it does not do.** The loop injects exactly four services: discovery, test generation,
test runs, and the database. It has a `using QaNxt.Application.Security;` at the top of the
file and **uses nothing from that namespace** — a stale import, and the clearest single piece
of evidence for the gap. So:

| The brief asks for | The existing agent |
| --- | --- |
| API testing selection (§16) | never calls the API testing engine |
| Security testing selection (§17) | never calls the security engine |
| Smart regression (§18) | never calls `RegressionSelectionService` |
| Accessibility, visual (§36) | never calls either |
| Test plan for approval (§5) | no plan object exists; it generates and runs |
| Dynamic selection mid-run (§14) | the phase order is fixed and blind to evidence |
| Dependency-aware execution (§13) | tests are run as one flat suite |
| Tool registry (§28) | no tool abstraction; services are called directly |

The existing agent is best described as **a bounded UI-test generator with a recorded
reasoning trail**. Calling it an autonomous QA agent is the part that is not yet true.

## 2. What already exists and should be reused, not rebuilt

A great deal of this brief is already implemented outside the agent. The work is wiring, not
writing.

| Brief section | Already exists | Where |
| --- | --- | --- |
| §6 risk factors, stored and explained | **Yes, fully** | `Intelligence/RiskModel.cs` — 10 named factors, each with points and a sentence; `RiskFactor(Name, Points, Explanation)` |
| §18 smart regression | **Yes** | `Quality/RegressionSelectionService.cs` (539 lines), `Intelligence/RegressionModel.cs` |
| §20 failure classification | **Yes** | `Diagnosis/DeterministicFailureClassifier.cs` (393 lines) |
| §21 API↔UI correlation | **Partly** | `Diagnosis/ApiCorrelation.cs` (118 lines) — correlates a failure to an API call, but does not group failures into one primary cause |
| §22 defect package | **Partly** | `Domain/Diagnosis/Defect.cs` exists with proposal semantics |
| §23 self-healing | **Yes** | `Diagnosis/HealingService.cs` + worker healing |
| §25 security regression | **Yes** | the security engine compares scans and fails on a returning finding |
| §31 prompt-injection isolation | **Yes** | `Ai/PromptBuilder.cs` wraps application content in `<untrusted_application_content>` with a directive |
| §33 AI cost tracking | **Yes** | `Domain/Ai/AiRequest.cs` carries `EstimatedCostUsd`; the agent enforces a spend ceiling |
| §36 release assessment | **Yes** | `Quality/RunComparisonService.cs`, release quality report with a mandatory security section |
| §49 AI fault injection | **Partly** | `Infrastructure/Ai/AiFaultInjection.cs` (182 lines) covers AI faults only |
| Knowledge graph | **Yes** | `ApplicationPage`, `ApplicationElement`, `ApiEndpoint`, `ApiContract`, `Journey`, `JourneyStep` |

**Nothing in this list should be reimplemented.** Where the brief describes something that
exists, the task is to make the agent call it and record why.

## 3. What does not exist at all

- **A test plan as an object.** §5 requires a proposal a person approves, modifies or
  rejects before execution. There is no entity, no endpoint and no screen for one.
- **Test gap analysis.** §10 wants capability-versus-coverage across UI/API/security/
  accessibility/visual. `RiskModel` has a coverage-gap *factor*, which is not the same thing.
- **A duplication engine.** §12. Generation checks whether a page has any coverage at all;
  it does not compare intent or assertions against existing tests.
- **A tool registry.** §28. Every capability is a direct service call, so there is no single
  place where risk level, required permission and allowed environment are declared per action.
- **Agent memory.** §30. Each pass starts from nothing but the graph.
- **User-provided business context.** §9. Nothing lets an operator say "payments are
  critical, never touch admin deletion".
- **Journey provenance.** §8 wants Observed / User Provided / Inferred. `JourneySource` has
  Discovered / Recorded / Manual / AiProposed, which is close but does not distinguish an
  inferred capability from an observed one — the distinction the brief cares about.
- **Historical test intelligence as a surface.** §19. Flakiness is computed in several places
  for dashboards; there is no per-test history the planner reads.
- **A decision log.** §32 wants Decision ID, reason, evidence, tool, result. `AgentStep` holds
  a phase and a rationale, which is coarser and has no evidence link.
- **The autonomous QA dashboard and timeline.** §34, §35.
- **`autonomous-qa-report.html/json`** (§46) and **`./scripts/verify-autonomous-qa`** (§47).
- **Golden agent tests.** §48 asks for 250+. There is **no `agent.mjs` suite at all** — the
  agent is the only major capability with no golden coverage, which is why several of the
  disconnections above survived.
- **The external pilot** (§38–§45).

## 4. Technical debt and duplication found

- **`using QaNxt.Application.Security;` in `AgentLoop.cs` is unused.** It reads as though the
  agent does security work. It does not.
- **`QaNxt.Application/Analysis/` and `QaNxt.Application/Regression/` and
  `QaNxt.Application/Healing/` are empty directories.** Healing lives in `Diagnosis/`. An
  earlier absence check of mine pointed at `Application/Healing` and passed having read
  nothing, for exactly this reason.
- ~~**Flakiness is computed in four places** with no shared definition.~~ **Wrong, corrected
  after reading the code properly.** It is computed in exactly one place —
  `ExecutionIngestService`, at ingest, from the last ten executions — and everything else
  (`RegressionScoring`, `DashboardService`, `QualityGateEvaluator`, `RunComparisonService`)
  reads the stored score or counts `ExecutionStatus.Flaky`. The original claim came from
  grepping for the word rather than reading what each hit did. §19 therefore needs a history
  *surface* the planner can read, not a definition — there is already one, and its bar is
  deliberately high: five recent runs, at least three verdict changes, and a majority
  oscillating, with only a pass ever relabelled so a real failure is never softened.
- **The agent has no unit tests.** Its 10 tests are integration tests that exercise the API
  surface; `AgentLoop` itself — 34KB, the most consequential file in this phase — is tested
  only through a live loop.
- **`AgentRun` restart behaviour is "mark failed"**, which is honest but means §13's *resume*
  requirement needs a different design rather than a tweak.

## 5. Constraints that bound this phase

From §53 and from what the environment allows:

1. **The pilot needs an independently developed application.** GitHub source download is
   blocked by the network policy in this environment (`codeload.github.com` returns 403); the
   npm registry is reachable (200). So a pilot target has to be installable from npm. This is
   a real constraint on §38 and is recorded rather than worked around.
2. **"Explicitly authorized" for a locally-run third-party application means we operate the
   instance.** That is a weaker claim than a customer granting permission on their own system,
   and the report must say so rather than implying a customer pilot happened.
3. **The agent must not gain authority it does not have today.** Everything new is a proposal
   or a bounded, policy-checked action. The four "the agent may not" integration tests stay.
4. **Security testing stays behind the security engine.** The agent selects; the engine and
   its scope guard decide. No new path to issuing a request.

## 6. Plan

Sequenced so that each phase is verifiable on its own, and so the foundations that everything
else records through — the tool registry, the policy engine, the decision log — come first.

| Phase | What | Brief |
| --- | --- | --- |
| AQ-1 | Tool registry and agent policy engine | §28, §29 |
| AQ-2 | Decision log with evidence, and AI cost attribution per decision | §32, §33, §51 |
| AQ-3 | Agent memory and user-provided business context | §9, §30 |
| AQ-4 | Journey provenance: observed, user-provided, inferred | §8 |
| AQ-5 | Test gap analysis | §10 |
| AQ-6 | Duplication engine | §12 |
| AQ-7 | The test plan: proposal, approval, modification | §5, §27 |
| AQ-8 | Risk strategy extended with business context and change signals | §6 |
| AQ-9 | Execution: dependency-aware, retry, resume, cancel | §13 |
| AQ-10 | API, security, regression and accessibility selection wired into the loop | §16, §17, §18 |
| AQ-11 | Dynamic test selection from mid-run evidence | §14 |
| AQ-12 | Exploratory mode | §15 |
| AQ-13 | Historical test intelligence, one definition of flaky | §19 |
| AQ-14 | Root-cause correlation and the defect package | §21, §22 |
| AQ-15 | Healing learning; security finding → regression; journey → regression | §24, §25, §26 |
| AQ-16 | Autonomous QA dashboard and run timeline | §34, §35 |
| AQ-17 | Release quality assessment and decision support | §36, §37 |
| AQ-18 | Fault injection beyond AI, and agent failure testing | §49, §50 |
| AQ-19 | Golden autonomous suites, 250+ scenarios | §48 |
| AQ-20 | `autonomous-qa-report` and `./scripts/verify-autonomous-qa` | §46, §47 |
| AQ-21 | Pilot: onboarding, baseline, execution, measurement | §38–§43 |
| AQ-22 | Compatibility matrix, limitations, final report | §44, §45, §52 |

Each phase ends with tests that fail if the phase is removed. A phase is not finished because
its code exists.
