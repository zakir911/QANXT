import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../api/client';
import { useProject } from '../lib/project';
import { Card, EmptyState, ErrorNotice, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { formatPercent, formatRelative } from '../lib/format';

interface DashboardView {
  summary: { failed: number; newFailures: number; failureRatePercent: number };
  topFailingTests: {
    testCaseId: string; reference: string; name: string; failureCount: number;
    executionCount: number; lastMessage?: string; category?: string; lastFailedAt?: string;
  }[];
  failureCategories: { category: string; count: number }[];
}

/**
 * Failures grouped by what they are, rather than a flat log.
 *
 * The category is what decides who should look at a failure, so it leads: an application
 * defect goes to the developers, a locator change goes to whoever maintains the test, and
 * an environment problem goes to whoever runs the environment.
 */
export default function FailuresPage() {
  const { projectId, project } = useProject();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard', projectId, 'failures'],
    queryFn: () => apiRequest<DashboardView>(
      `/api/v1/dashboard?windowDays=30${projectId ? `&projectId=${projectId}` : ''}`)
  });

  if (isLoading) return <Spinner label="Loading failures" />;
  if (error) return <ErrorNotice error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  return (
    <>
      <PageHeader
        title="Failures"
        description={`${project?.name ?? 'All projects'} · the last 30 days`}
      />

      {data.topFailingTests.length === 0 ? (
        <Card>
          <EmptyState
            title="Nothing is failing"
            description="No test has failed in the last 30 days. When one does, it appears here classified by what actually went wrong, with the evidence attached."
          />
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3 mb-4">
            <Card title="Failure rate">
              <p className="text-2xl font-bold text-bad tabular-nums">
                {formatPercent(data.summary.failureRatePercent)}
              </p>
            </Card>
            <Card title="Failed executions">
              <p className="text-2xl font-bold tabular-nums">{data.summary.failed}</p>
            </Card>
            <Card title="New failures">
              <p className="text-2xl font-bold text-warn tabular-nums">{data.summary.newFailures}</p>
              <p className="mt-1 text-xs text-ink-muted">
                These correlate with the most recent change and are worth looking at first.
              </p>
            </Card>
          </div>

          <Card title="By category" className="mb-4"
                description="What kind of problem each failure actually is, which decides who should look at it.">
            <ul className="flex flex-wrap gap-2">
              {data.failureCategories.map(entry => (
                <li key={entry.category} className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5">
                  <StatusBadge status={entry.category} />
                  <span className="text-sm font-semibold tabular-nums">{entry.count}</span>
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Most frequent failures">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Test</th><th>Category</th><th>Occurrences</th><th>Last seen</th><th>Message</th></tr>
                </thead>
                <tbody>
                  {data.topFailingTests.map(test => (
                    <tr key={test.testCaseId}>
                      <td>
                        <Link to={`/tests/${test.testCaseId}`} className="font-medium text-brand hover:underline">
                          {test.reference} {test.name}
                        </Link>
                      </td>
                      <td>{test.category ? <StatusBadge status={test.category} /> : '—'}</td>
                      <td className="tabular-nums">{test.failureCount}</td>
                      <td className="text-xs text-ink-muted whitespace-nowrap">{formatRelative(test.lastFailedAt)}</td>
                      <td className="text-xs text-ink-muted max-w-md"><span className="line-clamp-2">{test.lastMessage ?? '—'}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
