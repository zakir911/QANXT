import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../api/client';
import { useProject } from '../lib/project';
import { Card, EmptyState, ErrorNotice, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { formatDateTime, formatRelative } from '../lib/format';

interface DiscoveryRunSummary {
  id: string; applicationId: string; applicationName: string; status: string;
  createdAt: string; startedAt?: string; completedAt?: string;
  pagesDiscovered: number; elementsDiscovered: number; apiEndpointsDiscovered: number;
  consoleErrorCount: number; pagesBlockedByPolicy: number; errorMessage?: string; workerId?: string;
}

interface DiscoveryRunDetail {
  summary: DiscoveryRunSummary;
  progressLog?: string;
  maxDepth: number; maxPages: number; timeoutSeconds: number;
}

export default function DiscoveryPage() {
  const { projectId } = useProject();

  const { data: runs = [], isLoading, error, refetch } = useQuery({
    queryKey: ['discovery-runs', projectId],
    queryFn: () => apiRequest<DiscoveryRunSummary[]>('/api/v1/discovery/runs?limit=25'),
    // Discovery is long-running; polling keeps the page honest without a websocket.
    refetchInterval: query => {
      const rows = query.state.data as DiscoveryRunSummary[] | undefined;
      const active = rows?.some(r => r.status === 'queued' || r.status === 'running');
      return active ? 3000 : 20_000;
    }
  });

  if (isLoading) return <Spinner label="Loading discovery runs" />;
  if (error) return <ErrorNotice error={error} onRetry={() => void refetch()} />;

  return (
    <>
      <PageHeader
        title="Discovery"
        description="Bounded exploration of an application: what exists, what it contains, and what it calls."
        actions={<Link to="/applications" className="btn-secondary">Start a run from an application</Link>}
      />

      {runs.length === 0 ? (
        <Card>
          <EmptyState
            title="No discovery runs yet"
            description="Discovery explores your application within the depth, page and time budgets you set, and builds the model that test generation works from."
            action={<Link to="/applications" className="btn-primary">Go to applications</Link>}
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {runs.map(run => <DiscoveryRunCard key={run.id} run={run} />)}
        </div>
      )}
    </>
  );
}

function DiscoveryRunCard({ run }: { run: DiscoveryRunSummary }) {
  const isActive = run.status === 'queued' || run.status === 'running';

  const { data: detail } = useQuery({
    queryKey: ['discovery-run', run.id],
    queryFn: () => apiRequest<DiscoveryRunDetail>(`/api/v1/discovery/runs/${run.id}`),
    refetchInterval: isActive ? 3000 : false
  });

  const log = detail?.progressLog?.trim();

  return (
    <Card
      title={run.applicationName}
      description={`Started ${formatRelative(run.startedAt ?? run.createdAt)}${run.workerId ? ` on ${run.workerId}` : ''}`}
      actions={
        <div className="flex items-center gap-2">
          <StatusBadge status={run.status} />
          {run.pagesDiscovered > 0 && (
            <Link to={`/applications/${run.applicationId}/graph`} className="btn-secondary btn-sm">
              View map
            </Link>
          )}
        </div>
      }
    >
      <dl className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-3">
        <div className="kv"><dt>Pages</dt><dd className="font-semibold">{run.pagesDiscovered}</dd></div>
        <div className="kv"><dt>Elements</dt><dd className="font-semibold">{run.elementsDiscovered}</dd></div>
        <div className="kv"><dt>API calls</dt><dd className="font-semibold">{run.apiEndpointsDiscovered}</dd></div>
        <div className="kv"><dt>Console errors</dt>
          <dd className={`font-semibold ${run.consoleErrorCount > 0 ? 'text-bad' : ''}`}>{run.consoleErrorCount}</dd></div>
        <div className="kv"><dt>Blocked by policy</dt>
          <dd className="font-semibold" title="URLs the crawler refused to open because they fell outside the allowlist or an excluded path">
            {run.pagesBlockedByPolicy}
          </dd></div>
      </dl>

      {run.errorMessage && (
        <div className="rounded-lg border border-bad/25 bg-bad-light px-3 py-2 text-sm text-bad mb-3">
          {run.errorMessage}
        </div>
      )}

      {log && (
        <details className="group">
          <summary className="cursor-pointer text-sm font-medium text-brand">
            Exploration log ({log.split('\n').length} lines)
          </summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-surface-sunken p-3 text-xs font-mono
                          text-ink-muted whitespace-pre-wrap">{log}</pre>
        </details>
      )}

      {detail && (
        <p className="mt-3 text-xs text-ink-subtle">
          Budget: depth {detail.maxDepth}, {detail.maxPages} pages, {detail.timeoutSeconds}s
          {run.completedAt && ` · finished ${formatDateTime(run.completedAt)}`}
        </p>
      )}
    </Card>
  );
}
