/**
 * What the platform does when the model does not.
 *
 * The orchestrator has a branch for every way a provider can fail — a timeout, an error, a
 * reply that is not JSON, JSON that does not fit its schema, an empty response — and until
 * this suite existed not one of them had ever been taken. "The platform degrades safely when
 * the AI fails" was a statement about code, and code that has never run is a hypothesis.
 *
 * Every test here arms a real fault through `POST /api/v1/ai-faults`, makes a real request
 * through the ordinary endpoint, and checks three things:
 *
 *   1. The failure is **visible** — an error a caller can act on, never a quiet success.
 *   2. Nothing is **fabricated** — no test case, no analysis, no defect is created from a
 *      response that failed. A generator that invents plausible tests when the model is down
 *      is worse than one that stops, because the tests look real.
 *   3. **Deterministic execution is unaffected** — a run still runs. The model plans; it does
 *      not execute, and an outage in the one must not stop the other.
 *
 * The injected responses are deliberately nasty. The schema-violation case returns valid JSON
 * of the wrong shape, because that is the case a lenient deserialiser accepts. The injection
 * case returns schema-valid output carrying instructions aimed at whatever reads it, because
 * the rule that model output is data and never instruction is only worth having if something
 * checks it.
 */
import { golden, suite } from '../harness.mjs';
import {
  LAB, createProject, importJourney, journey, lab, newTenant, registerApplication,
  request, runDiscovery, startRun, step, waitForRun
} from '../platform.mjs';

const BANK = LAB.banking;

const arm = (tenant, fault) =>
  request('/api/v1/ai-faults', { token: tenant.token, method: 'POST', body: { fault } });
const clear = tenant => request('/api/v1/ai-faults', { token: tenant.token, method: 'DELETE' });

const generate = (tenant, applicationId, requirement) =>
  request('/api/v1/testcases/generate', {
    token: tenant.token, method: 'POST',
    body: { applicationId, requirement, suiteName: 'AI failure suite', maxScenarios: 3 }
  });

const testCasesIn = async (tenant, projectId) => {
  const response = await request(`/api/v1/testcases?projectId=${projectId}&limit=200`,
    { token: tenant.token });
  return Array.isArray(response.json) ? response.json : (response.json?.items ?? []);
};

