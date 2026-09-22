/**
 * The twelve scenarios.
 *
 * Between them they produce every exit code the CLI documents, both quality gate outcomes
 * that are not a plain pass, and both answers a pipeline can give to a review verdict. Each
 * one runs the real `pipeline.sh`; what varies is the environment it runs in and the state
 * of the deployment it runs against.
 *
 * Each scenario returns `{ pass, detail, airaExit, pipelineExit, log }`. The golden suite
 * and the standalone runner both consume that shape.
 */
import {
  BANK, UNREACHABLE, authorizeProduction, brokenPlatform, prepare, prepareGateProject,
  runPipeline
} from './scenarios.mjs';
import { lab } from '../../verification/golden-tests/platform.mjs';

/** Builds everything the scenarios share. Called once per run. */
export async function buildContext() {
  const base = await prepare();

  const blocking = await prepareGateProject(base.tenant, {
    name: 'CI simulation — blocking gate',
    rule: {
      name: 'Every test must pass, twice over',
      // Unsatisfiable on purpose, and unsatisfiable by a *passing* run in particular. The
      // scenario has to show a gate blocking a run in which nothing failed, because that
      // is exactly the case exit 2 exists to distinguish from exit 1.
      metric: 'passRatePercent', operator: 'greaterThan', threshold: 100, action: 'fail',
      message: 'This project requires a pass rate above 100%, which nothing can meet.'
    }
  });

  const review = await prepareGateProject(base.tenant, {
    name: 'CI simulation — review gate',
    rule: {
      name: 'A person signs off every release',
      metric: 'passRatePercent', operator: 'greaterThan', threshold: 100, action: 'review',
      message: 'A person signs off every release in this project.'
    }
  });

  return { ...base, blocking, review };
}

/** The environment every scenario starts from: real platform, real deployment, real tests. */
const baseEnvironment = context => ({
  AIRA_TOKEN: context.tenant.token,
  AIRA_PROJECT_ID: context.project.id,
  AIRA_ENVIRONMENT_ID: context.qa.id,
  APP_URL: BANK,
  RUN_TIMEOUT: '240',
  HEALTH_TIMEOUT: '30',
  BUILD_ID: '4471',
  COMMIT_SHA: 'deadbeefcafe0000111122223333444455556666',
  BRANCH: 'feature/accounts',
  CI_PROVIDER: 'simulation'
});

