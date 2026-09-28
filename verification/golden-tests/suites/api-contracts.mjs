/**
 * API inventory, generation and contract testing, against the lab bank's real API.
 *
 * Contract checking is the one part of this phase whose value is entirely in its
 * classification, so most of this suite is about whether QA NXT calls each kind of change
 * what it is. The lab bank can change its own API shape on demand — four faults that keep
 * the status at 200 and the UI working while the response moves underneath — so every
 * verdict here is measured against a change that really happened.
 *
 * The distinction being tested is the one that decides whether contract checking survives
 * contact with a team: a check that calls every change breaking gets switched off within a
 * week, and one that calls a removed field safe is worse than having none.
 */
import { golden, suite } from '../harness.mjs';
import {
  LAB, apiInventory, captureBaselines, contractChanges, createEnvironment, createGateRule,
  createProject, execute, generateApiTests, lab, newTenant, qualityGate, registerApplication,
  request, requireApiTest, runDiscovery, testCase
} from '../platform.mjs';

const BANK = LAB.banking;
const CREDENTIALS = { username: 'alice', password: 'Password123!' };

/** The API test every contract scenario runs: sign in, then read the accounts. */
function accountsTest() {
  return [
    {
      description: 'Sign in through the API',
      request: {
        method: 'POST', path: '/api/session', contentType: 'application/json',
        body: JSON.stringify({ username: CREDENTIALS.username, password: '${secret:app_password}' }),
        auth: { mode: 'none' }
      },
      assertions: [{ type: 'httpStatusEquals', expected: '200' }]
    },
    {
      description: 'Read the accounts',
      request: { method: 'GET', path: '/api/accounts', auth: { mode: 'none' } },
      // Deliberately only a status assertion. A contract change has to be found by the
      // contract check, not by an assertion that happens to cover the same field — if the
      // assertions caught it, this suite would prove nothing about contract checking.
      assertions: [{ type: 'httpStatusEquals', expected: '200' }]
    }
  ];
}

