import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiRequest = vi.fn();
vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return { ...actual, apiRequest: (path: string) => apiRequest(path) };
});

const VerificationPage = (await import('./VerificationPage')).default;

const METRICS = {
  discovery: { pageRecall: 1, pagePrecision: 1, apiRecall: 0.83, stableLocatorShare: 1, pagesDiscovered: 11, elementsDiscovered: 259, discoveryMs: 15000 },
  generation: { coverageOfDiscoveredPages: 0.89, stableLocatorShare: 1, generatedTestsExecuted: 5, generatedTestsPassed: 5, generatedTestsFailedUnderFault: 1 },
  healing: { opportunities: 12, correctHeals: 2, correctRejections: 10, incorrectHeals: 0, missedHeals: 0, healingSuccessRate: 1, falseHealingRate: 0, confidenceMargin: 16, lowestHealable: 93, highestWrongTarget: 77 },
  failureAnalysis: { classificationAccuracy: 1, classesCorrect: 10, classesTotal: 10, classifiedUnknown: 0 },
  reliability: { repeatabilityRuns: 10, repeatabilityDistinctVerdicts: 1, flakyPassed: 10, flakyFailed: 10, flakyRuns: 20, concurrentRuns: 10, concurrentReachedVerdict: 10 },
  integrity: { falsePassChecks: 9, falsePasses: 0, falseNegativeChecks: 6, falseNegatives: 0 }
};

function report(overrides: Record<string, unknown> = {}) {
  return {
    runId: '2026-09-21T07-57-51Z',
    generatedAt: '2026-09-21T08:40:00.000Z',
    build: { commit: 'abc1234', dirty: false },
    totals: { total: 100, passed: 97, failed: 0, notVerified: 3, criticalFailures: 0 },
    bySeverity: [], bySuite: [{ suite: 'Discovery', total: 15, passed: 15, failed: 0, notVerified: 0 }],
    metrics: METRICS,
    gates: [{ name: 'Discovery', passed: true, total: 15, executed: 15, failures: [], notVerified: [] }],
    overall: true,
    evidence: { artifacts: 240, bytes: 10_000, missing: 0, changed: 0 },
    tests: [{ id: 'DISC-001', suite: 'Discovery', objective: 'Discovery completes', severity: 'critical', result: 'PASS', detail: 'completed', durationMs: 1500, evidence: ['evidence/DISC-001/x.json'] }],
    ...overrides
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}><VerificationPage /></QueryClientProvider>
  );
}

// Braced, not a concise body: a beforeEach that *returns* the mock hands vitest the mock
// itself as the teardown function, which then calls it with no arguments after the test.
beforeEach(() => { apiRequest.mockReset(); });

describe('VerificationPage', () => {
  test('an absent report is reported as absent, never as a pass', async () => {
    apiRequest.mockImplementation((path: string) => {
      if (path.endsWith('/status')) {
        return Promise.resolve({ directory: '/repo/verification/reports', reportAvailable: false, certificationAvailable: false, command: './scripts/run-golden-tests --all' });
      }
      throw new Error(`unexpected call to ${path}`);
    });

    renderPage();

    expect(await screen.findByText(/No golden run has been recorded/i)).toBeInTheDocument();
    expect(screen.queryByText(/All quality gates passed/i)).not.toBeInTheDocument();
    expect(screen.getByText('./scripts/run-golden-tests --all')).toBeInTheDocument();
  });

  test('a clean run shows green and counts not-verified separately from passes', async () => {
    apiRequest.mockImplementation((path: string) => {
      if (path.endsWith('/status')) return Promise.resolve({ directory: '/repo', reportAvailable: true, certificationAvailable: false, command: 'x' });
      if (path.endsWith('/report')) return Promise.resolve(report());
      throw new Error(`unexpected call to ${path}`);
    });

    renderPage();

    expect(await screen.findByText(/All quality gates passed/i)).toBeInTheDocument();
    expect(screen.getByText(/3 could not be executed in this environment and are recorded as not verified, not as passes/i))
      .toBeInTheDocument();
  });

  test('a failing gate turns the page red even when the report claims it passed overall', async () => {
    // The file could be wrong — hand-edited, or written by an older reporter. The console
    // re-checks the gates rather than trusting the flag, because a green banner over a red
    // gate is the exact failure this page exists to prevent.
    apiRequest.mockImplementation((path: string) => {
      if (path.endsWith('/status')) return Promise.resolve({ directory: '/repo', reportAvailable: true, certificationAvailable: false, command: 'x' });
      if (path.endsWith('/report')) {
        return Promise.resolve(report({
          overall: true,
          totals: { total: 100, passed: 96, failed: 1, notVerified: 3, criticalFailures: 1 },
          gates: [{ name: 'Self-healing', passed: false, total: 20, executed: 20, failures: ['HEAL-N03'], notVerified: [] }]
        }));
      }
      throw new Error(`unexpected call to ${path}`);
    });

    renderPage();

    expect(await screen.findByText(/Quality gates did not pass/i)).toBeInTheDocument();
    expect(screen.queryByText(/All quality gates passed/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Failing gate\(s\): Self-healing/i)).toBeInTheDocument();
  });

  test('a non-zero false-healing rate is shown as a problem, not folded into a success rate', async () => {
    apiRequest.mockImplementation((path: string) => {
      if (path.endsWith('/status')) return Promise.resolve({ directory: '/repo', reportAvailable: true, certificationAvailable: false, command: 'x' });
      if (path.endsWith('/report')) {
        return Promise.resolve(report({
          metrics: { ...METRICS, healing: { ...METRICS.healing, incorrectHeals: 2, falseHealingRate: 0.1 } }
        }));
      }
      throw new Error(`unexpected call to ${path}`);
    });

    const { container } = renderPage();

    await waitFor(() => expect(screen.getAllByText('10.0%').length).toBeGreaterThan(0));
    const headline = [...container.querySelectorAll('.text-2xl')]
      .find(node => node.textContent === '10.0%');
    expect(headline?.className).toContain('text-bad');
    expect(screen.getByText(/2 incorrect heal\(s\) — target 0/i)).toBeInTheDocument();
  });
});
