/**
 * The whole pipeline, end to end, with no CI system.
 *
 * CI-005 in the `ci-integration` suite checks the example pipeline files statically: that
 * every flag they pass exists and every exit code is handled. That is worth having and it
 * is not evidence that the sequence works. This suite is that evidence. Each test runs
 * `test-lab/ci-simulation/pipeline.sh` — the same stages, in the same order, running the
 * same commands as the examples — against the real platform and the real lab bank, and
 * checks what came out.
 *
 * Between them the twelve produce every exit code the CLI documents. Nine of them come from
 * the real platform answering a real request. One (`deployment-never-came-up`) comes from
 * the pipeline itself, before QA NXT is involved. One (`qanxt-internal-error`) is injected, and
 * that test says so in its own expectation rather than in a footnote.
 *
 * The scenarios live in `test-lab/ci-simulation/definitions.mjs` and are imported rather
 * than restated, so the standalone runner a person uses and the suite a certification reads
 * execute the same thing.
 */
import { golden, suite } from '../harness.mjs';
import { buildContext, scenarios } from '../../../test-lab/ci-simulation/definitions.mjs';

/** What each scenario is for, in the harness's terms. Keyed by scenario id. */
const DECLARATIONS = {
  'green-build': {
    id: 'CIS-001', severity: 'critical',
    objective: 'A healthy deployment and passing tests take the pipeline through every stage to a clean exit',
    expected: 'Exit 0, the stages in order, all four artifacts written, and the commit '
      + 'recorded on the run so a future failure can be traced to it',
    evidence: ['pipeline.log', 'summary.md', 'report.json']
  },
  'regression-failure': {
    id: 'CIS-002', severity: 'critical',
    objective: 'A defect in the deployment fails the pipeline, and the evidence is still published',
    expected: 'Exit 1, the failing test named in the summary, the passing test still '
      + 'reported as passing, and the artifacts uploaded despite the failure',
    evidence: ['pipeline.log', 'summary.md']
  },
  'gate-blocks-a-green-run': {
    id: 'CIS-003', severity: 'critical',
    objective: 'A quality gate blocks a run in which no test failed, under its own exit code',
    expected: 'Exit 2 with zero failed tests, and the rule\'s own explanation in the summary',
    evidence: ['pipeline.log', 'summary.md']
  },
  'bad-configuration': {
    id: 'CIS-004', severity: 'high',
    objective: 'A pipeline naming a project that does not exist is a configuration error',
    expected: 'Exit 3, and a message pointing at whoever edited the pipeline rather than at the platform',
    evidence: ['pipeline.log']
  },
  'bad-credentials': {
    id: 'CIS-005', severity: 'high',
    objective: 'A rejected token is an authentication error and never a security policy violation',
    expected: 'Exit 4, and no mention of a security policy — a routine credential rotation '
      + 'must not be routed to a security review',
    evidence: ['pipeline.log']
  },
  'platform-unreachable': {
    id: 'CIS-006', severity: 'critical',
    objective: 'An unreachable platform is reported as knowing nothing, never as a pass',
    expected: 'Exit 5, and the words "Nothing is known about quality" in the build log',
    evidence: ['pipeline.log']
  },
  'deployment-never-came-up': {
    id: 'CIS-007', severity: 'critical',
    objective: 'A failed health check stops the pipeline before any test runs',
    expected: 'Exit 5, no test stage in the log at all, and no artifacts — the negative is '
      + 'the point: a run against a half-started application reports the deployment as defects',
    evidence: ['pipeline.log']
  },
  'production-refused': {
    id: 'CIS-008', severity: 'critical',
    objective: 'A run against an unauthorized production environment is refused under the security exit code',
    expected: 'Exit 6, the reason quoted, and no suggestion that a wider role would help',
    evidence: ['pipeline.log']
  },
  'production-authorized': {
    id: 'CIS-009', severity: 'high',
    objective: 'The same environment runs once somebody has authorized it in writing',
    expected: 'Exit 0, and the run recording which environment the evidence came from',
    evidence: ['pipeline.log', 'report.json']
  },
  'review-blocks': {
    id: 'CIS-010', severity: 'critical',
    objective: 'A REVIEW verdict reaches the pipeline as its own exit code',
    expected: 'Exit 7, and a summary saying a person must look — not a pass, not a failure',
    evidence: ['pipeline.log', 'summary.md']
  },
  'review-does-not-block': {
    id: 'CIS-011', severity: 'critical',
    objective: 'A team may choose to continue on REVIEW, and the log still says a person must look',
    expected: 'QA NXT exits 7, the pipeline exits 0, and the build log still carries '
      + 'HUMAN_REVIEW_REQUIRED — the decision is visible rather than silently swallowed',
    evidence: ['pipeline.log']
  },
  'qanxt-internal-error': {
    id: 'CIS-012', severity: 'high',
    objective: 'A failure inside QA NXT is reported as a defect in QA NXT, not as a finding about the application',
    expected: 'Exit 8 and a message that says so. INJECTED: the CLI is pointed at a local '
      + 'responder answering 500. This verifies the classification and the pipeline branch; '
      + 'it does NOT verify that QA NXT returns 500 under any condition',
    evidence: ['pipeline.log']
  }
};

export default async function run() {
  suite('CI simulation');

  const context = await buildContext();
  const shared = {
    tenant: context.tenant, project: context.project,
    application: context.application, applicationVersion: '1.0.0'
  };

  for (const scenario of scenarios) {
    const declaration = DECLARATIONS[scenario.id];
    if (!declaration) throw new Error(`Scenario ${scenario.id} has no golden declaration.`);

    await golden({
      id: declaration.id,
      objective: declaration.objective,
      preconditions: ['the platform is running', 'the lab bank is running', 'the CLI is built'],
      input: `test-lab/ci-simulation/pipeline.sh — scenario "${scenario.id}"`,
      expected: declaration.expected,
      evidence: declaration.evidence,
      severity: declaration.severity,
      run: async () => {
        const outcome = await scenario.run(context);
        return {
          pass: outcome.pass,
          detail: outcome.detail,
          metrics: {
            qanxtExit: outcome.qanxtExit ?? -1,
            pipelineExit: outcome.pipelineExit ?? -1
          },
          evidence: outcome.evidence ?? { 'pipeline.log': outcome.log ?? '' }
        };
      }
    }, shared);
  }
}
