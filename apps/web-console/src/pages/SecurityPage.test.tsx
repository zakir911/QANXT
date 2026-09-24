import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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

const SecurityPage = (await import('./SecurityPage')).default;

const APPLICATIONS = [{ id: 'app-1', name: 'Access control lab' }];

const SCOPE = {
  id: 'scope-1', applicationId: 'app-1', enabled: true,
  authorizationNote: 'Authorized by Ada for the QA environment, reviewed 2026-09-01.',
  authorizedByUserId: 'user-1', authorizedAt: '2026-09-20T09:00:00Z',
  allowedDomains: '127.0.0.1', allowActiveTesting: true,
  allowDestructiveTesting: false, allowProduction: false
};

const FINDING = {
  id: 'finding-1', reference: 'SF-1', category: 'BOLA',
  title: 'alice can read a resource owned by bob',
  severity: 'high', confidence: 'high', status: 'confirmed',
  cwe: 'CWE-639', owaspWebCategory: 'A01:2021',
  endpoint: '/api/accounts/{id}', parameter: 'id', observedAsRole: 'alice',
  firstSeenAt: '2026-09-20T09:00:00Z', lastSeenAt: '2026-09-23T09:00:00Z',
  isNew: false, isRegression: false, dispositionNote: null
};

const trend = (overrides: Record<string, unknown> = {}) => ({
  applicationId: 'app-1',
  points: [
    { scanId: 's1', reference: 'SCAN-1', at: '2026-09-21T09:00:00Z', profile: 'standard',
      critical: 0, high: 2, medium: 1, low: 0, informational: 0, newFindings: 3, regressions: 0,
      checksConfigured: 5, checksExecuted: 5, requestsIssued: 120, requestsBlocked: 0,
      comparableToPrevious: true, notComparableBecause: null },
    { scanId: 's2', reference: 'SCAN-2', at: '2026-09-23T09:00:00Z', profile: 'standard',
      critical: 0, high: 1, medium: 0, low: 0, informational: 0, newFindings: 0, regressions: 0,
      checksConfigured: 5, checksExecuted: 1, requestsIssued: 12, requestsBlocked: 0,
      comparableToPrevious: false,
      notComparableBecause: "This scan executed 1 check(s) against the previous scan's 5. A drop in "
        + 'findings cannot be read as an improvement.' }
  ],
  openNow: 1, openCritical: 0, openHigh: 1,
  medianDaysToResolution: null, resolvedCount: 0,
  summary: '1 open finding(s) across 2 scan(s). This describes what those scans reached; areas they '
    + 'did not reach are untested, not clean. 1 of 2 scan(s) are not comparable to the one before them.',
  ...overrides
});

const SCAN = {
  id: 's2', reference: 'SCAN-2', profile: 'standard', status: 'completed',
  requestsIssued: 12, requestsBlocked: 0, testsExecuted: 1, testsSkipped: 4,
  startedAt: '2026-09-23T09:00:00Z', findings: [FINDING],
  gate: {
    outcome: 'review', blocked: false,
    summary: 'NEEDS REVIEW. 1 open finding(s) (1 high) from 1 of 5 configured check(s).',
    rules: [
      { name: 'A security scan ran', passed: true, measured: true, explanation: '12 request(s) issued.' },
      { name: 'Enough of the configured checks executed', passed: false, measured: true,
        explanation: '1 of 5 configured check(s) executed (20%; the policy requires 80%).' }
    ],
    reasons: ['Only 1 of 5 configured check(s) executed.']
  }
};

function route(path: string, overrides: Record<string, unknown> = {}) {
  if (path.startsWith('/api/v1/applications')) return APPLICATIONS;
  if (path.includes('/scope')) {
    if (overrides.noScope) throw new Error('404');
    return SCOPE;
  }
  if (path.includes('/trend')) return overrides.trend ?? trend();
  if (path.includes('/scans')) return overrides.scans ?? [SCAN];
  if (path.includes('/findings')) return overrides.findings ?? [FINDING];
  throw new Error(`unexpected call to ${path}`);
}

