import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer,
  Tooltip, XAxis, YAxis
} from 'recharts';
import { apiRequest } from '../api/client';
import { useProject } from '../lib/project';
import { Card, EmptyState, ErrorNotice, Metric, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { formatDuration, formatPercent, humanize } from '../lib/format';

interface DashboardView {
  summary: {
    totalTests: number; enabledTests: number; executionsInWindow: number;
    passed: number; failed: number; skipped: number; blocked: number; healed: number; flaky: number;
    passRatePercent: number; failureRatePercent: number; averageDurationMs: number;
    newFailures: number; openDefects: number; pendingHealingProposals: number;
    regressionRiskScore: number; regressionRiskRationale: string;
  };
  trend: { date: string; passed: number; failed: number; healed: number; flaky: number; passRatePercent: number }[];
  topFailingTests: {
    testCaseId: string; reference: string; name: string; failureCount: number;
    executionCount: number; lastMessage?: string; category?: string; lastFailedAt?: string;
  }[];
  topUnstableTests: {
    testCaseId: string; reference: string; name: string; flakinessScore: number;
    executionCount: number; passCount: number; failCount: number;
  }[];
  failureCategories: { category: string; count: number }[];
  healing: {
    total: number; applied: number; proposed: number; approved: number;
    rejected: number; averageConfidence: number; verifiedCount: number;
  };
  slowestTests: { testCaseId: string; reference: string; name: string; averageDurationMs: number }[];
}

const CATEGORY_COLOURS: Record<string, string> = {
  applicationDefect: '#c02626',
  testDefect: '#b26b00',
  locatorChange: '#5a4bd6',
  timingIssue: '#0b5fff',
  environmentDefect: '#8798ac',
  networkIssue: '#12855a',
  authenticationIssue: '#7a3fb0',
  dataIssue: '#c06a00',
  thirdPartyDependency: '#5b6b82',
  unknown: '#cbd5e3'
};

export default function DashboardPage() {
  const { projectId, project } = useProject();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard', projectId],
    queryFn: () => apiRequest<DashboardView>(
      `/api/v1/dashboard?windowDays=30${projectId ? `&projectId=${projectId}` : ''}`),
    refetchInterval: 30_000
  });

  if (isLoading) return <Spinner label="Loading quality metrics" />;
  if (error) return <ErrorNotice error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  const { summary } = data;
  const riskTone = summary.regressionRiskScore >= 60 ? 'bad'
    : summary.regressionRiskScore >= 30 ? 'warn' : 'good';

  return (
    <>
      <PageHeader
        title="Quality dashboard"
        description={`${project ? project.name : 'All projects'} · the last 30 days`}
      />

      {summary.executionsInWindow === 0 ? (
        <Card>
          <EmptyState
            title="No executions in this window"
            description="Nothing has run in the last 30 days, so there are no metrics to show. Every number here is computed from stored executions — none of it is estimated."
            action={<Link to="/runs" className="btn-primary">Go to test runs</Link>}
          />
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-4">
            <Metric label="Pass rate" value={formatPercent(summary.passRatePercent)}
                    tone={summary.passRatePercent >= 95 ? 'good' : summary.passRatePercent >= 80 ? 'warn' : 'bad'}
                    hint={`${summary.passed + summary.healed} of ${summary.passed + summary.failed + summary.healed} verdicts`} />
            <Metric label="Failed" value={summary.failed} tone={summary.failed > 0 ? 'bad' : 'neutral'}
                    hint={summary.newFailures > 0 ? `${summary.newFailures} new` : 'none new'} />
            <Metric label="Healed" value={summary.healed} tone={summary.healed > 0 ? 'info' : 'neutral'}
                    hint={`${summary.pendingHealingProposals} proposal(s) awaiting review`} />
            <Metric label="Regression risk" value={`${summary.regressionRiskScore}/100`} tone={riskTone}
                    hint={summary.regressionRiskRationale} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
            <Metric label="Total tests" value={summary.totalTests} hint={`${summary.enabledTests} enabled`} />
            <Metric label="Executions" value={summary.executionsInWindow}
                    hint={`avg ${formatDuration(summary.averageDurationMs)}`} />
            <Metric label="Blocked" value={summary.blocked} tone={summary.blocked > 0 ? 'warn' : 'neutral'}
                    hint="preconditions not met" />
            <Metric label="Open defects" value={summary.openDefects}
                    tone={summary.openDefects > 0 ? 'warn' : 'neutral'} />
          </div>

          <div className="grid gap-4 lg:grid-cols-3 mb-4">
            <Card title="Execution trend" description="Verdicts per day" className="lg:col-span-2">
              {data.trend.length === 0 ? (
                <p className="text-sm text-ink-muted py-8 text-center">Not enough history yet.</p>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <AreaChart data={data.trend} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f2" vertical={false} />
                    <XAxis dataKey="date" stroke="#8798ac" fontSize={12} tickLine={false} axisLine={false} />
                    <YAxis stroke="#8798ac" fontSize={12} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f2', fontSize: 13 }} />
                    <Area type="monotone" dataKey="passed" stackId="1" stroke="#12855a" fill="#12855a" fillOpacity={0.25} name="Passed" />
                    <Area type="monotone" dataKey="healed" stackId="1" stroke="#5a4bd6" fill="#5a4bd6" fillOpacity={0.25} name="Healed" />
                    <Area type="monotone" dataKey="failed" stackId="1" stroke="#c02626" fill="#c02626" fillOpacity={0.25} name="Failed" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </Card>

            <Card title="Failure categories" description="What is actually going wrong">
              {data.failureCategories.length === 0 ? (
                <p className="text-sm text-ink-muted py-8 text-center">No failures in this window.</p>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={data.failureCategories} layout="vertical" margin={{ left: 40, right: 12 }}>
                    <XAxis type="number" hide allowDecimals={false} />
                    <YAxis type="category" dataKey="category" width={120} stroke="#5b6b82" fontSize={11}
                           tickLine={false} axisLine={false} tickFormatter={humanize} />
                    <Tooltip contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f2', fontSize: 13 }}
                             formatter={(value: number) => [value, 'failures']}
                             labelFormatter={humanize} />
                    <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                      {data.failureCategories.map(entry => (
                        <Cell key={entry.category} fill={CATEGORY_COLOURS[entry.category] ?? '#cbd5e3'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Most frequent failures" description="Where to look first">
              {data.topFailingTests.length === 0 ? (
                <p className="text-sm text-ink-muted py-6 text-center">Nothing is failing.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {data.topFailingTests.map(test => (
                    <li key={test.testCaseId} className="py-2.5 first:pt-0 last:pb-0">
                      <div className="flex items-start justify-between gap-3">
                        <Link to={`/tests/${test.testCaseId}`} className="text-sm font-medium text-brand hover:underline">
                          {test.reference} {test.name}
                        </Link>
                        <span className="text-xs font-semibold text-bad tabular-nums shrink-0">
                          {test.failureCount}×
                        </span>
                      </div>
                      {test.category && <div className="mt-1"><StatusBadge status={test.category} /></div>}
                      {test.lastMessage && (
                        <p className="mt-1 text-xs text-ink-muted line-clamp-2">{test.lastMessage}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Least stable tests"
                  description="Tests whose verdict keeps changing — these erode trust in the suite">
              {data.topUnstableTests.length === 0 ? (
                <p className="text-sm text-ink-muted py-6 text-center">
                  Every test that ran more than once produced a consistent result.
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {data.topUnstableTests.map(test => (
                    <li key={test.testCaseId} className="py-2.5 first:pt-0 last:pb-0 flex items-center justify-between gap-3">
                      <Link to={`/tests/${test.testCaseId}`} className="text-sm font-medium text-brand hover:underline">
                        {test.reference} {test.name}
                      </Link>
                      <span className="text-xs text-ink-muted tabular-nums shrink-0">
                        {test.flakinessScore}/100 over {test.executionCount} runs
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Self-healing" description="Locator repairs and their review state">
              <dl className="grid grid-cols-3 gap-4">
                <div className="kv"><dt>Total</dt><dd className="text-lg font-semibold">{data.healing.total}</dd></div>
                <div className="kv"><dt>Applied in run</dt><dd className="text-lg font-semibold text-info">{data.healing.applied}</dd></div>
                <div className="kv"><dt>Awaiting review</dt><dd className="text-lg font-semibold text-warn">{data.healing.proposed}</dd></div>
                <div className="kv"><dt>Approved</dt><dd className="text-lg font-semibold text-good">{data.healing.approved}</dd></div>
                <div className="kv"><dt>Rejected</dt><dd className="text-lg font-semibold">{data.healing.rejected}</dd></div>
                <div className="kv"><dt>Avg confidence</dt><dd className="text-lg font-semibold">{data.healing.averageConfidence}%</dd></div>
              </dl>
              {data.healing.total > 0 && (
                <p className="mt-3 text-xs text-ink-muted">
                  {data.healing.verifiedCount} of {data.healing.total} were verified by re-running the action they replaced.
                </p>
              )}
              {data.healing.proposed > 0 && (
                <Link to="/healing" className="btn-secondary btn-sm mt-3">Review proposals</Link>
              )}
            </Card>

            <Card title="Slowest tests" description="Average duration">
              {data.slowestTests.length === 0 ? (
                <p className="text-sm text-ink-muted py-6 text-center">No timing data yet.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {data.slowestTests.map(test => (
                    <li key={test.testCaseId} className="py-2.5 first:pt-0 last:pb-0 flex items-center justify-between gap-3">
                      <Link to={`/tests/${test.testCaseId}`} className="text-sm font-medium text-brand hover:underline">
                        {test.reference} {test.name}
                      </Link>
                      <span className="text-xs text-ink-muted tabular-nums shrink-0">
                        {formatDuration(test.averageDurationMs)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </>
  );
}
