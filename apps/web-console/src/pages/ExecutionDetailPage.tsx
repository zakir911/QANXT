import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../api/client';
import { ArtifactImage, ArtifactLink } from '../components/AuthenticatedMedia';
import { Card, ConfidenceBar, ErrorNotice, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { formatBytes, formatDateTime, formatDuration, humanize } from '../lib/format';

interface ExecutionDetail {
  id: string; testRunId: string; testCaseId: string; reference: string; name: string;
  objective: string; expectedResults: string; status: string;
  startedAt?: string; completedAt?: string; durationMs: number; attempt: number;
  testCaseVersion: number; browser: string; browserVersion?: string; workerId?: string;
  correlationId: string; stepsTotal: number; stepsPassed: number; stepsFailed: number;
  stepsHealed: number; consoleErrorCount: number; networkErrorCount: number;
  errorMessage?: string; errorStack?: string;
  actions: {
    id: string; order: number; action: string; description: string; status: string;
    startedAt: string; durationMs: number; url?: string; maskedValue?: string;
    wasHealed: boolean; healingConfidence?: number; errorMessage?: string;
    locatorDescription?: string; locatorAlternativesJson?: string;
  }[];
  artifacts: {
    id: string; kind: string; name: string; contentType: string;
    sizeBytes: number; isMasked: boolean; testActionId?: string;
  }[];
  failure?: {
    id: string; category: string; categoryConfidence: number; rawMessage: string;
    signature: string; isNewFailure: boolean; isRegression: boolean; occurrenceCount: number;
    firstSeenAt: string; lastSeenAt: string;
    analysis?: {
      summary: string; likelyCause: string; evidence: string; suggestedAction: string;
      category: string; confidence: number; isLikelyApplicationDefect: boolean;
      isHealable: boolean; producedByAi: boolean; provider?: string; model?: string;
    };
  };
  healingEvents: {
    id: string; testStepId: string; confidence: number; outcome: string;
    outcomeVerified: boolean; reason: string; original: string; healed: string;
    scoreBreakdownJson?: string;
  }[];
}

type Tab = 'steps' | 'evidence' | 'console' | 'network';

export default function ExecutionDetailPage() {
  const { executionId } = useParams<{ executionId: string }>();
  const [tab, setTab] = useState<Tab>('steps');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['execution', executionId],
    queryFn: () => apiRequest<ExecutionDetail>(`/api/v1/executions/${executionId}`),
    enabled: Boolean(executionId)
  });

  if (isLoading) return <Spinner label="Loading execution" />;
  if (error) return <ErrorNotice error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  const screenshots = data.artifacts.filter(a => a.kind === 'screenshot');

  return (
    <>
      <PageHeader
        title={`${data.reference} · ${data.name}`}
        description={data.objective}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={data.status} />
            <Link to={`/runs/${data.testRunId}`} className="btn-secondary">Back to run</Link>
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-4 mb-4">
        <Card title="Execution">
          <dl className="space-y-2">
            <div className="kv"><dt>Duration</dt><dd>{formatDuration(data.durationMs)}</dd></div>
            <div className="kv"><dt>Steps</dt><dd>{data.stepsPassed} of {data.stepsTotal} passed</dd></div>
            <div className="kv"><dt>Browser</dt><dd>{data.browser} {data.browserVersion}</dd></div>
            <div className="kv"><dt>Worker</dt><dd className="font-mono text-xs">{data.workerId ?? '—'}</dd></div>
            <div className="kv">
              <dt>Correlation id</dt>
              <dd className="font-mono text-xs break-all" title="Use this to find every log line for this execution">
                {data.correlationId}
              </dd>
            </div>
          </dl>
        </Card>

        {data.failure ? (
          <Card title="Diagnosis" className="lg:col-span-3">
            <div className="flex items-center gap-2 flex-wrap mb-2">
              <StatusBadge status={data.failure.category} />
              <span className="text-xs text-ink-muted">{data.failure.categoryConfidence}% confidence</span>
              {data.failure.isNewFailure && <span className="badge bg-warn-light text-warn">new failure</span>}
              {data.failure.isRegression && <span className="badge bg-bad-light text-bad">regression</span>}
              {data.failure.occurrenceCount > 1 && (
                <span className="badge bg-surface-sunken text-ink-muted">
                  seen {data.failure.occurrenceCount}× since {formatDateTime(data.failure.firstSeenAt)}
                </span>
              )}
            </div>

            {data.failure.analysis ? (
              <div className="space-y-2.5">
                <p className="text-sm font-semibold text-ink">{data.failure.analysis.summary}</p>
                <dl className="space-y-2">
                  <div className="kv"><dt>Likely cause</dt><dd>{data.failure.analysis.likelyCause}</dd></div>
                  <div className="kv"><dt>Evidence</dt>
                    <dd className="font-mono text-xs whitespace-pre-wrap">{data.failure.analysis.evidence}</dd></div>
                  <div className="kv"><dt>Suggested action</dt><dd>{data.failure.analysis.suggestedAction}</dd></div>
                </dl>
                <p className="text-xs text-ink-muted">
                  {data.failure.analysis.producedByAi
                    ? `Analysed by ${data.failure.analysis.provider} ${data.failure.analysis.model} at ${data.failure.analysis.confidence}% confidence.`
                    : `Classified by AIRA's built-in rules at ${data.failure.analysis.confidence}% confidence.`}
                  {data.failure.analysis.isLikelyApplicationDefect && ' This looks like a defect in the application, not the test.'}
                </p>
              </div>
            ) : (
              <p className="text-sm text-ink-muted">No analysis was recorded for this failure.</p>
            )}

            <details className="mt-3">
              <summary className="cursor-pointer text-sm font-medium text-brand">Engine error (verbatim)</summary>
              <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-surface-sunken p-3 text-xs
                              font-mono whitespace-pre-wrap">{data.failure.rawMessage}</pre>
            </details>
          </Card>
        ) : (
          <Card title="Result" className="lg:col-span-3">
            <p className="text-sm text-ink">
              {data.status === 'healed'
                ? 'This execution passed, but one or more locators had to be repaired to get there. Review the healing proposals before they are made permanent.'
                : data.status === 'blocked'
                  ? 'This execution never started: its preconditions were not met. That is an environment or configuration problem, not a product defect.'
                  : 'All steps and assertions passed.'}
            </p>
            {data.expectedResults && (
              <div className="kv mt-3"><dt>Expected results</dt><dd>{data.expectedResults}</dd></div>
            )}
          </Card>
        )}
      </div>

      {data.healingEvents.length > 0 && (
        <Card title="Healing during this execution" className="mb-4"
              description="Each proposal keeps the original locator, so approval and reversal are both exact.">
          <ul className="space-y-3">
            {data.healingEvents.map(event => (
              <li key={event.id} className="rounded-lg border border-line p-3.5">
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <StatusBadge status={event.outcome} />
                  {event.outcomeVerified && (
                    <span className="badge bg-good-light text-good"
                          title="The replacement was accepted only after the action it stood in for actually worked">
                      outcome verified
                    </span>
                  )}
                  <div className="ml-auto"><ConfidenceBar value={event.confidence} /></div>
                </div>
                <div className="font-mono text-xs text-ink-muted break-all">
                  <span className="text-bad line-through">{event.original}</span>
                  <span className="mx-2" aria-hidden="true">→</span>
                  <span className="text-good">{event.healed}</span>
                </div>
                <p className="mt-2 text-sm text-ink-muted">{event.reason}</p>
              </li>
            ))}
          </ul>
          <Link to="/healing" className="btn-secondary btn-sm mt-3">Review all proposals</Link>
        </Card>
      )}

      <div className="flex gap-1 mb-4 p-1 bg-surface-sunken rounded-lg w-fit" role="tablist">
        {([
          ['steps', `Steps (${data.actions.length})`],
          ['evidence', `Evidence (${data.artifacts.length})`],
          ['console', `Console (${data.consoleErrorCount})`],
          ['network', `Network (${data.networkErrorCount} failed)`]
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={`rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
              tab === value ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted hover:text-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'steps' && (
        <Card title="What the browser did">
          <ol className="space-y-2">
            {data.actions.map(action => (
              <li key={action.id}
                  className={`rounded-lg border px-3.5 py-3 ${
                    action.status === 'failed' ? 'border-bad/30 bg-bad-light/40' :
                    action.status === 'healed' ? 'border-info/30 bg-info-light/40' : 'border-line'
                  }`}>
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full
                                   bg-surface text-xs font-semibold tabular-nums border border-line">
                    {action.order}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="badge bg-surface-sunken text-ink-muted font-mono">{action.action}</span>
                      <StatusBadge status={action.status} />
                      {action.wasHealed && (
                        <span className="badge bg-info-light text-info">
                          healed {action.healingConfidence ? `${action.healingConfidence}%` : ''}
                        </span>
                      )}
                      <span className="ml-auto text-xs text-ink-subtle tabular-nums">
                        {formatDuration(action.durationMs)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-ink">{action.description}</p>
                    {action.locatorDescription && (
                      <p className="mt-0.5 text-xs font-mono text-ink-muted break-all">{action.locatorDescription}</p>
                    )}
                    {action.maskedValue && (
                      <p className="mt-0.5 text-xs font-mono text-ink-muted">value: {action.maskedValue}</p>
                    )}
                    {action.errorMessage && (
                      <p className="mt-1.5 text-xs text-bad">{action.errorMessage}</p>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {tab === 'evidence' && (
        <div className="space-y-4">
          {screenshots.length > 0 && (
            <Card title="Screenshots">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {screenshots.map(shot => (
                  <figure key={shot.id} className="space-y-1.5">
                    <div className="rounded-lg border border-line overflow-hidden">
                      <ArtifactImage artifactId={shot.id} alt={shot.name} className="w-full h-auto" />
                    </div>
                    <figcaption className="text-xs text-ink-muted flex items-center justify-between gap-2">
                      <span>{shot.name} · {formatBytes(shot.sizeBytes)}</span>
                      <ArtifactLink artifactId={shot.id} name={shot.name} className="text-brand hover:underline">
                        Download
                      </ArtifactLink>
                    </figcaption>
                  </figure>
                ))}
              </div>
            </Card>
          )}

          <Card title="All artifacts"
                description="Evidence is masked before it is stored — screenshots, DOM snapshots and logs never carry a credential.">
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Kind</th><th>Name</th><th>Size</th><th>Masked</th><th></th></tr></thead>
                <tbody>
                  {data.artifacts.map(artifact => (
                    <tr key={artifact.id}>
                      <td><span className="badge bg-surface-sunken text-ink-muted">{humanize(artifact.kind)}</span></td>
                      <td className="font-mono text-xs">{artifact.name}</td>
                      <td className="tabular-nums text-xs">{formatBytes(artifact.sizeBytes)}</td>
                      <td className="text-xs">{artifact.isMasked ? 'yes' : '—'}</td>
                      <td>
                        <ArtifactLink artifactId={artifact.id} name={artifact.name} className="btn-secondary btn-sm">
                          Download
                        </ArtifactLink>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {tab === 'console' && <ConsoleTab executionId={data.id} />}
      {tab === 'network' && <NetworkTab executionId={data.id} />}
    </>
  );
}

function ConsoleTab({ executionId }: { executionId: string }) {
  const { data = [], isLoading } = useQuery({
    queryKey: ['execution-console', executionId],
    queryFn: () => apiRequest<{
      id: string; level: string; message: string; stackTrace?: string; url?: string; occurredAt: string;
    }[]>(`/api/v1/executions/${executionId}/console`)
  });

  if (isLoading) return <Spinner label="Loading console output" />;

  return (
    <Card title="Console output">
      {data.length === 0 ? (
        <p className="text-sm text-ink-muted py-6 text-center">The page logged nothing during this execution.</p>
      ) : (
        <ul className="space-y-1.5 font-mono text-xs">
          {data.map(entry => (
            <li key={entry.id} className="flex gap-2">
              <span className={`shrink-0 font-semibold ${
                entry.level === 'error' || entry.level === 'pageerror' ? 'text-bad' : 'text-warn'
              }`}>
                [{entry.level}]
              </span>
              <span className="text-ink-muted break-all">{entry.message}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function NetworkTab({ executionId }: { executionId: string }) {
  const { data = [], isLoading } = useQuery({
    queryKey: ['execution-network', executionId],
    queryFn: () => apiRequest<{
      id: string; method: string; url: string; resourceType?: string; statusCode?: number;
      durationMs: number; isFailed: boolean; failureText?: string; occurredAt: string;
      requestHeadersJson?: string; responseBodyExcerpt?: string;
    }[]>(`/api/v1/executions/${executionId}/network`)
  });

  if (isLoading) return <Spinner label="Loading network activity" />;

  return (
    <Card title="Network activity"
          description="Authorization headers, cookies and API keys are redacted before capture.">
      {data.length === 0 ? (
        <p className="text-sm text-ink-muted py-6 text-center">No documents or API calls were recorded.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Method</th><th>URL</th><th>Status</th><th>Duration</th></tr></thead>
            <tbody>
              {data.map(entry => (
                <tr key={entry.id} className={entry.isFailed ? 'bg-bad-light/40' : undefined}>
                  <td className="font-mono text-xs font-semibold">{entry.method}</td>
                  <td className="font-mono text-xs break-all max-w-md">{entry.url}</td>
                  <td>
                    <span className={`text-xs font-semibold tabular-nums ${
                      !entry.statusCode ? 'text-bad' :
                      entry.statusCode >= 500 ? 'text-bad' :
                      entry.statusCode >= 400 ? 'text-warn' : 'text-good'
                    }`}>
                      {entry.statusCode ?? entry.failureText ?? 'failed'}
                    </span>
                  </td>
                  <td className="tabular-nums text-xs">{formatDuration(entry.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
