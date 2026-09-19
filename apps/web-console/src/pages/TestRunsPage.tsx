import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../api/client';
import { useProject } from '../lib/project';
import { Card, EmptyState, ErrorNotice, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { formatDuration, formatRelative, formatPercent } from '../lib/format';

interface TestRunSummary {
  id: string; projectId: string; name: string; status: string; trigger: string; browser: string;
  createdAt: string; startedAt?: string; completedAt?: string; durationMs: number;
  totalCount: number; passedCount: number; failedCount: number; skippedCount: number;
  blockedCount: number; healedCount: number; flakyCount: number;
  qualityGatePassed?: boolean; ciBuildId?: string; ciBranch?: string;
}

export default function TestRunsPage() {
  const { projectId } = useProject();

  const { data: runs = [], isLoading, error, refetch } = useQuery({
    queryKey: ['testruns', projectId],
    queryFn: () => apiRequest<TestRunSummary[]>(
      `/api/v1/testruns?limit=30${projectId ? `&projectId=${projectId}` : ''}`),
    refetchInterval: query => {
      const rows = query.state.data as TestRunSummary[] | undefined;
      return rows?.some(r => r.status === 'queued' || r.status === 'running') ? 3000 : 20_000;
    }
  });

  if (isLoading) return <Spinner label="Loading test runs" />;
  if (error) return <ErrorNotice error={error} onRetry={() => void refetch()} />;

  return (
    <>
      <PageHeader
        title="Test runs"
        description="Every execution, its evidence and its quality gate."
        actions={<Link to="/tests" className="btn-secondary">Start a run from test cases</Link>}
      />

      {runs.length === 0 ? (
        <Card>
          <EmptyState
            title="No runs yet"
            description="Generate or write some tests, then run them. Each run captures screenshots, a trace, network and console output for every execution."
            action={<Link to="/tests" className="btn-primary">Go to test cases</Link>}
          />
        </Card>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Run</th><th>Status</th><th>Results</th><th>Pass rate</th>
                <th>Gate</th><th>Duration</th><th>Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.map(run => {
                const verdicts = run.passedCount + run.failedCount + run.healedCount;
                const passRate = verdicts === 0 ? null : (run.passedCount + run.healedCount) * 100 / verdicts;
                return (
                  <tr key={run.id}>
                    <td>
                      <Link to={`/runs/${run.id}`} className="font-medium text-brand hover:underline">
                        {run.name}
                      </Link>
                      <div className="text-xs text-ink-subtle mt-0.5">
                        {run.browser} · {run.trigger}
                        {run.ciBranch && ` · ${run.ciBranch}`}
                        {run.ciBuildId && ` · build ${run.ciBuildId}`}
                      </div>
                    </td>
                    <td><StatusBadge status={run.status} /></td>
                    <td className="text-xs tabular-nums whitespace-nowrap">
                      <span className="text-good">{run.passedCount} passed</span>
                      {run.failedCount > 0 && <span className="text-bad"> · {run.failedCount} failed</span>}
                      {run.healedCount > 0 && <span className="text-info"> · {run.healedCount} healed</span>}
                      {run.blockedCount > 0 && <span className="text-warn"> · {run.blockedCount} blocked</span>}
                    </td>
                    <td className="tabular-nums">{passRate === null ? '—' : formatPercent(passRate)}</td>
                    <td>
                      {run.qualityGatePassed === undefined || run.qualityGatePassed === null
                        ? <span className="text-xs text-ink-subtle">—</span>
                        : run.qualityGatePassed
                          ? <span className="badge bg-good-light text-good">passed</span>
                          : <span className="badge bg-bad-light text-bad">failed</span>}
                    </td>
                    <td className="tabular-nums text-xs">{formatDuration(run.durationMs)}</td>
                    <td className="text-xs text-ink-muted whitespace-nowrap">
                      {formatRelative(run.startedAt ?? run.createdAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
