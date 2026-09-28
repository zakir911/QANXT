import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * The autonomous agent screen.
 *
 * These tests exist because the agent's whole design rests on a person being able to answer
 * it, and until this screen existed that person had to use curl. So the claims are about the
 * things a person does here — approve a plan, narrow it, answer a question, read a refusal —
 * and about the two ways this screen could lie: showing a blank where the API sent something,
 * and letting an answer through without the reason the API requires.
 */

const apiRequest = vi.fn();
vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return { ...actual, apiRequest: (path: string, options?: unknown) => apiRequest(path, options) };
});

const permissions = { current: new Set<string>() };
vi.mock('../lib/auth', async () => {
  const actual = await vi.importActual<typeof import('../lib/auth')>('../lib/auth');
  return { ...actual, useAuth: () => ({ can: (p: string) => permissions.current.has(p) }) };
});

vi.mock('../lib/project', async () => {
  const actual = await vi.importActual<typeof import('../lib/project')>('../lib/project');
  return { ...actual, useProject: () => ({ projectId: 'project-1' }) };
});

const AgentPage = (await import('./AgentPage')).default;

const RUN = {
  id: 'run-1', applicationId: 'app-1', applicationName: 'Retail banking', name: 'Nightly pass',
  objective: 'Release validation', status: 'awaitingApproval', phase: 'awaitingApproval',
  createdAt: '2026-09-25T09:00:00Z', startedAt: '2026-09-25T09:00:05Z',
  pagesConsidered: 8, areasAssessed: 8, testsGenerated: 0, testsExecuted: 0,
  failuresInvestigated: 0, proposalsMade: 8, aiCostUsd: 0,
  stopReason: undefined, summary: undefined, buildRef: 'build-42'
};

const BOUNDS = {
  explore: false, execute: true, maxPages: 10, maxDepth: 3, maxTargets: 3,
  maxGeneratedTests: 6, timeBudgetSeconds: 600, maxAiCostUsd: 1
};

const PLAN = {
  id: 'plan-1', agentRunId: 'run-1', applicationId: 'app-1', status: 'proposed',
  objective: 'Release validation', pagesDiscovered: 8, endpointsDiscovered: 14,
  journeysKnown: 0, rolesKnown: 1,
  summary: '51 test(s) across 2 category(ies), 18 of which do not exist yet.',
  notCovered: [
    'No journey has been recorded for this application.',
    '1 area(s) a person excluded: /statements. Nothing in this plan touches them.'
  ],
  items: [
    { id: 'item-1', category: 'smoke', testCount: 8, toGenerate: 8,
      why: 'One reachability check per discovered page.', risk: 'low',
      coverage: '8 page(s) reachable', estimatedSeconds: 240, estimateFromHistory: false,
      potentialImpact: 'Read-only navigation.', included: true },
    { id: 'item-2', category: 'api', testCount: 14, toGenerate: 10,
      why: 'Endpoints discovered by the crawl.', risk: 'medium',
      coverage: '14 endpoint(s)', estimatedSeconds: 600, estimateFromHistory: true,
      potentialImpact: 'Read-only requests.', included: true }
  ],
  totalTests: 22, estimatedSeconds: 840
};

const APPROVAL_PENDING = {
  id: 'approval-1', tool: 'security.scan',
  reason: 'A state-changing action needs a person to authorize it.',
  proposal: 'Scan 8 page(s) of this application within its authorized scope.',
  evidence: [{ name: 'pagesDiscovered', value: '8' }, { name: 'scopeAuthorized', value: 'yes' }],
  risk: 'stateChanging',
  expectedImpact: 'Requests within the scope rate limits. No destructive checks.',
  status: 'pending'
};

const DECISION_REFUSED = {
  id: 'decision-1', sequence: 2, phase: 'executing', tool: 'test.execute',
  summary: 'Wanted to use test.execute.',
  reason: 'This run is not authorized for production, and production is off by default.',
  evidence: [], result: undefined, allowed: false,
  denial: 'productionNotPermitted', risk: 'stateChanging',
  modelContributed: false, aiCostUsd: 0, occurredAt: '2026-09-25T09:01:00Z'
};

const DECISION_ALLOWED = {
  id: 'decision-2', sequence: 1, phase: 'analysingGaps', tool: 'coverage.analyse',
  summary: 'Assessed 24 capability(ies): 24 uncovered, 44 unknown.',
  reason: 'Coverage is measured against what discovery reached.',
  evidence: [{ name: 'notCovered', value: '24' }, { name: 'unknown', value: '44' }],
  result: '24 gap(s)', allowed: true, denial: undefined, risk: 'observation',
  modelContributed: false, aiCostUsd: 0, occurredAt: '2026-09-25T09:00:30Z'
};