function renderPage(overrides: Record<string, unknown> = {}) {
  apiRequest.mockImplementation((path: string) => {
    try { return Promise.resolve(route(path, overrides)); }
    catch (error) { return Promise.reject(error); }
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><SecurityPage /></QueryClientProvider>);
}

beforeEach(() => {
  apiRequest.mockReset();
  permissions.current = new Set(['security:read', 'security:triage']);
});

describe('SecurityPage', () => {
  test('a reader without security:read is told why, not shown an empty page', async () => {
    permissions.current = new Set(['project:read']);
    renderPage();

    expect(await screen.findByText(/do not have access to security findings/i)).toBeInTheDocument();
    // The reason matters as much as the refusal: somebody has to know which permission to ask for.
    expect(screen.getByText(/security:read/)).toBeInTheDocument();
  });

  test('an application with no scope is described as unauthorized, not unconfigured', async () => {
    renderPage({ noScope: true });

    expect(await screen.findByText(/has not been authorized for security testing/i)).toBeInTheDocument();
    expect(screen.getByText(/until somebody writes one, nothing here can be scanned/i)).toBeInTheDocument();
  });

  test('an application with no scans says nothing has been tested, never that it is clean', async () => {
    renderPage({
      trend: trend({ points: [], openNow: 0, openCritical: 0, openHigh: 0,
        summary: 'No security scan has been recorded for this application. That is not a clean '
          + 'result: nothing has been tested.' }),
      scans: [], findings: []
    });

    // Both empty states carry the phrase, which is the point: the trend and the findings list
    // each have to say it rather than one of them relying on the other being read.
    expect(await screen.findByRole('heading', { name: /Nothing has been scanned/i })).toBeInTheDocument();
    expect(screen.getByText(/This is not a clean result/i)).toBeInTheDocument();
    expect(screen.getByText(/says nothing about the application/i)).toBeInTheDocument();
  });

  test('an empty findings list after a real scan is qualified rather than reported as secure', async () => {
    renderPage({ findings: [] });

    expect(await screen.findByText(/not a statement that the application is secure/i)).toBeInTheDocument();
    expect(screen.getByText(/untested rather than clean/i)).toBeInTheDocument();
  });

  test('a scan that is not comparable to the one before it is labelled, not smoothed over', async () => {
    renderPage();

    const chart = await screen.findByTestId('security-trend');
    expect(chart).toBeInTheDocument();
    // Two points, one flagged. A falling bar that nobody marks is the failure mode.
    expect(screen.getByText('not comparable')).toBeInTheDocument();
    expect(screen.getByText(/1\/5 checks/)).toBeInTheDocument();
  });

  test('the gate shows every rule, including the one that failed', async () => {
    renderPage();

    expect(await screen.findByTestId('security-gate-summary')).toHaveTextContent(/NEEDS REVIEW/);
    expect(screen.getByText('Enough of the configured checks executed')).toBeInTheDocument();
    expect(screen.getByText(/the policy requires 80%/)).toBeInTheDocument();
  });

  test('triage will not submit a suppression until the justification says something', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /triage/i }));

    const form = await screen.findByTestId('security-triage');
    expect(form).toBeInTheDocument();

    const save = screen.getByRole('button', { name: /save/i });
    expect(save).toBeDisabled();
    expect(screen.getByText(/indistinguishable from turning the check off/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/justification/i), 'too short');
    expect(save).toBeDisabled();

    await user.clear(screen.getByLabelText(/justification/i));
    await user.type(
      screen.getByLabelText(/justification/i),
      'Reviewed against the source: the handler filters by the caller id.');
    await waitFor(() => expect(save).toBeEnabled());
  });

  test('a reader without security:triage is not offered the button at all', async () => {
    permissions.current = new Set(['security:read']);
    renderPage();

    await screen.findByTestId('security-findings');
    expect(screen.queryByRole('button', { name: /triage/i })).not.toBeInTheDocument();
  });
});