export default async function run() {
  suite('API contracts');
  await lab.reset(BANK);

  const tenant = await newTenant('Contracts');
  const project = await createProject(tenant, 'Golden API contracts');
  const application = await registerApplication(tenant, project.id, {
    name: 'Lab Bank contracts', baseUrl: BANK, loginUrl: `${BANK}/login`, ...CREDENTIALS
  });
  await createEnvironment(tenant, project.id, {
    name: 'Lab QA', key: 'qa', kind: 'qa', baseUrl: BANK, apiBaseUrl: BANK
  });
  const context = { tenant, project, application, applicationVersion: '1.0.0' };

  // Discovery populates the inventory these tests are built on. Everything downstream is
  // about what QA NXT observed, so it has to have observed something first.
  const discovery = await runDiscovery(tenant, application.id, { timeoutMs: 300_000 });

  const accounts = await requireApiTest(tenant, {
    projectId: project.id,
    applicationId: application.id,
    suiteName: 'Contracts — accounts',
    name: 'The accounts endpoint answers',
    priority: 'high',
    steps: accountsTest()
  });

  /** Runs the accounts test with a fault on, and returns what the contract check found. */
  async function runWithFault(faults, name) {
    await lab.reset(BANK);
    if (Object.keys(faults).length > 0) await lab.set(BANK, faults);
    const { run: testRun } = await execute(tenant, {
      projectId: project.id, testCaseId: accounts.testCaseId, name, timeoutMs: 180_000
    });
    await lab.reset(BANK);
    const changes = await contractChanges(tenant, testRun.id);
    return { testRun, changes };
  }

  // ---- CON-001: the inventory reports coverage, not just endpoints --------
  await golden({
    id: 'CON-001',
    objective: 'The API inventory reports which observed endpoints nothing tests',
    preconditions: ['discovery has run against the lab bank'],
    input: `Inventory for ${application.name} after discovery`,
    expected: 'Every observed endpoint listed, with a test count; the accounts endpoint '
      + 'counted as covered and the rest as not',
    evidence: ['inventory.json'],
    severity: 'high',
    run: async () => {
      const inventory = await apiInventory(tenant, application.id);
      const accountsEntry = (inventory?.endpoints ?? [])
        .find(entry => entry.urlTemplate.endsWith('/api/accounts') && entry.method === 'GET');

      return {
        pass: (inventory?.endpointCount ?? 0) > 0
          && accountsEntry !== undefined
          && accountsEntry.testCount >= 1
          && inventory.coveredEndpointCount < inventory.endpointCount,
        detail: `${inventory?.endpointCount} endpoint(s) observed, `
          + `${inventory?.coveredEndpointCount} covered by an API test, `
          + `${inventory?.baselinedEndpointCount} with a baseline; `
          + `GET /api/accounts testCount=${accountsEntry?.testCount}`,
        metrics: {
          endpoints: inventory?.endpointCount ?? 0,
          covered: inventory?.coveredEndpointCount ?? 0
        },
        evidence: { 'inventory.json': inventory }
      };
    }
  }, context);

  // ---- CON-002: baselines are captured from what was observed ------------
  await golden({
    id: 'CON-002',
    objective: 'Contract baselines are inferred from responses the application actually gave',
    preconditions: ['discovery has observed the API'],
    input: 'Capture baselines for every discovered endpoint',
    expected: 'A baseline per endpoint with a usable JSON sample, each recording the fields '
      + 'that response carried; endpoints with no usable sample skipped rather than '
      + 'baselined as empty',
    evidence: ['baselines.json'],
    severity: 'critical',
    run: async () => {
      const result = await captureBaselines(tenant, { applicationId: application.id });
      const accountsBaseline = (result?.baselines ?? [])
        .find(baseline => baseline.urlTemplate.endsWith('/api/accounts'));

      return {
        pass: (result?.captured ?? 0) > 0
          && accountsBaseline !== undefined
          && accountsBaseline.fieldCount > 5
          && accountsBaseline.version === 1,
        detail: `${result?.captured} baseline(s) captured, ${result?.skipped} skipped; `
          + `GET /api/accounts v${accountsBaseline?.version} with `
          + `${accountsBaseline?.fieldCount} field(s)`,
        metrics: { captured: result?.captured ?? 0, skipped: result?.skipped ?? 0 },
        evidence: { 'baselines.json': result }
      };
    }
  }, context);

  // ---- CON-003: an unchanged API produces no differences -----------------
  await golden({
    id: 'CON-003',
    objective: 'An unchanged API produces no contract differences at all',
    preconditions: ['baselines captured', 'no faults enabled'],
    input: 'A run of the accounts test against the unchanged application',
    expected: 'Zero differences of any kind — the check is quiet when nothing has moved',
    evidence: ['changes.json'],
    severity: 'critical',
    run: async () => {
      const { testRun, changes } = await runWithFault({}, 'CON-003');

      return {
        // A check that reports differences against an unchanged application is worse than
        // no check: every real finding afterwards is noise to whoever reads it.
        pass: testRun?.status === 'passed'
          && changes?.breakingCount === 0
          && changes?.potentiallyBreakingCount === 0
          && changes?.nonBreakingCount === 0,
        detail: `run ${testRun?.status}; ${changes?.breakingCount} breaking, `
          + `${changes?.potentiallyBreakingCount} potentially breaking, `
          + `${changes?.nonBreakingCount} non-breaking`,
        evidence: { 'changes.json': changes }
      };
    }
  }, context);

  // ---- CON-004: a removed field is breaking ------------------------------
  await golden({
    id: 'CON-004',
    objective: 'A field the API stops returning is classified as a breaking change',
    preconditions: ['baselines captured', 'FAULT_API_FIELD_REMOVED enabled'],
    input: 'A run of the accounts test while sortCode is no longer returned',
    expected: 'A breaking change naming the field, while the test itself still passes — '
      + 'the endpoint answers 200 and every assertion holds',
    evidence: ['changes.json'],
    severity: 'critical',
    run: async () => {
      const { testRun, changes } = await runWithFault({ FAULT_API_FIELD_REMOVED: true }, 'CON-004');
      const breaking = (changes?.changes ?? []).filter(change => change.kind === 'breaking');
      const sortCode = breaking.find(change => change.path.includes('sortCode'));

      return {
        // The test passing is the point. This is exactly the class of change that no
        // status check and no UI assertion notices.
        pass: testRun?.status === 'passed'
          && sortCode !== undefined
          && sortCode.baselineType === 'string'
          && (sortCode.observedType ?? null) === null
          && sortCode.description.includes('now absent'),
        detail: `the test ${testRun?.status} while ${breaking.length} breaking change(s) were found; `
          + `${sortCode?.path}: ${sortCode?.description}`,
        metrics: { breaking: changes?.breakingCount ?? 0 },
        evidence: { 'changes.json': changes }
      };
    }
  }, context);

  // ---- CON-005: a changed type is breaking -------------------------------
  await golden({
    id: 'CON-005',
    objective: "A field whose type changes is classified as a breaking change",
    preconditions: ['baselines captured', 'FAULT_API_FIELD_TYPE_CHANGED enabled'],
    input: 'A run of the accounts test while balance is returned as a string',
    expected: 'A breaking change naming both types',
    evidence: ['changes.json'],
    severity: 'critical',
    run: async () => {
      const { testRun, changes } = await runWithFault({ FAULT_API_FIELD_TYPE_CHANGED: true }, 'CON-005');
      const balance = (changes?.changes ?? [])
        .find(change => change.path.includes('balance') && change.kind === 'breaking');

      return {
        pass: testRun?.status === 'passed'
          && balance !== undefined
          && balance.baselineType === 'number'
          && balance.observedType === 'string',
        detail: `the test ${testRun?.status}; ${balance?.path}: `
          + `${balance?.baselineType} → ${balance?.observedType} (${balance?.kind})`,
        evidence: { 'changes.json': changes }
      };
    }
  }, context);

  // ---- CON-006: a field that becomes nullable is potentially breaking ----
  await golden({
    id: 'CON-006',
    objective: 'A field that can now be null is classified as potentially breaking, not breaking',
    preconditions: ['baselines captured', 'FAULT_API_FIELD_NULLABLE enabled'],
    input: "A run of the accounts test while one account's sortCode is null",
    expected: 'A potentially-breaking change: callers that null-check are fine, callers that '
      + 'do not are broken, and which of those a team has is not something QA NXT can know',
    evidence: ['changes.json'],
    severity: 'critical',
    run: async () => {
      const { testRun, changes } = await runWithFault({ FAULT_API_FIELD_NULLABLE: true }, 'CON-006');
      const sortCode = (changes?.changes ?? []).find(change => change.path.includes('sortCode'));

      return {
        pass: testRun?.status === 'passed'
          && sortCode?.kind === 'potentiallyBreaking'
          && sortCode.observedType?.includes('null')
          && changes?.breakingCount === 0,
        detail: `the test ${testRun?.status}; ${sortCode?.path} classified `
          + `"${sortCode?.kind}" (${sortCode?.baselineType} → ${sortCode?.observedType}); `
          + `${changes?.breakingCount} breaking`,
        evidence: { 'changes.json': changes }
      };
    }
  }, context);

  // ---- CON-007: a new field is not breaking ------------------------------
  await golden({
    id: 'CON-007',
    objective: 'A new field is reported as non-breaking and does not fail anything',
    preconditions: ['baselines captured', 'FAULT_API_FIELD_ADDED enabled'],
    input: 'A run of the accounts test while each account carries a new nickname field',
    expected: 'A non-breaking change, zero breaking, zero potentially breaking',
    evidence: ['changes.json'],
    severity: 'critical',
    run: async () => {
      const { testRun, changes } = await runWithFault({ FAULT_API_FIELD_ADDED: true }, 'CON-007');
      const nickname = (changes?.changes ?? []).find(change => change.path.includes('nickname'));

      return {
        // A check that called an added field breaking would be switched off within a week,
        // which is the failure mode this test exists to prevent.
        pass: testRun?.status === 'passed'
          && nickname?.kind === 'nonBreaking'
          && changes?.breakingCount === 0
          && changes?.potentiallyBreakingCount === 0,
        detail: `the test ${testRun?.status}; ${nickname?.path} classified "${nickname?.kind}"; `
          + `${changes?.breakingCount} breaking, ${changes?.potentiallyBreakingCount} potentially breaking`,
        evidence: { 'changes.json': changes }
      };
    }
  }, context);

  // ---- CON-008: the gate can stop a release on a breaking change ---------
  await golden({
    id: 'CON-008',
    objective: 'A quality gate rule over breaking contract changes fires when one is found',
    preconditions: ['a rule "no breaking contract changes"', 'FAULT_API_FIELD_REMOVED enabled'],
    input: 'A run of the accounts test with the field removed and the rule enabled',
    expected: 'The gate measures ContractBreakingChangeCount, the rule fails, and the run '
      + 'is blocked even though every test passed',
    evidence: ['gate.json'],
    severity: 'critical',
    run: async () => {
      await createGateRule(tenant, project.id, {
        name: 'No breaking contract changes',
        metric: 'contractBreakingChangeCount',
        operator: 'equal',
        threshold: 0,
        action: 'fail',
        message: 'An API this release publishes has changed in a way that breaks its callers.'
      });

      const { testRun } = await runWithFault({ FAULT_API_FIELD_REMOVED: true }, 'CON-008');
      const gate = await qualityGate(tenant, testRun.id);
      const rule = (gate?.rules ?? [])
        .find(candidate => candidate.metric === 'contractBreakingChangeCount');

      return {
        // Every test passed and the release is still stopped. That is the whole argument
        // for contract checking as a gate rather than as a report.
        pass: testRun?.status === 'passed'
          && rule?.measured === true
          && rule.passed === false
          && gate?.outcome === 'fail'
          && (gate?.metrics?.ContractBreakingChangeCount ?? 0) > 0,
        detail: `run ${testRun?.status}; ContractBreakingChangeCount=`
          + `${gate?.metrics?.ContractBreakingChangeCount}; rule measured=${rule?.measured} `
          + `passed=${rule?.passed}; outcome ${gate?.outcome}`,
        metrics: { breakingChanges: gate?.metrics?.ContractBreakingChangeCount ?? 0 },
        evidence: { 'gate.json': gate }
      };
    }
  }, context);

  // ---- CON-009: acknowledging a change is a recorded decision ------------
  await golden({
    id: 'CON-009',
    objective: 'A breaking change can be acknowledged, and the acknowledgement carries forward',
    preconditions: ['CON-008 produced a breaking change'],
    input: 'Acknowledge the removed-field change, then run again with the same fault',
    expected: 'The acknowledgement is refused without a reason, accepted with one, and the '
      + 'same change on the next run comes back already acknowledged',
    evidence: ['acknowledgement.json', 'second-run-changes.json'],
    severity: 'high',
    run: async () => {
      const first = await runWithFault({ FAULT_API_FIELD_REMOVED: true }, 'CON-009a');
      const change = (first.changes?.changes ?? [])
        .find(candidate => candidate.kind === 'breaking' && candidate.path.includes('sortCode'));

      if (!change) {
        return { pass: false, detail: 'no breaking change was produced to acknowledge' };
      }

      // A reason is required. An acknowledgement with no reason is a rubber stamp, and a
      // rubber stamp is what makes an audit trail worthless.
      const withoutReason = await request(
        `/api/v1/api-contracts/changes/${change.id}/acknowledge`,
        { token: tenant.token, method: 'POST', body: { note: 'ok' } });

      const withReason = await request(
        `/api/v1/api-contracts/changes/${change.id}/acknowledge`,
        {
          token: tenant.token, method: 'POST',
          body: { note: 'sortCode moved to the payments API in release 2.4; the mobile client was updated first.' }
        });

      const second = await runWithFault({ FAULT_API_FIELD_REMOVED: true }, 'CON-009b');
      const carried = (second.changes?.changes ?? [])
        .find(candidate => candidate.path.includes('sortCode') && candidate.kind === 'breaking');

      return {
        pass: withoutReason.status === 400
          && withReason.status === 204
          && carried?.isAcknowledged === true,
        detail: `without a reason: ${withoutReason.status}; with one: ${withReason.status}; `
          + `the same change on the next run: acknowledged=${carried?.isAcknowledged}`,
        evidence: {
          'acknowledgement.json': {
            refusedWithoutReason: { status: withoutReason.status, body: withoutReason.json },
            accepted: { status: withReason.status }
          },
          'second-run-changes.json': second.changes
        }
      };
    }
  }, context);

  // ---- CON-010: generation writes tests about what was observed ----------
  await golden({
    id: 'CON-010',
    objective: 'API tests are generated from the observed inventory, including negative ones',
    preconditions: ['discovery has observed the API'],
    input: 'Generate API tests for the application, read-only endpoints only',
    expected: 'A positive test per endpoint, an unauthenticated-refusal test for each that '
      + 'required credentials, a not-found test for each templated one, and no test at all '
      + 'for a mutating endpoint',
    evidence: ['generated.json', 'sample-test.json'],
    severity: 'critical',
    run: async () => {
      const generated = await generateApiTests(tenant, {
        applicationId: application.id,
        suiteName: 'Contracts — generated',
        maxTests: 60
      });

      const tests = generated?.tests ?? [];
      const security = tests.filter(test => test.name.includes('refuses an unauthenticated caller'));
      const notFound = tests.filter(test => test.name.includes('does not exist'));
      const positive = tests.filter(test =>
        test.name.includes('answers as observed'));

      // Every generated test is stored through the ordinary authoring path, so it is
      // subject to the same validation — including the rule that a test must assert
      // something. Reading one back proves the generator did not bypass it.
      const sample = tests.length > 0 ? await testCase(tenant, tests[0].testCaseId) : null;
      const sampleAssertions = (sample?.steps ?? [])
        .reduce((total, step) => total + (step.assertions?.length ?? 0), 0);

      const skippedMutating = (generated?.notes ?? [])
        .some(text => text.includes('changes data'));

      return {
        pass: positive.length > 0
          && security.length > 0
          && notFound.length > 0
          && sampleAssertions > 0
          && skippedMutating,
        detail: `${generated?.testsCreated} test(s) from ${generated?.endpointsConsidered} endpoint(s): `
          + `${positive.length} positive, ${security.length} unauthenticated, ${notFound.length} not-found; `
          + `${generated?.endpointsSkipped} endpoint(s) skipped as mutating; `
          + `the first test carries ${sampleAssertions} assertion(s)`,
        metrics: {
          generated: generated?.testsCreated ?? 0,
          positive: positive.length,
          security: security.length,
          notFound: notFound.length
        },
        evidence: { 'generated.json': generated, 'sample-test.json': sample }
      };
    }
  }, context);

  // ---- CON-011: generated tests actually run, and actually pass ----------
  await golden({
    id: 'CON-011',
    objective: 'A generated API test executes and passes against the application it was generated from',
    preconditions: ['CON-010 generated tests', 'no faults enabled'],
    input: 'Run the generated unauthenticated-refusal test',
    expected: 'It passes: the endpoint still refuses a caller with no credentials',
    evidence: ['execution.json'],
    severity: 'critical',
    run: async () => {
      await lab.reset(BANK);
      const generated = await request(
        `/api/v1/testcases?projectId=${project.id}&kind=api&tag=generated`,
        { token: tenant.token });

      const securityTest = (generated.json ?? [])
        .find(test => test.name.includes('refuses an unauthenticated caller'));

      if (!securityTest) {
        return { pass: false, detail: 'no generated security test was found to run' };
      }

      const { run: testRun, executions, detail } = await execute(tenant, {
        projectId: project.id, testCaseId: securityTest.id, name: 'CON-011', timeoutMs: 180_000
      });

      return {
        pass: testRun?.status === 'passed' && executions[0]?.status === 'passed',
        detail: `"${securityTest.name}" ran and ${testRun?.status} in ${executions[0]?.durationMs}ms`,
        evidence: { 'execution.json': detail }
      };
    }
  }, context);

  // ---- CON-012: a generated security test fails when authorization goes --
  await golden({
    id: 'CON-012',
    objective: 'A generated unauthenticated-refusal test fails if the endpoint stops requiring credentials',
    preconditions: ['a generated security test exists'],
    input: 'An API test asserting a refusal, run against an endpoint that answers anyway',
    expected: 'A failure — this is the check that catches authorization being removed, '
      + 'which every signed-in test carries on passing through',
    evidence: ['execution.json'],
    severity: 'critical',
    run: async () => {
      // The lab bank has no "authorization removed" fault, so the equivalent is asserted
      // directly: a test that requires a refusal, pointed at an endpoint that does not
      // refuse. If this passed, the generated security tests would be decoration.
      await lab.reset(BANK);
      const open = await requireApiTest(tenant, {
        projectId: project.id,
        applicationId: application.id,
        suiteName: 'Contracts — generated',
        name: 'A public endpoint is required to refuse, and does not',
        steps: [{
          description: 'Call an endpoint that needs no credentials, requiring a refusal',
          request: { method: 'GET', path: '/health', auth: { mode: 'none' }, failOnErrorStatus: false },
          assertions: [{
            type: 'responseStatusIn', expected: '401,403',
            Description: 'The endpoint refuses a caller with no credentials'
          }]
        }]
      });

      const { run: testRun, executions, detail } = await execute(tenant, {
        projectId: project.id, testCaseId: open.testCaseId, name: 'CON-012', timeoutMs: 180_000
      });

      const message = executions[0]?.errorMessage ?? detail?.errorMessage ?? '';

      return {
        pass: testRun?.status === 'failed' && message.includes('200'),
        detail: `run ${testRun?.status}; "${message.slice(0, 160)}"`,
        evidence: { 'execution.json': detail }
      };
    }
  }, context);

  // ---- CON-013: replacing a baseline is a recorded decision --------------
  await golden({
    id: 'CON-013',
    objective: 'Accepting a new contract baseline requires a reason and is versioned',
    preconditions: ['a baseline exists for the accounts endpoint'],
    input: 'A replace without a note, then one with a note',
    expected: 'Refused without a reason; accepted with one, and the new baseline is v2 '
      + 'rather than overwriting v1',
    evidence: ['refusal.json', 'replacement.json'],
    severity: 'high',
    run: async () => {
      const withoutNote = await request('/api/v1/api-contracts/baselines', {
        token: tenant.token, method: 'POST',
        body: { applicationId: application.id, replace: true }
      });

      const withNote = await captureBaselines(tenant, {
        applicationId: application.id,
        replace: true,
        note: 'Accepting the 2.4 response shape after the mobile client was updated.'
      });

      const accountsBaseline = (withNote?.baselines ?? [])
        .find(baseline => baseline.urlTemplate.endsWith('/api/accounts'));

      return {
        pass: withoutNote.status === 400
          && (withNote?.replaced ?? 0) > 0
          && (accountsBaseline?.version ?? 0) >= 2,
        detail: `without a note: ${withoutNote.status}; with one: `
          + `${withNote?.captured} captured, ${withNote?.replaced} replaced; `
          + `GET /api/accounts is now v${accountsBaseline?.version}`,
        evidence: { 'refusal.json': withoutNote.json, 'replacement.json': withNote }
      };
    }
  }, context);

  // ---- CON-014: discovery can be the source of a contract check ----------
  await golden({
    id: 'CON-014',
    objective: 'A contract check can read what a crawl observed, not only what an API test called',
    preconditions: ['a completed discovery run', 'baselines captured'],
    input: `Contract check against discovery run ${discovery?.id ?? '(none)'}`,
    expected: 'A result that names how many endpoints it compared, for teams whose API '
      + 'coverage comes from driving the UI',
    evidence: ['check.json'],
    severity: 'medium',
    run: async () => {
      if (!discovery?.id) return { pass: false, detail: 'discovery did not complete' };

      const result = await request(`/api/v1/api-contracts/check/discovery/${discovery.id}`, {
        token: tenant.token, method: 'POST'
      });

      return {
        pass: result.ok && (result.json?.endpointsWithBaseline ?? 0) > 0,
        detail: result.ok
          ? `${result.json.endpointsWithBaseline} endpoint(s) compared from the crawl, `
            + `${result.json.breakingCount} breaking`
          : `the check was refused: ${result.status} ${result.text.slice(0, 200)}`,
        evidence: { 'check.json': result.json ?? result.text }
      };
    }
  }, context);
}
