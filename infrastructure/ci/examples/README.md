# Example pipelines

These are pipelines for **an application that QA NXT tests**, not for QA NXT itself. Each does
the same six things, in the same order, and differs only in the syntax its CI system needs:

1. Deploy the application to a test environment.
2. Wait for it to be healthy.
3. Select the tests the change needs.
4. Run them, and let the exit code decide what happens next.
5. Publish the artifacts.
6. Post the summary on the pull request.

## What is verified and what is not

| | State |
| --- | --- |
| The CLI's behaviour these pipelines depend on — exit codes, the artifact layout, the summary, the selection | **Executed.** Every claim is covered by a golden test that runs it. See `verification/evidence/CI-*/` and `API-013`, `REG-009`. |
| The local equivalent of a whole pipeline, end to end | **Executed.** `test-lab/ci-simulation/` runs the same sequence against the lab bank, with no CI system involved: 12 scenarios covering every exit code, as golden tests CIS-001 to CIS-012. |
| These files running inside GitHub Actions, Azure DevOps, GitLab CI or Jenkins | **Not verified.** Each needs credentials for that system and a deployment of QA NXT it can reach, neither of which exists in this environment. They are written against each system's documented syntax and are not claimed to have been executed. |

That distinction is the point of this directory. A pipeline file that has never run is a
reasonable thing to ship; calling it a verified integration is not.

## What every one of them needs

| | |
| --- | --- |
| `QANXT_API_URL` | Where the control plane is. |
| `QANXT_TOKEN` | A token for a service account with `test:read`, `execution:write` and `project:read`. Store it as a secret; never run `qanxt login` in a pipeline. |
| `QANXT_PROJECT_ID` | Which project to run in. `qanxt projects` lists them. |
| `QANXT_ENVIRONMENT_ID` | Which environment the deployment is. `qanxt environments` lists them. Worth setting even when a project has only one: the environment carries the base URL, the allowed domains, the rate limit and the production guard, and omitting it means none of them apply. |
| Enough git history | `qanxt regression --since` needs the base branch. A shallow clone has none, and the command says so rather than silently selecting nothing. |

## The exit codes they branch on

| Code | Meaning | Usual pipeline response |
| --- | --- | --- |
| 0 | PASS | Continue |
| 1 | TEST_FAILURE | Fail the build; the application team looks |
| 2 | QUALITY_GATE_FAILURE | Fail the build; the tests were within tolerance and a rule stopped it anyway |
| 3 | CONFIGURATION_ERROR | Fail the build; whoever edited the pipeline looks |
| 4 | AUTHENTICATION_ERROR | Fail the build; whoever holds the credentials looks |
| 5 | INFRASTRUCTURE_ERROR | Retry may help; the platform operator looks |
| 6 | SECURITY_POLICY_VIOLATION | Fail the build and do not retry |
| 7 | HUMAN_REVIEW_REQUIRED | The team's choice — block, or continue with the summary posted |
| 8 | QANXT_INTERNAL_ERROR | Fail the build; report it |

Codes 1 and 2 are separate on purpose. "Six tests failed" and "every test passed and a rule
stopped the release" go to different people.

## Files

| File | System |
| --- | --- |
| `github-actions.yml` | GitHub Actions |
| `azure-pipelines.yml` | Azure DevOps |
| `gitlab-ci.yml` | GitLab CI |
| `Jenkinsfile` | Jenkins, declarative pipeline |
| `generic.sh` | Anything else. The others are this script with their own syntax around it. |