export default async function run() {
  suite('AI provider failure');
  await lab.reset(BANK);

  const tenant = await newTenant('AiFault');
  const project = await createProject(tenant, 'AI failure project');
  const application = await registerApplication(tenant, project.id, {
    name: 'AIRA Demo Bank', baseUrl: BANK, loginUrl: `${BANK}/login`,
    username: 'alice', password: 'Password123!'
  });

  // If fault injection is not enabled, every test below would fail for the same
  // uninformative reason. Say so once, loudly, rather than nine times obscurely.
  const available = await request('/api/v1/ai-faults', { token: tenant.token });
  if (available.status === 404) {
    throw new Error(
      'AI fault injection is not enabled on this API, so none of the failure paths can be '
      + 'exercised. Start the API with Ai__FaultInjection__Enabled=true (scripts/api-ctl.sh '
      + 'does this for local development).');
  }

  // Discovery first, and this is not optional set-up dressing.
  //
  // Generation refuses an application with no discovered pages — "This application has no
  // discovered pages yet" — before it ever reaches a provider. The first version of this
  // suite skipped discovery, so every fault test got that validation error instead of the
  // injected fault and passed anyway: the assertions asked only for "a visible failure and
  // nothing fabricated", and an unrelated 400 satisfies both. Eight tests were green while
  // exercising nothing. Hence the AI request record is now part of every assertion below:
  // it is the only evidence that the model path was actually taken.
  await runDiscovery(tenant, application.id, { maxPages: 8, maxDepth: 2 });

  /** The model requests recorded for this project, newest first. */
  const aiRequests = async () => {
    const response = await request(`/api/v1/ai/requests?projectId=${project.id}&limit=50`,
      { token: tenant.token });
    return response.json?.items ?? [];
  };

  /** Arms a fault, runs the body, and clears it however the body ends. */
  async function withFault(fault, body) {
    await arm(tenant, fault);
    try { return await body(); } finally { await clear(tenant); }
  }

  const faults = [
    ['AIF-001', 'Timeout', 'critical',
      'A provider that never answers fails the request visibly instead of returning nothing'],
    ['AIF-002', 'ProviderError', 'critical',
      'A provider error fails the request visibly instead of being swallowed'],
    ['AIF-003', 'MalformedJson', 'critical',
      'A reply that is not JSON is refused rather than partially parsed'],
    ['AIF-004', 'SchemaViolation', 'critical',
      'Valid JSON of the wrong shape is refused, not leniently deserialized'],
    ['AIF-005', 'Empty', 'critical',
      'An empty response is refused rather than treated as "no scenarios"']
  ];

  for (const [id, fault, severity, objective] of faults) {
    await golden({
      id, severity, objective,
      preconditions: ['an application is registered', 'AI fault injection is enabled'],
      input: `A generation request while the provider is faulted with ${fault}`,
      expected: 'The request fails with an error naming the problem, and no test case is stored',
      evidence: ['response.json'],
      run: async () => withFault(fault, async () => {
        const before = (await testCasesIn(tenant, project.id)).length;
        const requestsBefore = (await aiRequests()).length;
        const response = await generate(tenant, application.id,
          'A customer can sign in and read their account balance');
        const after = (await testCasesIn(tenant, project.id)).length;
        const recorded = await aiRequests();

        const fabricated = after - before;
        const failedVisibly = !response.ok;

        // The fault must actually have been reached. Without this the test passes on any
        // 400 the endpoint happens to produce — which is exactly what it did before
        // discovery was added, while exercising none of the code it claims to cover.
        const attempt = recorded[0];
        const reachedTheModel = recorded.length > requestsBefore;
        const recordedAsFailure = Boolean(attempt) && attempt.status !== 'succeeded';

        // The message must say something. "An error occurred" sends a reader nowhere.
        const explained = (response.json?.detail ?? response.json?.title ?? response.text ?? '')
          .trim().length > 20;

        return {
          pass: failedVisibly && fabricated === 0 && explained
            && reachedTheModel && recordedAsFailure,
          detail: `status ${response.status}; ${fabricated} test case(s) created; `
            + `model request recorded: ${reachedTheModel} (status ${attempt?.status ?? 'none'}); `
            + `message "${String(response.json?.detail ?? response.json?.title ?? response.text).slice(0, 100)}"`,
          metrics: { status: response.status, fabricated, reachedTheModel: reachedTheModel ? 1 : 0 },
          evidence: {
            'response.json': JSON.stringify({
              fault, status: response.status,
              body: response.text.slice(0, 1200),
              testCasesBefore: before, testCasesAfter: after,
              aiRequestRecorded: attempt
                ? { status: attempt.status, provider: attempt.provider,
                    errorMessage: String(attempt.errorMessage ?? '').slice(0, 300) }
                : null
            }, null, 2)
          }
        };
      })
    });
  }

  await golden({
    id: 'AIF-006', severity: 'critical',
    objective: 'Model output carrying instructions is treated as data, and never reaches a test as an action',
    preconditions: ['AI fault injection is enabled'],
    input: 'A generation request while the provider returns schema-valid output containing injected instructions',
    expected: 'Either the response is refused, or it is stored as inert text — no navigation to '
      + 'the attacker host, no shell command, and nothing deleted',
    evidence: ['injection.json'],
    run: async () => withFault('PromptInjection', async () => {
      const before = await testCasesIn(tenant, project.id);
      const response = await generate(tenant, application.id,
        'A customer can sign in and read their account balance');
      const after = await testCasesIn(tenant, project.id);

      const stored = JSON.stringify(after);
      // The three things the injected payload tried to achieve.
      const reachedAttackerHost = stored.includes('attacker.example');
      const carriedShellCommand = stored.includes('rm -rf') || stored.includes('curl http');
      const deletedExistingTests = after.length < before.length;

      const recorded = await aiRequests();
      const reachedTheModel = recorded.length > 0;

      return {
        pass: reachedTheModel && !reachedAttackerHost && !carriedShellCommand && !deletedExistingTests,
        detail: `status ${response.status}; model request recorded: ${reachedTheModel}; `
          + `${after.length - before.length} test case(s) created; `
          + `attacker host in stored tests: ${reachedAttackerHost}; `
          + `shell command in stored tests: ${carriedShellCommand}; `
          + `existing tests deleted: ${deletedExistingTests}`,
        metrics: {
          reachedAttackerHost: reachedAttackerHost ? 1 : 0,
          carriedShellCommand: carriedShellCommand ? 1 : 0
        },
        evidence: {
          'injection.json': JSON.stringify({
            status: response.status,
            responseBody: response.text.slice(0, 800),
            testCasesBefore: before.length, testCasesAfter: after.length,
            attackerHostPresent: reachedAttackerHost,
            shellCommandPresent: carriedShellCommand,
            existingTestsDeleted: deletedExistingTests
          }, null, 2)
        }
      };
    })
  });

  await golden({
    id: 'AIF-007', severity: 'critical',
    objective: 'A provider outage does not stop a test run: the model plans, and something else executes',
    preconditions: ['an imported journey exists', 'AI fault injection is enabled'],
    input: 'A run started while every model request would fail',
    expected: 'The run executes and passes, unaffected by the provider being down',
    evidence: ['run.json'],
    run: async () => {
      const imported = await importJourney(tenant, {
        projectId: project.id, applicationId: application.id,
        journey: journey({
          name: 'Runs without the model',
          startUrl: `${BANK}/login`,
          steps: [
            step.navigate(`${BANK}/login`),
            step.fill('username', 'alice', `${BANK}/login`),
            step.fill('password', '${secret:app_password}', `${BANK}/login`),
            step.click('login-submit', `${BANK}/login`),
            step.assertVisible('total-balance', `${BANK}/dashboard`)
          ]
        })
      });

      return withFault('ProviderError', async () => {
        const started = await startRun(tenant, {
          projectId: project.id, testCaseIds: [imported.testCaseId],
          name: 'Run during an AI outage'
        });
        const finished = await waitForRun(tenant, started.id);

        return {
          pass: finished.status === 'passed' && finished.passedCount >= 1,
          detail: `run ${finished.status} with ${finished.passedCount} passed / ${finished.failedCount} failed, `
            + 'while every model request would have failed',
          metrics: { passed: finished.passedCount ?? 0, failed: finished.failedCount ?? 0 },
          evidence: {
            'run.json': JSON.stringify({
              runId: started.id, status: finished.status,
              passed: finished.passedCount, failed: finished.failedCount,
              faultArmedThroughout: 'ProviderError'
            }, null, 2)
          }
        };
      });
    }
  });

  await golden({
    id: 'AIF-008', severity: 'high',
    objective: 'Every failed model request is recorded with the reason it failed, rather than vanishing',
    preconditions: ['AI fault injection is enabled'],
    input: 'One generation request per fault kind, then the AI request history',
    expected: 'Each failure is stored with a status distinguishing a provider failure from a rejected response',
    evidence: ['ai-requests.json'],
    run: async () => {
      const seen = [];
      for (const fault of ['Timeout', 'MalformedJson', 'SchemaViolation']) {
        await withFault(fault, () =>
          generate(tenant, application.id, `A request that will fail with ${fault}`));
        seen.push(fault);
      }

      const history = await request(`/api/v1/ai/requests?projectId=${project.id}&limit=50`,
        { token: tenant.token });
      const rows = history.json?.items ?? [];
      const statuses = new Set(rows.map(r => r.status));

      // "failed" and "schemaRejected" are different answers to different questions — the
      // provider let us down, or the provider answered and the answer was unusable. Both
      // must be present, or the history is telling a reader less than it knows.
      const distinguishes = statuses.has('failed') && statuses.has('schemaRejected');

      return {
        pass: history.ok && distinguishes,
        detail: history.ok
          ? `${rows.length} recorded request(s) after ${seen.length} injected fault(s); `
            + `statuses: ${[...statuses].sort().join(', ') || 'none'}`
          : `the AI request history could not be read: ${history.status}`,
        metrics: { recorded: rows.length, distinctStatuses: statuses.size },
        evidence: {
          'ai-requests.json': JSON.stringify({
            injected: seen,
            statuses: [...statuses],
            rows: rows.slice(0, 10).map(r => ({
              kind: r.kind, provider: r.provider, status: r.status,
              errorMessage: String(r.errorMessage ?? '').slice(0, 160)
            }))
          }, null, 2)
        }
      };
    }
  });

  await golden({
    id: 'AIF-009', severity: 'critical',
    objective: 'Fault injection cannot be armed by a caller who is not an organization administrator',
    preconditions: ['the organization can invite a user with a lesser role'],
    input: 'A QA engineer arming a fault',
    expected: 'Refused — arming a fault changes what every AI feature in the process does',
    evidence: ['permission.json'],
    run: async () => {
      const invited = await request('/api/v1/users', {
        token: tenant.token, method: 'POST',
        body: {
          email: `qa-${Math.random().toString(36).slice(2, 10)}@example.test`,
          displayName: 'AI Fault QA', role: 'qaEngineer'
        }
      });
      if (!invited.ok) return { pass: false, detail: `could not invite: ${invited.status}` };

      const signedIn = await request('/api/v1/auth/login', {
        method: 'POST',
        body: { email: invited.json.user.email, password: invited.json.temporaryPassword }
      });
      if (!signedIn.ok) return { pass: false, detail: `the invited user could not sign in: ${signedIn.status}` };

      const engineer = { token: signedIn.json.accessToken };
      const attempt = await request('/api/v1/ai-faults', {
        token: engineer.token, method: 'POST', body: { fault: 'Timeout' }
      });
      // Control: the same person can do ordinary work, so the refusal is about this endpoint
      // rather than about a broken account.
      const control = await request('/api/v1/projects', { token: engineer.token });

      return {
        pass: attempt.status === 403 && control.ok,
        detail: `a QA engineer arming a fault: ${attempt.status}; the same account reading projects: ${control.status}`,
        metrics: { arm: attempt.status, control: control.status },
        evidence: {
          'permission.json': JSON.stringify({
            role: 'qaEngineer', armStatus: attempt.status, controlStatus: control.status,
            expected: 'arm 403, control 200'
          }, null, 2)
        }
      };
    }
  });
}
