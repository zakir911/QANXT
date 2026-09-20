import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../api/client';
import { Permissions, useAuth } from '../lib/auth';
import { useProject } from '../lib/project';
import {
  Card, ConfidenceBar, EmptyState, ErrorNotice, PageHeader, Spinner, StatusBadge
} from '../components/ui';
import { formatRelative, humanize } from '../lib/format';

/**
 * The autonomous agent.
 *
 * The agent works unattended, so this screen is built around the one question that matters
 * afterwards: what did it do, and why. Every phase it went through is listed with its
 * reasoning, the bounds it ran under are shown next to what it actually used, and every
 * conclusion is labelled a proposal — because that is all any of them are.
 */

interface AgentRunSummary {
  id: string; applicationId: string; applicationName: string; name: string;
  objective?: string; status: string; phase: string;
  createdAt: string; startedAt?: string; completedAt?: string;
  pagesConsidered: number; areasAssessed: number; testsGenerated: number;
  testsExecuted: number; failuresInvestigated: number; proposalsMade: number;
  aiCostUsd: number; stopReason?: string; errorMessage?: string; summary?: string;
  discoveryRunId?: string; testSuiteId?: string; testRunId?: string;
}

interface AgentBounds {
  explore: boolean; execute: boolean; maxPages: number; maxDepth: number;
  maxTargets: number; maxGeneratedTests: number; timeBudgetSeconds: number; maxAiCostUsd: number;
}

interface AgentStep {
  order: number; phase: string; succeeded: boolean; description: string;
  rationale?: string; detail?: string; startedAt: string; durationMs: number;
}

interface AgentFinding {
  id: string; kind: string; severity: string; title: string; detail: string;
  recommendation?: string; confidence: number; route?: string;
  testCaseId?: string; testExecutionId?: string; isAiGenerated: boolean;
}

interface AgentRunDetail {
  summary: AgentRunSummary; bounds: AgentBounds;
  steps: AgentStep[]; findings: AgentFinding[];
}

interface ApplicationSummary { id: string; name: string }

const ACTIVE = new Set(['queued', 'running']);

