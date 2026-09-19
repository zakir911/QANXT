import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiRequest } from '../api/client';
import { Permissions, useAuth } from '../lib/auth';
import { Card, ErrorNotice, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { formatDuration, formatRelative, humanize } from '../lib/format';

interface TestCaseDetail {
  id: string; reference: string; name: string; objective: string; preconditions: string;
  expectedResults: string; priority: string; risk: string; tags: string; source: string;
  isEnabled: boolean; version: number; requirementReference?: string;
  generatedByAiRequestId?: string; testSuiteId: string; applicationId?: string;
  statistics: {
    executionCount: number; passCount: number; failCount: number; healCount: number;
    flakinessScore: number; averageDurationMs: number; lastExecutedAt?: string; lastStatus?: string;
  };
  testData?: { key: string; kind: string; isSensitive: boolean; value?: string }[];
  steps: {
    id: string; order: number; description: string; action: string;
    targetDescription?: string; value?: string; url?: string;
    isCritical: boolean; continueOnFailure: boolean; healCount: number;
    assertions: {
      id: string; type: string; expectedValue?: string; attributeName?: string;
      negate: boolean; isSoft: boolean; description: string;
    }[];
  }[];
}

export default function TestCaseDetailPage() {
  const { testCaseId } = useParams<{ testCaseId: string }>();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [runError, setRunError] = useState<unknown>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['testcase', testCaseId],
    queryFn: () => apiRequest<TestCaseDetail>(`/api/v1/testcases/${testCaseId}`),
    enabled: Boolean(testCaseId)
  });

  const run = useMutation({
    mutationFn: () => apiRequest<{ id: string }>('/api/v1/testruns', {
      method: 'POST',
      body: { projectId: undefined, testCaseIds: [testCaseId], name: `Single test: ${data?.reference}` }
    }),
    onError: setRunError
  });

  const toggle = useMutation({
    mutationFn: (isEnabled: boolean) =>
      apiRequest(`/api/v1/testcases/${testCaseId}`, { method: 'PATCH', body: { isEnabled } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['testcase', testCaseId] })
  });

  if (isLoading) return <Spinner label="Loading test case" />;
  if (error) return <ErrorNotice error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  return (
    <>
      <PageHeader
        title={`${data.reference} · ${data.name}`}
        description={data.objective}
        actions={
          <div className="flex gap-2">
            <Link to="/tests" className="btn-secondary">Back</Link>
            {can(Permissions.testWrite) && (
              <button type="button" className="btn-secondary" disabled={toggle.isPending}
                      onClick={() => toggle.mutate(!data.isEnabled)}>
                {data.isEnabled ? 'Disable' : 'Enable'}
              </button>
            )}
          </div>
        }
      />

      {runError !== null && <div className="mb-4"><ErrorNotice error={runError} /></div>}
      {run.isSuccess && (
        <div className="mb-4 rounded-lg border border-good/25 bg-good-light px-4 py-3 text-sm text-good">
          Run started. <Link to={`/runs/${run.data.id}`} className="underline font-semibold">Watch it live</Link>.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          <Card title="Steps" description={`${data.steps.length} step(s), version ${data.version}`}>
            <ol className="space-y-2.5">
              {data.steps.map(step => (
                <li key={step.id} className="rounded-lg border border-line px-3.5 py-3">
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full
                                     bg-surface-sunken text-xs font-semibold text-ink-muted tabular-nums">
                      {step.order}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="badge bg-brand-light text-brand font-mono">{step.action}</span>
                        {step.healCount > 0 && (
                          <span className="badge bg-info-light text-info" title="This step's locator has been healed before">
                            healed {step.healCount}×
                          </span>
                        )}
                        {!step.isCritical && <span className="badge bg-surface-sunken text-ink-muted">non-critical</span>}
                      </div>
                      <p className="mt-1 text-sm text-ink">{step.description}</p>

                      <dl className="mt-1.5 space-y-0.5 text-xs">
                        {step.targetDescription && (
                          <div className="flex gap-2">
                            <dt className="text-ink-subtle w-16 shrink-0">Target</dt>
                            <dd className="font-mono text-ink-muted break-all">{step.targetDescription}</dd>
                          </div>
                        )}
                        {step.url && (
                          <div className="flex gap-2">
                            <dt className="text-ink-subtle w-16 shrink-0">URL</dt>
                            <dd className="font-mono text-ink-muted break-all">{step.url}</dd>
                          </div>
                        )}
                        {step.value && (
                          <div className="flex gap-2">
                            <dt className="text-ink-subtle w-16 shrink-0">Value</dt>
                            <dd className="font-mono text-ink-muted break-all">
                              {step.value.startsWith('${secret:')
                                ? <span className="text-warn" title="Resolved from encrypted storage at dispatch; never stored on the test">{step.value}</span>
                                : step.value}
                            </dd>
                          </div>
                        )}
                      </dl>

                      {step.assertions.length > 0 && (
                        <ul className="mt-2 space-y-1">
                          {step.assertions.map(assertion => (
                            <li key={assertion.id} className="text-xs text-ink-muted flex items-start gap-1.5">
                              <span className="text-good mt-0.5" aria-hidden="true">✓</span>
                              <span>
                                <span className="font-medium">{humanize(assertion.type)}</span>
                                {assertion.expectedValue && <> = <span className="font-mono">{assertion.expectedValue}</span></>}
                                {assertion.description && <> — {assertion.description}</>}
                                {assertion.isSoft && <span className="ml-1 text-ink-subtle">(soft)</span>}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </Card>

          {(data.preconditions || data.expectedResults) && (
            <Card title="Expectations">
              <dl className="space-y-3">
                {data.preconditions && (
                  <div className="kv"><dt>Preconditions</dt><dd>{data.preconditions}</dd></div>
                )}
                {data.expectedResults && (
                  <div className="kv"><dt>Expected results</dt><dd>{data.expectedResults}</dd></div>
                )}
                {data.requirementReference && (
                  <div className="kv"><dt>Traces to requirement</dt><dd>{data.requirementReference}</dd></div>
                )}
              </dl>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card title="Run this test">
            {can(Permissions.executionRun) ? (
              <button type="button" className="btn-primary w-full" disabled={run.isPending}
                      onClick={() => run.mutate()}>
                {run.isPending ? 'Starting…' : 'Run now'}
              </button>
            ) : (
              <p className="text-sm text-ink-muted">You do not have permission to start runs.</p>
            )}
          </Card>

          <Card title="History">
            <dl className="grid grid-cols-2 gap-3">
              <div className="kv"><dt>Executions</dt><dd className="font-semibold">{data.statistics.executionCount}</dd></div>
              <div className="kv"><dt>Passed</dt><dd className="font-semibold text-good">{data.statistics.passCount}</dd></div>
              <div className="kv"><dt>Failed</dt><dd className="font-semibold text-bad">{data.statistics.failCount}</dd></div>
              <div className="kv"><dt>Healed</dt><dd className="font-semibold text-info">{data.statistics.healCount}</dd></div>
              <div className="kv"><dt>Avg duration</dt><dd>{formatDuration(data.statistics.averageDurationMs)}</dd></div>
              <div className="kv"><dt>Last run</dt><dd>{formatRelative(data.statistics.lastExecutedAt)}</dd></div>
            </dl>
            {data.statistics.lastStatus && (
              <div className="mt-3"><StatusBadge status={data.statistics.lastStatus} /></div>
            )}
            {data.statistics.executionCount >= 3 && data.statistics.flakinessScore > 0 && (
              <p className="mt-3 text-xs text-warn">
                This test has changed its verdict across recent runs (instability {data.statistics.flakinessScore}/100).
              </p>
            )}
          </Card>

          <Card title="Properties">
            <dl className="space-y-2.5">
              <div className="kv"><dt>Priority</dt><dd><StatusBadge status={data.priority} /></dd></div>
              <div className="kv"><dt>Risk</dt><dd><StatusBadge status={data.risk} /></dd></div>
              <div className="kv"><dt>Source</dt><dd>{humanize(data.source)}</dd></div>
              <div className="kv"><dt>Version</dt><dd>{data.version}</dd></div>
              {data.tags && (
                <div className="kv">
                  <dt>Tags</dt>
                  <dd className="flex flex-wrap gap-1 mt-0.5">
                    {data.tags.split(',').filter(Boolean).map(tag => (
                      <span key={tag} className="badge bg-surface-sunken text-ink-muted">{tag}</span>
                    ))}
                  </dd>
                </div>
              )}
            </dl>
          </Card>

          {data.testData && data.testData.length > 0 && (
            <Card title="Test data">
              <dl className="space-y-2">
                {data.testData.map(field => (
                  <div key={field.key} className="kv">
                    <dt>{field.key}</dt>
                    <dd className="font-mono text-xs">
                      {field.isSensitive
                        ? <span className="text-warn">held in encrypted storage</span>
                        : field.value || '—'}
                      <span className="ml-1.5 text-ink-subtle">({humanize(field.kind)})</span>
                    </dd>
                  </div>
                ))}
              </dl>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