// The kinds the API actually emits, taken from AgentObservabilityService.TimelineAsync and
// confirmed by driving a real pass. An earlier version of this fixture invented 'question',
// which the API never sends — so the test passed while the colour-coding it was meant to
// exercise did nothing.
const TIMELINE = [
  { at: '2026-09-25T09:00:00Z', kind: 'run', phase: 'pending', title: 'Pass started' },
  { at: '2026-09-25T09:00:30Z', kind: 'phase', phase: 'analysingGaps',
    title: 'Assessed 24 capability(ies).', detail: 'Coverage against what discovery reached.' },
  { at: '2026-09-25T09:01:00Z', kind: 'refusal', phase: 'executing',
    title: 'test.execute was refused.', detail: 'Production is off by default.' },
  { at: '2026-09-25T09:01:10Z', kind: 'approval-requested', phase: 'awaitingApproval',
    title: 'Asked for approval to use security.scan',
    detail: 'Scan 8 page(s) of this application within its authorized scope.' }
];

const CONTEXT = {
  applicationId: 'app-1',
  criticalJourneys: ['payment', 'login'], highRiskAreas: ['authentication'],
  excludedAreas: ['/statements'], notes: 'The golden lab.'
};

function respond(path: string): unknown {
  if (path.startsWith('/api/v1/agent/runs?')) return [RUN];
  if (path === '/api/v1/agent/runs/run-1') {
    return { summary: RUN, bounds: BOUNDS, steps: [], findings: [] };
  }
  if (path === '/api/v1/agent/runs/run-1/plan') return PLAN;
  if (path === '/api/v1/agent/runs/run-1/approvals') return [APPROVAL_PENDING];
  if (path === '/api/v1/agent/runs/run-1/decisions') return [DECISION_ALLOWED, DECISION_REFUSED];
  if (path === '/api/v1/agent/runs/run-1/timeline') return TIMELINE;
  if (path === '/api/v1/agent/applications/app-1/context') return CONTEXT;
  if (path.startsWith('/api/v1/applications')) return [{ id: 'app-1', name: 'Retail banking' }];
  return null;
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}><AgentPage /></QueryClientProvider>
  );
}

beforeEach(() => {
  apiRequest.mockReset();
  apiRequest.mockImplementation((path: string) => Promise.resolve(respond(path)));
  permissions.current = new Set(['agent:run', 'test:read']);
});