export default function AgentPage() {
  const { can } = useAuth();
  const { projectId } = useProject();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  const { data: runs = [], isLoading, error, refetch } = useQuery({
    queryKey: ['agent-runs', projectId],
    queryFn: () => apiRequest<AgentRunSummary[]>('/api/v1/agent/runs?limit=25'),
    // A pass takes minutes and moves through phases; polling keeps the page honest without
    // the user needing to reload to find out it finished.
    refetchInterval: (query) =>
      (query.state.data ?? []).some(run => ACTIVE.has(run.status)) ? 4000 : false
  });

  const activeId = selectedId ?? runs[0]?.id ?? null;

  const { data: detail } = useQuery({
    queryKey: ['agent-run', activeId],
    queryFn: () => apiRequest<AgentRunDetail>(`/api/v1/agent/runs/${activeId}`),
    enabled: Boolean(activeId),
    refetchInterval: (query) =>
      query.state.data && ACTIVE.has(query.state.data.summary.status) ? 4000 : false
  });

  const cancel = useMutation({
    mutationFn: (id: string) => apiRequest<void>(`/api/v1/agent/runs/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agent-runs', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['agent-run', activeId] });
    }
  });

  if (!projectId) {
    return <EmptyState title="Choose a project" description="The agent works on one application at a time." />;
  }

  return (
    <>
      <PageHeader
        title="Autonomous agent"
        description="A bounded pass over an application: explore, score the risk, cover what is untested, run it, and write up what it found."
        actions={can(Permissions.agentRun) && !isStarting
          ? <button className="btn-primary" onClick={() => setIsStarting(true)}>Start a pass</button>
          : undefined}
      />

      {isStarting && (
        <StartPassForm
          projectId={projectId}
          onClose={() => setIsStarting(false)}
          onStarted={id => {
            setIsStarting(false);
            setSelectedId(id);
            void queryClient.invalidateQueries({ queryKey: ['agent-runs', projectId] });
          }}
        />
      )}

      {error ? <ErrorNotice error={error} onRetry={() => void refetch()} /> : isLoading ? <Spinner /> : (
        runs.length === 0 ? (
          <EmptyState
            title="No passes yet"
            description="An agent pass explores an application, scores where the risk is, generates tests for what is uncovered and runs them. It proposes; it never changes anything on its own."
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
            <Card title="Passes">
              <ul className="space-y-1.5">
                {runs.map(run => (
                  <li key={run.id}>
                    <button
                      className={`w-full rounded border px-3 py-2 text-left ${
                        run.id === activeId ? 'border-brand bg-brand-light/40' : 'border-line hover:bg-surface-sunken'
                      }`}
                      onClick={() => setSelectedId(run.id)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium text-ink">{run.name}</span>
                        <StatusBadge status={run.status} />
                      </div>
                      <div className="text-xs text-ink-muted">
                        {run.applicationName} · {formatRelative(run.createdAt)}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>

            {detail ? (
              <PassDetail
                detail={detail}
                canCancel={can(Permissions.agentRun)}
                isCancelling={cancel.isPending}
                onCancel={() => cancel.mutate(detail.summary.id)}
              />
            ) : <Spinner />}
          </div>
        )
      )}
    </>
  );
}

function PassDetail({ detail, canCancel, isCancelling, onCancel }: {
  detail: AgentRunDetail;
  canCancel: boolean;
  isCancelling: boolean;
  onCancel(): void;
}) {
  const { summary, bounds, steps, findings } = detail;
  const isActive = ACTIVE.has(summary.status);

  return (
    <div className="space-y-4">
      <Card
        title={summary.name}
        description={summary.objective ? `Objective: ${summary.objective}` : undefined}
        actions={isActive && canCancel
          ? <button className="btn-secondary text-xs" disabled={isCancelling} onClick={onCancel}>Stop the pass</button>
          : undefined}
      >
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <StatusBadge status={summary.status} />
          <span className="badge bg-surface-sunken text-ink-muted">{humanize(summary.phase)}</span>
          {summary.stopReason && <span className="text-xs text-ink-muted">{summary.stopReason}</span>}
        </div>

        {summary.errorMessage && (
          <p className="mb-3 rounded border border-bad bg-bad-light/40 px-3 py-2 text-sm text-bad">
            {summary.errorMessage}
          </p>
        )}

        {summary.summary && <p className="text-sm text-ink mb-3">{summary.summary}</p>}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
          <Counter label="Pages considered" value={summary.pagesConsidered} limit={bounds.maxPages} />
          <Counter label="Areas scored" value={summary.areasAssessed} />
          <Counter label="Tests generated" value={summary.testsGenerated} limit={bounds.maxGeneratedTests} />
          <Counter label="Tests run" value={summary.testsExecuted} />
          <Counter label="Failures looked at" value={summary.failuresInvestigated} />
          <Counter label="Proposals" value={summary.proposalsMade} />
        </dl>

        {/* Showing the bounds next to the counters is what lets a reader tell "it found
            nothing else" apart from "it ran out of budget". */}
        <p className="mt-3 text-xs text-ink-muted">
          Bounded to {bounds.maxPages} page(s) at depth {bounds.maxDepth}, {bounds.maxTargets} target(s),{' '}
          {bounds.maxGeneratedTests} test(s), {bounds.timeBudgetSeconds}s and ${bounds.maxAiCostUsd.toFixed(2)} of model spend.
          {!bounds.explore && ' Exploration was disabled.'}
          {!bounds.execute && ' Execution was disabled.'}
          {' '}Model spend used: ${summary.aiCostUsd.toFixed(2)}.
        </p>
      </Card>

      <Card title="What it did" description="Every phase, including the ones that decided to do nothing.">
        <ol className="space-y-2.5">
          {steps.map(step => (
            <li key={step.order} className="border-l-2 border-line pl-3">
              <div className="flex items-baseline gap-2">
                <span className="badge bg-surface-sunken text-ink-muted">{humanize(step.phase)}</span>
                <span className="text-sm text-ink">{step.description}</span>
                {!step.succeeded && <span className="badge bg-bad-light text-bad">failed</span>}
              </div>
              {step.rationale && <p className="mt-0.5 text-xs text-ink-muted">{step.rationale}</p>}
              {step.detail && <p className="mt-0.5 text-xs font-mono text-ink-muted">{step.detail}</p>}
              <p className="mt-0.5 text-xs text-ink-muted">{step.durationMs}ms</p>
            </li>
          ))}
          {steps.length === 0 && <li className="text-sm text-ink-muted">The pass has not started yet.</li>}
        </ol>
      </Card>

      <Card
        title={`Proposals (${findings.length})`}
        description="Nothing here has been acted on. The agent cannot raise a defect, change a test, approve a heal or alter a quality gate."
      >
        {findings.length === 0 ? (
          <p className="text-sm text-ink-muted">Nothing needs attention from this pass.</p>
        ) : (
          <ul className="space-y-2.5">
            {findings.map(finding => (
              <li key={finding.id} className="rounded border border-line px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`badge ${severityClass(finding.severity)}`}>{humanize(finding.severity)}</span>
                  <span className="badge bg-surface-sunken text-ink-muted">{humanize(finding.kind)}</span>
                  <span className="text-sm font-medium text-ink">{finding.title}</span>
                  {finding.isAiGenerated && <span className="badge bg-brand-light text-brand">model-assisted</span>}
                </div>
                <p className="mt-1 text-sm text-ink-muted">{finding.detail}</p>
                {finding.recommendation && (
                  <p className="mt-1 text-sm text-ink">Suggested: {finding.recommendation}</p>
                )}
                <div className="mt-1.5 max-w-xs"><ConfidenceBar value={finding.confidence} /></div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Counter({ label, value, limit }: { label: string; value: number; limit?: number }) {
  return (
    <div className="kv">
      <dt>{label}</dt>
      <dd>
        {value}
        {limit !== undefined && <span className="text-ink-muted"> / {limit}</span>}
      </dd>
    </div>
  );
}

function severityClass(severity: string): string {
  switch (severity) {
    case 'critical':
    case 'high': return 'bg-bad-light text-bad';
    case 'medium': return 'bg-warn-light text-warn';
    default: return 'bg-surface-sunken text-ink-muted';
  }
}

function StartPassForm({ projectId, onClose, onStarted }: {
  projectId: string;
  onClose(): void;
  onStarted(id: string): void;
}) {
  const [applicationId, setApplicationId] = useState('');
  const [objective, setObjective] = useState('');
  const [explore, setExplore] = useState(true);
  const [execute, setExecute] = useState(true);
  const [maxPages, setMaxPages] = useState('25');
  const [maxGeneratedTests, setMaxGeneratedTests] = useState('15');
  const [timeBudgetSeconds, setTimeBudgetSeconds] = useState('900');

  const { data: applications = [] } = useQuery({
    queryKey: ['applications', projectId],
    queryFn: () => apiRequest<ApplicationSummary[]>(`/api/v1/applications?projectId=${projectId}`)
  });

  const start = useMutation({
    mutationFn: () => apiRequest<AgentRunSummary>('/api/v1/agent/runs', {
      method: 'POST',
      body: {
        applicationId,
        objective: objective.trim() || undefined,
        explore,
        execute,
        maxPages: Number(maxPages),
        maxGeneratedTests: Number(maxGeneratedTests),
        timeBudgetSeconds: Number(timeBudgetSeconds)
      }
    }),
    onSuccess: run => onStarted(run.id)
  });

  return (
    <Card title="Start a pass" className="mb-4">
      <form
        className="space-y-3"
        onSubmit={event => { event.preventDefault(); start.mutate(); }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="label">Application</span>
            <select className="input" value={applicationId} required
                    onChange={event => setApplicationId(event.target.value)}>
              <option value="">Choose one…</option>
              {applications.map(app => <option key={app.id} value={app.id}>{app.name}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="label">What to concentrate on (optional)</span>
            <input className="input" value={objective} maxLength={300}
                   placeholder="Payments and statements"
                   onChange={event => setObjective(event.target.value)} />
          </label>
          <label className="block">
            <span className="label">Pages at most</span>
            <input className="input" type="number" min="1" max="200" value={maxPages}
                   onChange={event => setMaxPages(event.target.value)} />
          </label>
          <label className="block">
            <span className="label">Tests at most</span>
            <input className="input" type="number" min="1" max="100" value={maxGeneratedTests}
                   onChange={event => setMaxGeneratedTests(event.target.value)} />
          </label>
          <label className="block">
            <span className="label">Time budget (seconds)</span>
            <input className="input" type="number" min="30" max="3600" value={timeBudgetSeconds}
                   onChange={event => setTimeBudgetSeconds(event.target.value)} />
          </label>
        </div>

        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={explore} onChange={event => setExplore(event.target.checked)} />
            <span>Explore the application first</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={execute} onChange={event => setExecute(event.target.checked)} />
            <span>Run the tests it generates</span>
          </label>
        </div>

        <p className="text-xs text-ink-muted">
          The pass stops at whichever bound it reaches first. It proposes what it finds; it does
          not raise defects, change tests, approve heals or alter quality gates.
        </p>

        {start.error ? <ErrorNotice error={start.error} /> : null}

        <div className="flex gap-2">
          <button className="btn-primary text-xs" type="submit" disabled={start.isPending || !applicationId}>
            {start.isPending ? 'Starting…' : 'Start the pass'}
          </button>
          <button className="btn-secondary text-xs" type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Card>
  );
}
