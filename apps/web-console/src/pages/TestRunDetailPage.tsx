import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { apiRequest } from '../api/client';
import { useExecutionStream, type ExecutionEvent } from '../lib/live';
import { Card, ErrorNotice, Metric, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { formatDuration, formatPercent, formatRelative, humanize } from '../lib/format';

interface TestRunSummary {
  id: string; name: string; status: string; browser: string; trigger: string;
  startedAt?: string; completedAt?: string; durationMs: number;
  totalCount: number; passedCount: number; failedCount: number; skippedCount: number;
  blockedCount: number; healedCount: number; flakyCount: number; qualityGatePassed?: boolean;
}

interface ExecutionRow {
  id: string; testCaseId: string; reference: string; name: string; status: string;
  startedAt?: string; completedAt?: string; durationMs: number; attempt: number;
  stepsTotal: number; stepsPassed: number; stepsFailed: number; stepsHealed: number;
  consoleErrorCount: number; networkErrorCount: number; errorMessage?: string;
  workerId?: string; browser: string; priority: string;
}

interface QualityGateResult {
  passed: boolean;
  summary: string;
  rules: {
    ruleId: string; name: string; metric: string; operator: string;
    threshold: number; actualValue: number; passed: boolean; isBlocking: boolean; explanation: string;
  }[];
}

/**
 * A run in progress, and the record of one that has finished.
 *
 * While a run is live this screen shows the step the browser is on right now, which is the
 * difference between watching a test and waiting for one.
 */
export default function TestRunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const queryClient = useQueryClient();
  const [liveStep, setLiveStep] = useState<Record<string, string>>({});

  const { data: run, isLoading, error, refetch } = useQuery({
    queryKey: ['testrun', runId],
    queryFn: () => apiRequest<TestRunSummary>(`/api/v1/testruns/${runId}`),
    enabled: Boolean(runId),
    refetchInterval: query => {
      const value = query.state.data as TestRunSummary | undefined;
      return value && (value.status === 'queued' || value.status === 'running') ? 2500 : false;
    }
  });

  const isActive = run?.status === 'queued' || run?.status === 'running';

  const { data: executions = [] } = useQuery({
    queryKey: ['run-executions', runId],
    queryFn: () => apiRequest<ExecutionRow[]>(`/api/v1/testruns/${runId}/executions`),
    enabled: Boolean(runId),
    refetchInterval: isActive ? 2500 : false
  });

  const { data: gate } = useQuery({
    queryKey: ['run-gate', runId],
    queryFn: () => apiRequest<QualityGateResult>(`/api/v1/testruns/${runId}/quality-gate`),
    enabled: Boolean(runId) && !isActive
  });

  const { connected } = useExecutionStream({
    runId,
    enabled: Boolean(isActive),
    onEvent: (event: ExecutionEvent) => {
      if (event.type === 'action.completed' && event.executionId) {
        const description = String(event.payload.description ?? '');
        setLiveStep(previous => ({ ...previous, [event.executionId!]: description }));
      }
      if (event.type === 'execution.completed' || event.type === 'run.completed') {
        void queryClient.invalidateQueries({ queryKey: ['run-executions', runId] });
        void queryClient.invalidateQueries({ queryKey: ['testrun', runId] });
      }
    }
  });

  useEffect(() => {
    if (!isActive) setLiveStep({});
  }, [isActive]);

  if (isLoading) return <Spinner label="Loading run" />;
  if (error) return <ErrorNotice error={error} onRetry={() => void refetch()} />;
  if (!run) return null;

  const verdicts = run.passedCount + run.failedCount + run.healedCount;
  const passRate = verdicts === 0 ? null : (run.passedCount + run.healedCount) * 100 / verdicts;
  const finished = executions.filter(e => !['queued', 'pending', 'running'].includes(e.status)).length;

  return (
    <>
      <PageHeader
        title={run.name}
        description={`${run.browser} · ${humanize(run.trigger)} · started ${formatRelative(run.startedAt)}`}
        actions={
          <div className="flex items-center gap-2">
            {isActive && (
              <span className={`badge ${connected ? 'bg-good-light text-good' : 'bg-warn-light text-warn'}`}>
                {connected ? 'live' : 'polling'}
              </span>
            )}
            <StatusBadge status={run.status} />
            <Link to="/runs" className="btn-secondary">Back</Link>
          </div>
        }
      />

      {isActive && (
        <div className="mb-4">
          <div className="flex items-center justify-between text-sm mb-1.5">
            <span className="font-medium text-ink">Progress</span>
            <span className="tabular-nums text-ink-muted">{finished} of {run.totalCount} complete</span>
          </div>
          <div className="h-2 rounded-full bg-line overflow-hidden">
            <div className="h-full bg-brand transition-all duration-500"
                 style={{ width: `${run.totalCount === 0 ? 0 : (finished / run.totalCount) * 100}%` }} />
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5 mb-4">
        <Metric label="Total" value={run.totalCount} />
        <Metric label="Passed" value={run.passedCount} tone={run.passedCount > 0 ? 'good' : 'neutral'} />
        <Metric label="Failed" value={run.failedCount} tone={run.failedCount > 0 ? 'bad' : 'neutral'} />
        <Metric label="Healed" value={run.healedCount} tone={run.healedCount > 0 ? 'info' : 'neutral'} />
        <Metric label="Pass rate" value={passRate === null ? '—' : formatPercent(passRate)}
                tone={passRate === null ? 'neutral' : passRate >= 95 ? 'good' : passRate >= 80 ? 'warn' : 'bad'}
                hint={formatDuration(run.durationMs)} />
      </div>

      {gate && (
        <Card
          title="Quality gate"
          description={gate.summary}
          className="mb-4"
          actions={gate.passed
            ? <span className="badge bg-good-light text-good">passed</span>
            : <span className="badge bg-bad-light text-bad">failed</span>}
        >
          {gate.rules.length === 0 ? (
            <p className="text-sm text-ink-muted">
              No quality gates are configured for this project, so a run can never block a pipeline.
            </p>
          ) : (
            <ul className="space-y-2">
              {gate.rules.map(rule => (
                <li key={rule.ruleId} className="flex items-start gap-2.5">
                  <span className={`mt-0.5 ${rule.passed ? 'text-good' : rule.isBlocking ? 'text-bad' : 'text-warn'}`}
                        aria-hidden="true">
                    {rule.passed ? '✓' : '✕'}
                  </span>
                  <div>
                    <div className="text-sm font-medium text-ink">
                      {rule.name}
                      {!rule.isBlocking && <span className="ml-1.5 badge bg-surface-sunken text-ink-muted">warning only</span>}
                    </div>
                    <p className="text-xs text-ink-muted">{rule.explanation}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Test</th><th>Status</th><th>Steps</th><th>Duration</th>
              <th>Evidence signals</th><th>Message</th>
            </tr>
          </thead>
          <tbody>
            {executions.map(execution => (
              <tr key={execution.id}>
                <td>
                  <Link to={`/executions/${execution.id}`} className="font-medium text-brand hover:underline">
                    {execution.reference} {execution.name}
                  </Link>
                  <div className="text-xs text-ink-subtle mt-0.5">
                    {execution.workerId ?? '—'}
                    {execution.attempt > 1 && ` · attempt ${execution.attempt}`}
                  </div>
                  {execution.status === 'running' && liveStep[execution.id] && (
                    <div className="mt-1 text-xs text-brand">→ {liveStep[execution.id]}</div>
                  )}
                </td>
                <td><StatusBadge status={execution.status} /></td>
                <td className="text-xs tabular-nums whitespace-nowrap">
                  {execution.stepsPassed}/{execution.stepsTotal}
                  {execution.stepsHealed > 0 && <span className="text-info"> · {execution.stepsHealed} healed</span>}
                </td>
                <td className="tabular-nums text-xs">{formatDuration(execution.durationMs)}</td>
                <td className="text-xs whitespace-nowrap">
                  {execution.consoleErrorCount > 0 && (
                    <span className="text-bad">{execution.consoleErrorCount} console</span>
                  )}
                  {execution.consoleErrorCount > 0 && execution.networkErrorCount > 0 && ' · '}
                  {execution.networkErrorCount > 0 && (
                    <span className="text-bad">{execution.networkErrorCount} network</span>
                  )}
                  {execution.consoleErrorCount === 0 && execution.networkErrorCount === 0 && (
                    <span className="text-ink-subtle">clean</span>
                  )}
                </td>
                <td className="text-xs text-ink-muted max-w-sm">
                  <span className="line-clamp-2">{execution.errorMessage ?? '—'}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