export const scenarios = [
  // -------------------------------------------------------------------------
  {
    id: 'green-build',
    expectation: 'exit 0',
    description:
      'The ordinary case: a healthy deployment, tests that pass, a gate with nothing to say. '
      + 'The pipeline runs every stage in order and finishes clean, with all four artifacts '
      + 'written and the commit recorded against the run.',
    async run(context) {
      await lab.reset(BANK);
      const result = runPipeline({
        ...baseEnvironment(context),
        TEST_IDS: `${context.health.testCaseId} ${context.accounts.testCaseId}`
      });

      const stagesInOrder = ['checkout', 'deploy', 'health', 'select', 'test', 'publish']
        .every((name, index) => result.stageNames[index] === name);

      const pass = result.code === 0
        && result.verdict?.code === 0
        && stagesInOrder
        && JSON.stringify(result.files) ===
           JSON.stringify(['junit.xml', 'report.html', 'report.json', 'summary.md'])
        && result.summary.startsWith('### ✅ All tests passed')
        && result.report?.run?.ci?.commitSha === 'deadbeefcafe0000111122223333444455556666'
        && result.report?.run?.ci?.buildId === '4471'
        && result.report?.totals?.failed === 0;

      return {
        pass, log: result.log, airaExit: 0, pipelineExit: result.code,
        detail: `exit ${result.code}; stages ${result.stageNames.join(' → ')}; `
          + `artifacts ${result.files.join(', ')}; `
          + `${result.report?.totals?.passed ?? '?'} passed, ${result.report?.totals?.failed ?? '?'} failed`,
        evidence: { 'pipeline.log': result.log, 'summary.md': result.summary, 'report.json': result.report }
      };
    }
  },

  // -------------------------------------------------------------------------
  {
    id: 'regression-failure',
    expectation: 'exit 1',
    description:
      'A defect is deployed — the accounts endpoint stops returning a field a caller reads — '
      + 'and the pipeline catches it. The failure is caused by the deployment, not written '
      + 'into the test: the same test passes in green-build. Artifacts are still published, '
      + 'because a failed run is the one whose evidence someone needs.',
    async run(context) {
      const result = runPipeline({
        ...baseEnvironment(context),
        TEST_IDS: `${context.health.testCaseId} ${context.accounts.testCaseId}`,
        FAULTS: JSON.stringify({ FAULT_API_FIELD_REMOVED: true })
      });
      await lab.reset(BANK);

      const pass = result.code === 1
        && result.verdict?.code === 1
        && result.stageOutcome('publish') === 'ok'
        && result.files.length === 4
        && result.summary.startsWith('### ❌ 1 test(s) failed')
        && result.summary.includes(context.accounts.reference)
        // The healthy test is still reported as healthy. A failure does not swallow the run.
        && result.report?.totals?.passed === 1
        && result.report?.totals?.failed === 1;

      return {
        pass, log: result.log, airaExit: 1, pipelineExit: result.code,
        detail: `exit ${result.code}; ${result.report?.totals?.passed ?? '?'} passed, `
          + `${result.report?.totals?.failed ?? '?'} failed; artifacts published: `
          + `${result.stageOutcome('publish')}`,
        evidence: { 'pipeline.log': result.log, 'summary.md': result.summary }
      };
    }
  },

  // -------------------------------------------------------------------------
  {
    id: 'gate-blocks-a-green-run',
    expectation: 'exit 2',
    description:
      'Every test passes and a quality gate rule stops the build anyway. This has to be a '
      + 'different code from a test failure, because "six tests failed" and "the rule was '
      + 'not met" send a reader to different places — and here nothing failed at all.',
    async run(context) {
      await lab.reset(BANK);
      const result = runPipeline({
        ...baseEnvironment(context),
        AIRA_PROJECT_ID: context.blocking.project.id,
        AIRA_ENVIRONMENT_ID: context.blocking.environment.id,
        TEST_IDS: context.blocking.health.testCaseId
      });

      const pass = result.code === 2
        && result.verdict?.code === 2
        && result.report?.totals?.failed === 0
        && result.report?.totals?.passed === 1
        && result.summary.includes('pass rate above 100%');

      return {
        pass, log: result.log, airaExit: 2, pipelineExit: result.code,
        detail: `exit ${result.code}; ${result.report?.totals?.failed ?? '?'} test(s) failed `
          + `and the gate blocked anyway; ${result.verdict?.reason}`,
        evidence: { 'pipeline.log': result.log, 'summary.md': result.summary }
      };
    }
  },

  // -------------------------------------------------------------------------
  {
    id: 'bad-configuration',
    expectation: 'exit 3',
    description:
      'The pipeline names a project that does not exist. Whoever edited the pipeline should '
      + 'look, and the code says so rather than reporting it as a platform problem.',
    async run(context) {
      const result = runPipeline({
        ...baseEnvironment(context),
        AIRA_PROJECT_ID: '00000000-0000-4000-8000-000000000000',
        AIRA_ENVIRONMENT_ID: '',
        TEST_IDS: context.health.testCaseId
      });

      const pass = result.code === 3
        && result.verdict?.code === 3
        && /CONFIGURATION_ERROR/.test(result.log);

      return {
        pass, log: result.log, airaExit: 3, pipelineExit: result.code,
        detail: `exit ${result.code}; ${result.verdict?.reason}`,
        evidence: { 'pipeline.log': result.log }
      };
    }
  },

  // -------------------------------------------------------------------------
  {
    id: 'bad-credentials',
    expectation: 'exit 4',
    description:
      'The token is not accepted. Whoever holds AIRA_TOKEN should look — not the person who '
      + 'wrote the tests, and not the platform operator.',
    async run(context) {
      const result = runPipeline({
        ...baseEnvironment(context),
        AIRA_TOKEN: 'not.a.real.token',
        TEST_IDS: context.health.testCaseId
      });

      const pass = result.code === 4
        && result.verdict?.code === 4
        && /AUTHENTICATION_ERROR/.test(result.log)
        // Never the security code: a rejected token is not a policy refusal, and conflating
        // them would send a routine credential rotation to a security review.
        && !/SECURITY_POLICY_VIOLATION/.test(result.log);

      return {
        pass, log: result.log, airaExit: 4, pipelineExit: result.code,
        detail: `exit ${result.code}; ${result.verdict?.reason}`,
        evidence: { 'pipeline.log': result.log }
      };
    }
  },

  // -------------------------------------------------------------------------
  {
    id: 'platform-unreachable',
    expectation: 'exit 5',
    description:
      'AIRA is not answering. Nothing is known about quality, and the pipeline says so in '
      + 'those words — the one outcome that must never be read as a pass.',
    async run(context) {
      const result = runPipeline({
        ...baseEnvironment(context),
        AIRA_API_URL: UNREACHABLE,
        TEST_IDS: context.health.testCaseId
      });

      const pass = result.code === 5
        && result.verdict?.code === 5
        && /INFRASTRUCTURE_ERROR/.test(result.log)
        && /Nothing is known about quality/.test(result.log);

      return {
        pass, log: result.log, airaExit: 5, pipelineExit: result.code,
        detail: `exit ${result.code}; ${result.verdict?.reason}`,
        evidence: { 'pipeline.log': result.log }
      };
    }
  },

  // -------------------------------------------------------------------------
  {
    id: 'deployment-never-came-up',
    expectation: 'exit 5, and no run at all',
    description:
      'The health check never passes, so no tests run. The important half is the negative: '
      + 'the test stage must not appear in the log. A run against an application that has '
      + 'not finished starting reports failures that belong to the deployment, and somebody '
      + 'spends the morning reading them as defects.',
    async run(context) {
      const result = runPipeline({
        ...baseEnvironment(context),
        APP_URL: UNREACHABLE,
        HEALTH_TIMEOUT: '4',
        TEST_IDS: context.health.testCaseId
      });

      const pass = result.code === 5
        && result.stageOutcome('health') === 'failed'
        && !result.stageNames.includes('test')
        && !result.stageNames.includes('publish')
        && result.files.length === 0;

      return {
        pass, log: result.log, airaExit: null, pipelineExit: result.code,
        detail: `exit ${result.code}; stages ${result.stageNames.join(' → ')}; `
          + `${result.files.length} artifact(s) — the run never started`,
        evidence: { 'pipeline.log': result.log }
      };
    }
  },

  // -------------------------------------------------------------------------
  {
    id: 'production-refused',
    expectation: 'exit 6',
    description:
      'A pipeline is pointed at production, which nobody has authorized for testing. The run '
      + 'does not happen, and that is the correct outcome. The code must be the security one: '
      + 'reported as an authentication failure (BUG-0026), the natural response is to widen '
      + "the service account's permissions, which is the opposite of what should happen.",
    async run(context) {
      const result = runPipeline({
        ...baseEnvironment(context),
        AIRA_ENVIRONMENT_ID: context.production.id,
        TEST_IDS: context.health.testCaseId
      });

      const pass = result.code === 6
        && result.verdict?.code === 6
        && /SECURITY_POLICY_VIOLATION/.test(result.log)
        && /has not been authorized/.test(result.log)
        && !/required role/i.test(result.log);

      return {
        pass, log: result.log, airaExit: 6, pipelineExit: result.code,
        detail: `exit ${result.code}; ${result.verdict?.reason}`,
        evidence: { 'pipeline.log': result.log }
      };
    }
  },

  // -------------------------------------------------------------------------
  {
    id: 'production-authorized',
    expectation: 'exit 0',
    description:
      'The same environment, after somebody authorized it in writing. The guard is a gate, '
      + 'not a wall: production testing is possible, and the price is a recorded decision '
      + 'with a reason. Run after production-refused so the two together show the '
      + 'authorization is what changed, and not something else about the environment.',
    async run(context) {
      await authorizeProduction(context.tenant, context.production.id,
        'Read-only smoke test against production, agreed with the platform team.');
      await lab.reset(BANK);

      const result = runPipeline({
        ...baseEnvironment(context),
        AIRA_ENVIRONMENT_ID: context.production.id,
        TEST_IDS: context.health.testCaseId
      });

      const pass = result.code === 0
        && result.verdict?.code === 0
        && result.report?.run?.environment?.id === context.production.id
        && result.report?.run?.environment?.key === 'prod';

      return {
        pass, log: result.log, airaExit: 0, pipelineExit: result.code,
        detail: `exit ${result.code}; the run recorded environment `
          + `${result.report?.run?.environment?.key ?? 'none'}`,
        evidence: { 'pipeline.log': result.log, 'report.json': result.report }
      };
    }
  },

  // -------------------------------------------------------------------------
  {
    id: 'review-blocks',
    expectation: 'exit 7',
    description:
      'The gate returns REVIEW and this pipeline is configured to stop on it. REVIEW reaches '
      + 'the pipeline as its own code rather than being folded into pass or fail, which is '
      + 'what makes the next scenario possible.',
    async run(context) {
      await lab.reset(BANK);
      const result = runPipeline({
        ...baseEnvironment(context),
        AIRA_PROJECT_ID: context.review.project.id,
        AIRA_ENVIRONMENT_ID: context.review.environment.id,
        TEST_IDS: context.review.health.testCaseId,
        REVIEW_BLOCKS: 'true'
      });

      const pass = result.code === 7
        && result.verdict?.code === 7
        && result.stageOutcome('test') === 'exit-7'
        && result.summary.startsWith('### ⚠️ This run needs a person to look at it');

      return {
        pass, log: result.log, airaExit: 7, pipelineExit: result.code,
        detail: `AIRA exited 7, the pipeline exited ${result.code}; ${result.verdict?.reason}`,
        evidence: { 'pipeline.log': result.log, 'summary.md': result.summary }
      };
    }
  },

  // -------------------------------------------------------------------------
  {
    id: 'review-does-not-block',
    expectation: 'AIRA 7, pipeline 0',
    description:
      'The same run, with the team having decided that review does not stop a deployment. '
      + 'AIRA still says 7; the pipeline chooses to continue. That decision belongs to the '
      + "team and is made in the pipeline, not inside the CLI — which is the whole reason "
      + 'REVIEW has a code of its own. The verdict line records both, so nothing is hidden: '
      + 'the build is green and the log still says a person must look.',
    async run(context) {
      await lab.reset(BANK);
      const result = runPipeline({
        ...baseEnvironment(context),
        AIRA_PROJECT_ID: context.review.project.id,
        AIRA_ENVIRONMENT_ID: context.review.environment.id,
        TEST_IDS: context.review.health.testCaseId,
        REVIEW_BLOCKS: 'false'
      });

      const pass = result.code === 0
        && result.stageOutcome('test') === 'exit-7'
        && /HUMAN_REVIEW_REQUIRED/.test(result.log)
        && /does not block on review/.test(result.verdict?.reason ?? '');

      return {
        pass, log: result.log, airaExit: 7, pipelineExit: result.code,
        detail: `AIRA exited 7, the pipeline exited ${result.code}; ${result.verdict?.reason}`,
        evidence: { 'pipeline.log': result.log }
      };
    }
  },

  // -------------------------------------------------------------------------
  {
    id: 'aira-internal-error',
    expectation: 'exit 8',
    description:
      'AIRA fails, rather than being unreachable. The pipeline must say this is a defect in '
      + 'AIRA and not a finding about the application, so that nobody goes looking for a bug '
      + 'in code that is working. '
      + 'THIS SCENARIO INJECTS THE FAULT: the CLI is pointed at a local responder that '
      + 'answers 500 the way a broken AIRA would. It verifies how the CLI classifies that '
      + 'answer and how the pipeline handles the code. It does NOT verify that AIRA returns '
      + '500 under any particular condition — nothing here makes the real platform fail.',
    async run(context) {
      const broken = await brokenPlatform();
      try {
        const result = runPipeline({
          ...baseEnvironment(context),
          AIRA_API_URL: broken.url,
          TEST_IDS: context.health.testCaseId
        });

        const pass = result.code === 8
          && result.verdict?.code === 8
          && /AIRA_INTERNAL_ERROR/.test(result.log)
          && /defect in AIRA, not a finding about the application/.test(result.log);

        return {
          pass, log: result.log, airaExit: 8, pipelineExit: result.code,
          detail: `exit ${result.code}; ${result.verdict?.reason}`,
          evidence: { 'pipeline.log': result.log }
        };
      } finally {
        await broken.stop();
      }
    }
  }
];
