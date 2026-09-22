# CI simulation

Every scenario below ran `test-lab/ci-simulation/pipeline.sh` against the real platform
and the real lab bank. No CI system was involved.

Run at 2026-09-22T08:23:05.194Z.

| Scenario | Expected | Exit | Pipeline | Result |
| --- | --- | --- | --- | --- |
| `green-build` | exit 0 | 0 | 0 | pass |
| `regression-failure` | exit 1 | 1 | 1 | pass |
| `gate-blocks-a-green-run` | exit 2 | 2 | 2 | pass |
| `bad-configuration` | exit 3 | 3 | 3 | pass |
| `bad-credentials` | exit 4 | 4 | 4 | pass |
| `platform-unreachable` | exit 5 | 5 | 5 | pass |
| `deployment-never-came-up` | exit 5, and no run at all | — | 5 | pass |
| `production-refused` | exit 6 | 6 | 6 | pass |
| `production-authorized` | exit 0 | 0 | 0 | pass |
| `review-blocks` | exit 7 | 7 | 7 | pass |
| `review-does-not-block` | AIRA 7, pipeline 0 | 7 | 0 | pass |
| `aira-internal-error` | exit 8 | 8 | 8 | pass |

## What each scenario showed

### `green-build`

The ordinary case: a healthy deployment, tests that pass, a gate with nothing to say. The pipeline runs every stage in order and finishes clean, with all four artifacts written and the commit recorded against the run.

**Passed.** exit 0; stages checkout → deploy → health → select → test → publish; artifacts junit.xml, report.html, report.json, summary.md; 2 passed, 0 failed

### `regression-failure`

A defect is deployed — the accounts endpoint stops returning a field a caller reads — and the pipeline catches it. The failure is caused by the deployment, not written into the test: the same test passes in green-build. Artifacts are still published, because a failed run is the one whose evidence someone needs.

**Passed.** exit 1; 1 passed, 1 failed; artifacts published: ok

### `gate-blocks-a-green-run`

Every test passes and a quality gate rule stops the build anyway. This has to be a different code from a test failure, because "six tests failed" and "the rule was not met" send a reader to different places — and here nothing failed at all.

**Passed.** exit 2; 0 test(s) failed and the gate blocked anyway; the quality gate blocked this run

### `bad-configuration`

The pipeline names a project that does not exist. Whoever edited the pipeline should look, and the code says so rather than reporting it as a platform problem.

**Passed.** exit 3; bad configuration

### `bad-credentials`

The token is not accepted. Whoever holds AIRA_TOKEN should look — not the person who wrote the tests, and not the platform operator.

**Passed.** exit 4; bad credentials

### `platform-unreachable`

AIRA is not answering. Nothing is known about quality, and the pipeline says so in those words — the one outcome that must never be read as a pass.

**Passed.** exit 5; the platform could not be reached

### `deployment-never-came-up`

The health check never passes, so no tests run. The important half is the negative: the test stage must not appear in the log. A run against an application that has not finished starting reports failures that belong to the deployment, and somebody spends the morning reading them as defects.

**Passed.** exit 5; stages checkout → deploy → health; 0 artifact(s) — the run never started

### `production-refused`

A pipeline is pointed at production, which nobody has authorized for testing. The run does not happen, and that is the correct outcome. The code must be the security one: reported as an authentication failure (BUG-0026), the natural response is to widen the service account's permissions, which is the opposite of what should happen.

**Passed.** exit 6; a security policy refused this run

### `production-authorized`

The same environment, after somebody authorized it in writing. The guard is a gate, not a wall: production testing is possible, and the price is a recorded decision with a reason. Run after production-refused so the two together show the authorization is what changed, and not something else about the environment.

**Passed.** exit 0; the run recorded environment prod

### `review-blocks`

The gate returns REVIEW and this pipeline is configured to stop on it. REVIEW reaches the pipeline as its own code rather than being folded into pass or fail, which is what makes the next scenario possible.

**Passed.** AIRA exited 7, the pipeline exited 7; review required, and this pipeline blocks on review

### `review-does-not-block`

The same run, with the team having decided that review does not stop a deployment. AIRA still says 7; the pipeline chooses to continue. That decision belongs to the team and is made in the pipeline, not inside the CLI — which is the whole reason REVIEW has a code of its own. The verdict line records both, so nothing is hidden: the build is green and the log still says a person must look.

**Passed.** AIRA exited 7, the pipeline exited 0; review required, and this pipeline does not block on review

### `aira-internal-error`

AIRA fails, rather than being unreachable. The pipeline must say this is a defect in AIRA and not a finding about the application, so that nobody goes looking for a bug in code that is working. THIS SCENARIO INJECTS THE FAULT: the CLI is pointed at a local responder that answers 500 the way a broken AIRA would. It verifies how the CLI classifies that answer and how the pipeline handles the code. It does NOT verify that AIRA returns 500 under any particular condition — nothing here makes the real platform fail.

**Passed.** exit 8; AIRA failed internally
