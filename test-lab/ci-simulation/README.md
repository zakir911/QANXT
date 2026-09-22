# CI simulation

A pipeline, without a CI system.

`pipeline.sh` runs the same stages, in the same order, with the same commands as the
example pipelines in `infrastructure/ci/examples/`, against the lab bank instead of a
deployment. `definitions.mjs` puts it through twelve scenarios. Between them they produce
every exit code the CLI documents, both quality gate outcomes that are not a plain pass,
and both answers a pipeline can give when a run needs a person to look at it.

```
node test-lab/ci-simulation/run.mjs                       # all twelve, with a report
node test-lab/ci-simulation/run.mjs --only production-refused --verbose
node verification/golden-tests/run.mjs --suite ci-simulation   # the same twelve, with evidence
```

It needs the platform, the worker and the lab bank up: `./scripts/verify-product` brings
all of it up, or `scripts/services-ctl.sh --with-database`, `scripts/api-ctl.sh start`,
`scripts/worker-ctl.sh start` and `test-lab/scripts/lab-ctl.sh start` individually.

## Why this exists

An integration you cannot run is a claim, not a feature. The four CI systems AIRA supports
each need credentials and a reachable deployment of AIRA to run a pipeline in, and this
repository has neither. Writing five YAML files and calling the integration done would mean
shipping something nobody had ever executed.

So the work is split. What is specific to a CI system — its syntax, its runner, its secret
store — is in the example files, and is **not executed**; `infrastructure/ci/examples/README.md`
says so row by row. What is not specific to any CI system — the stage order, the commands,
the exit codes, the artifacts, the decisions a pipeline makes from them — is here, and is
executed on every verification run.

That division is the honest one, because it is where the risk actually is. A GitHub Actions
workflow that fails because of a YAML indentation error is found in one build. An exit code
that means something different from what the pipeline thinks it means is found months later
by somebody who trusted a green build.

## What each scenario shows

| Scenario | AIRA | Pipeline | What it is for |
| --- | --- | --- | --- |
| `green-build` | 0 | 0 | The ordinary case: every stage, four artifacts, the commit recorded |
| `regression-failure` | 1 | 1 | A defect in the deployment fails the build, and evidence is still published |
| `gate-blocks-a-green-run` | 2 | 2 | Nothing failed and a rule stopped it anyway — a different code, on purpose |
| `bad-configuration` | 3 | 3 | A project that does not exist is the pipeline author's problem |
| `bad-credentials` | 4 | 4 | A rejected token, and explicitly *not* a security policy violation |
| `platform-unreachable` | 5 | 5 | Nothing is known about quality. Never a pass |
| `deployment-never-came-up` | — | 5 | The health check stops the pipeline **before any test runs** |
| `production-refused` | 6 | 6 | A policy refuses production. The run does not happen, and that is correct |
| `production-authorized` | 0 | 0 | The same environment, after a recorded decision. A gate, not a wall |
| `review-blocks` | 7 | 7 | REVIEW arrives as its own code |
| `review-does-not-block` | 7 | **0** | The team may continue on REVIEW — and the log still says so |
| `aira-internal-error` | 8 | 8 | A defect in AIRA, not a finding about the application |

Two of those are worth reading twice.

**`deployment-never-came-up`** asserts a negative: that the `test` stage does not appear in
the log at all. A run against an application that has not finished starting reports
failures that belong to the deployment, and somebody spends a morning reading them as
defects. The health check exists to prevent that, and the only way to know it does is to
check that nothing ran.

**`review-does-not-block`** is the one where AIRA and the pipeline disagree, on purpose.
AIRA exits 7 and the pipeline exits 0, because whether a review verdict stops a deployment
is the team's decision and it is made in the pipeline rather than inside the CLI. The
scenario also requires `HUMAN_REVIEW_REQUIRED` to still be in the build log: the decision
to continue is allowed, hiding it is not.

## What is real and what is injected

Eleven of the twelve scenarios drive the real platform, the real worker and the real lab
bank. The failures are caused by the deployment — `regression-failure` injects a fault into
the *application*, so the test that fails there is the same test that passes in
`green-build`, unmodified.

One scenario, **`aira-internal-error`**, injects the fault into AIRA's transport instead: it
points the CLI at a local responder that answers 500 the way a broken AIRA would. It
verifies how the CLI classifies that answer and how the pipeline handles the resulting exit
code. It does **not** verify that AIRA returns 500 under any particular condition — nothing
in this directory makes the real platform fail. Producing a genuine internal error on demand
would need a test-only endpoint inside AIRA, which is a worse thing to have than an
honestly-labelled stub in a test harness.

## What this found

Building it surfaced three defects, all of the same shape: a control that exists, is
correct, and is never reached.

- **BUG-0026** — exit 6 was documented, every example pipeline branched on it, and nothing
  could produce it. A security refusal was reported as an authentication failure, whose
  hint tells the reader to ask for a wider role — the exact opposite of the right response.
- **BUG-0027** — the same for exit 8. A bug in AIRA was reported as the platform being
  unreachable, and sent to whoever runs the deployment.
- **BUG-0028** — `aira run` never sent an environment id, so the production guard, the
  per-environment base URL, the allowed domains and the rate limit were all unreachable
  from CI. The guard was right. It had no caller.

None of those are visible from reading the code. Each was found by trying to make a
pipeline produce a documented outcome and failing.

## Files

| File | What it is |
| --- | --- |
| `pipeline.sh` | The pipeline. Shell, deliberately — the examples are shell in YAML, so a sequence that only worked when driven from Node would not be evidence about them |
| `scenarios.mjs` | Setup, and the function that runs `pipeline.sh` once and parses what it did |
| `definitions.mjs` | The twelve scenarios and their assertions |
| `run.mjs` | Runs them and writes `verification/reports/CI-SIMULATION.md` |

The golden suite `verification/golden-tests/suites/ci-simulation.mjs` imports the same
definitions rather than restating them, so the runner a person uses and the suite a
certification reads execute the same scenarios.