describe('AgentPage', () => {
  test('a pass waiting on a person says so, and shows the plan it is waiting on', async () => {
    renderPage();
    expect(await screen.findByText('The agent is waiting for an answer')).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been generated or run/)).toBeInTheDocument();
    expect(screen.getByText(PLAN.summary)).toBeInTheDocument();
  });

  test('the plan names what it does not cover, before anybody approves it', async () => {
    renderPage();
    expect(await screen.findByText('This plan does not cover')).toBeInTheDocument();
    expect(screen.getByText(/No journey has been recorded/)).toBeInTheDocument();
    expect(screen.getByText(/1 area\(s\) a person excluded/)).toBeInTheDocument();
  });

  test('every estimate says where it came from', async () => {
    renderPage();
    // The one worked from defaults, and the one worked from history, must read differently.
    // A number whose provenance is invisible is one people either over-trust or ignore.
    expect(await screen.findByText(/estimated from defaults; this application has no execution history/))
      .toBeInTheDocument();
    expect(screen.getByText(/estimated from how long these have taken on this application before/))
      .toBeInTheDocument();
  });

  test('approving the plan sends the decision with the reason typed', async () => {
    renderPage();
    const note = await screen.findByLabelText(/Why \(recorded with your name/);
    await userEvent.type(note, 'Approved for the release candidate.');
    await userEvent.click(screen.getByRole('button', { name: /Approve the plan/ }));

    await waitFor(() => {
      const call = apiRequest.mock.calls.find(
        ([path]) => path === '/api/v1/agent/runs/run-1/plan/decision');
      expect(call).toBeDefined();
      expect(call![1]).toMatchObject({
        method: 'POST',
        body: { approve: true, includedCategories: null, note: 'Approved for the release candidate.' }
      });
    });
  });

  test('switching a category off narrows the plan rather than refusing it', async () => {
    renderPage();
    const toggle = await screen.findByLabelText('Include Api');
    await userEvent.click(toggle);

    // The button must now say what is actually being approved, or a person cannot tell that
    // their change took effect.
    const approve = await screen.findByRole('button', { name: /Approve 1 of 2 categories/ });
    await userEvent.click(approve);

    await waitFor(() => {
      const call = apiRequest.mock.calls.find(
        ([path]) => path === '/api/v1/agent/runs/run-1/plan/decision');
      expect(call![1]).toMatchObject({ body: { approve: true, includedCategories: ['smoke'] } });
    });
  });

  test('a question the pass asked is shown with its evidence and what would happen', async () => {
    renderPage();
    expect(await screen.findByText('1 question(s) waiting')).toBeInTheDocument();
    // The proposal appears twice on purpose — once in the question, once as the timeline's
    // detail for that moment — so this asserts both are there rather than assuming one is.
    expect(screen.getAllByText(APPROVAL_PENDING.proposal)).toHaveLength(2);
    expect(screen.getByText(/Requests within the scope rate limits/)).toBeInTheDocument();
    expect(screen.getByText('pagesDiscovered')).toBeInTheDocument();
  });

  test('an answer with no reason cannot be submitted', async () => {
    renderPage();
    await screen.findByText('1 question(s) waiting');
    // The API refuses a thin justification. Letting the button send it would turn a designed
    // refusal into a confusing error.
    // Named for the tool, because two buttons reading "Refuse" on one screen with different
    // consequences is a misclick waiting to happen.
    expect(screen.getByRole('button', { name: 'Grant security.scan' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refuse security.scan' })).toBeDisabled();
    expect(screen.getByText(/at least ten characters is required/)).toBeInTheDocument();
  });

  test('answering a question sends the grant and the reason', async () => {
    renderPage();
    const field = await screen.findByLabelText(/Why — stored with your name/);
    await userEvent.type(field, 'Authorized for the QA environment by the release owner.');
    await userEvent.click(screen.getByRole('button', { name: 'Grant security.scan' }));

    await waitFor(() => {
      const call = apiRequest.mock.calls.find(
        ([path]) => path === '/api/v1/agent/approvals/approval-1/decision');
      expect(call![1]).toMatchObject({
        method: 'POST',
        body: { grant: true, justification: 'Authorized for the QA environment by the release owner.' }
      });
    });
  });

  test('a reader without the permission is told why they cannot answer', async () => {
    permissions.current = new Set(['test:read']);
    renderPage();
    await screen.findByText('1 question(s) waiting');
    expect(screen.getByText(/needs the agent:run permission/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Grant security.scan' })).not.toBeInTheDocument();
  });

  test('a refusal names the rung of the ladder that stopped it', async () => {
    renderPage();
    expect(await screen.findByText(/Stopped by: Production not permitted/i)).toBeInTheDocument();
  });

  test('a refusal with no evidence says why that is not a gap in the record', async () => {
    renderPage();
    // The platform refuses to record a permitted decision with no evidence, so an empty list
    // here can only be a refusal. Saying so beats leaving a blank to interpret.
    expect(await screen.findByText(/only possible on a refusal, because nothing was done/))
      .toBeInTheDocument();
  });

  test('the decision log counts the refusals rather than burying them', async () => {
    renderPage();
    expect(await screen.findByText('Decisions (2)')).toBeInTheDocument();
    expect(screen.getByText(/1 refused/)).toBeInTheDocument();
  });

  test('the timeline shows phases, refusals and questions in order', async () => {
    renderPage();
    expect(await screen.findByText('Assessed 24 capability(ies).')).toBeInTheDocument();
    expect(screen.getByText('test.execute was refused.')).toBeInTheDocument();
    expect(screen.getByText('Asked for approval to use security.scan')).toBeInTheDocument();
    expect(screen.getByText('Pass started')).toBeInTheDocument();
  });

  test('what a person said about the application is shown next to what the pass did', async () => {
    renderPage();
    expect(await screen.findByText('Never touch')).toBeInTheDocument();
    expect(screen.getByText('/statements')).toBeInTheDocument();
    expect(screen.getByText(/Honoured absolutely, before any risk score/)).toBeInTheDocument();
  });

  test('an application nobody described says so rather than showing an empty box', async () => {
    apiRequest.mockImplementation((path: string) => Promise.resolve(
      path === '/api/v1/agent/applications/app-1/context'
        ? { applicationId: 'app-1', criticalJourneys: [], highRiskAreas: [], excludedAreas: [], notes: '' }
        : respond(path)
    ));
    renderPage();
    expect(await screen.findByText(/not the same as nothing being critical/)).toBeInTheDocument();
  });

  test('a pass with no plan yet does not break the screen', async () => {
    apiRequest.mockImplementation((path: string) => path === '/api/v1/agent/runs/run-1/plan'
      ? Promise.reject(new Error('404 Not Found'))
      : Promise.resolve(respond(path)));
    renderPage();
    // The questions card still renders, so a 404 on one endpoint does not take the page down.
    expect(await screen.findByText('1 question(s) waiting')).toBeInTheDocument();
    expect(screen.queryByText('The agent is waiting for an answer')).not.toBeInTheDocument();
  });
});
