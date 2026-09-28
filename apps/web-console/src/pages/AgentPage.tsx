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

/**
 * The plan a person answers, and everything the pass recorded about itself.
 *
 * These shapes mirror the API exactly. Getting them wrong is how a screen shows blanks that
 * look like absences: a field named `proposedAction` when the API sends `proposal` renders as
 * nothing at all, and nothing is indistinguishable from "the agent proposed nothing".
 */
interface AgentPlanItem {
  id: string; category: string; testCount: number; toGenerate: number;
  why: string; risk: string; coverage: string;
  estimatedSeconds: number; estimateFromHistory: boolean;
  potentialImpact: string; included: boolean;
}

interface AgentPlan {
  id: string; agentRunId: string; applicationId: string; status: string;
  objective: string; pagesDiscovered: number; endpointsDiscovered: number;
  journeysKnown: number; rolesKnown: number; summary: string;
  notCovered: string[]; items: AgentPlanItem[];
  totalTests: number; estimatedSeconds: number;
  decidedByEmail?: string; decidedAt?: string; decisionNote?: string;
}

interface AgentEvidenceEntry { name: string; value: string }

interface AgentDecision {
  id: string; sequence: number; phase: string; tool?: string;
  summary: string; reason: string; evidence: AgentEvidenceEntry[];
  result?: string; allowed: boolean; denial?: string; risk?: string;
  actorUserId?: string; modelContributed: boolean; aiCostUsd: number;
  occurredAt: string;
}

interface AgentApproval {
  id: string; tool: string; reason: string; proposal: string;
  evidence: AgentEvidenceEntry[]; risk: string; expectedImpact?: string;
  status: string; decidedByEmail?: string; justification?: string; decidedAt?: string;
}

interface AgentTimelineEntry {
  at: string; kind: string; phase: string; title: string;
  detail?: string; link?: string;
}

interface ApplicationContextView {
  applicationId: string;
  criticalJourneys: string[]; highRiskAreas: string[]; excludedAreas: string[];
  notes: string; updatedAt?: string; updatedByUserId?: string;
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

            {detail && activeId ? (
              <PassDetail
                runId={activeId}
                detail={detail}
                canAct={can(Permissions.agentRun)}
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

function PassDetail({ runId, detail, canAct, isCancelling, onCancel }: {
  runId: string;
  detail: AgentRunDetail;
  canAct: boolean;
  isCancelling: boolean;
  onCancel(): void;
}) {
  const { summary, bounds, steps, findings } = detail;
  const isActive = ACTIVE.has(summary.status);
  // A pass parked on a question is not "active" in the queued/running sense, but it is
  // absolutely still moving from the reader's point of view: answering releases it. Both
  // states poll, or a person answers a question and the page appears to do nothing.
  const isMoving = isActive || summary.status === 'awaitingApproval';

  // The plan, the questions, the decisions and the timeline. Each is its own endpoint, and
  // each is allowed to be absent: a pass that has not reached its planning phase has no plan,
  // and that is a 404 rather than an error worth showing.
  const { data: plan } = useQuery({
    queryKey: ['agent-plan', runId],
    queryFn: () => apiRequest<AgentPlan>(`/api/v1/agent/runs/${runId}/plan`),
    retry: false,
    refetchInterval: isMoving ? 4000 : false
  });

  const { data: approvals = [] } = useQuery({
    queryKey: ['agent-approvals', runId],
    queryFn: () => apiRequest<AgentApproval[]>(`/api/v1/agent/runs/${runId}/approvals`),
    refetchInterval: isMoving ? 4000 : false
  });

  const { data: decisions = [] } = useQuery({
    queryKey: ['agent-decisions', runId],
    queryFn: () => apiRequest<AgentDecision[]>(`/api/v1/agent/runs/${runId}/decisions`),
    refetchInterval: isMoving ? 4000 : false
  });

  const { data: timeline = [] } = useQuery({
    queryKey: ['agent-timeline', runId],
    queryFn: () => apiRequest<AgentTimelineEntry[]>(`/api/v1/agent/runs/${runId}/timeline`),
    refetchInterval: isMoving ? 4000 : false
  });

  const { data: context } = useQuery({
    queryKey: ['agent-context', summary.applicationId],
    queryFn: () => apiRequest<ApplicationContextView>(
      `/api/v1/agent/applications/${summary.applicationId}/context`),
    retry: false
  });

  return (
    <div className="space-y-4">
      <Card
        title={summary.name}
        description={summary.objective ? `Objective: ${summary.objective}` : undefined}
        actions={isActive && canAct
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

      {/* The blocking things first. A pass waiting on somebody must not be something a
          reader discovers below three cards of counters. */}
      {plan && <PlanCard runId={runId} plan={plan} canDecide={canAct} />}

      <ApprovalQueue runId={runId} approvals={approvals} canDecide={canAct} />

      {context && <ContextCard context={context} />}

      <TimelineCard entries={timeline} />

      <DecisionLog decisions={decisions} />

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

/**
 * The plan, and the decision a person makes about it.
 *
 * A pass that has proposed a plan is doing nothing until this is answered, so the answer is
 * the primary action on the screen when it appears. Categories can be switched off
 * individually: a plan a person can only accept whole is not a proposal, it is a notification.
 */
function PlanCard({ runId, plan, canDecide }: {
  runId: string; plan: AgentPlan; canDecide: boolean;
}) {
  const queryClient = useQueryClient();
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');

  const decide = useMutation({
    mutationFn: (approve: boolean) => apiRequest<AgentPlan>(
      `/api/v1/agent/runs/${runId}/plan/decision`,
      {
        method: 'POST',
        body: {
          approve,
          // Only sent when a category was switched off. Omitting it means "all of them",
          // which is what approving an unmodified plan should mean.
          includedCategories: approve && excluded.size > 0
            ? plan.items.filter(item => !excluded.has(item.category)).map(item => item.category)
            : null,
          note: note.trim() || null
        }
      }
    ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agent-plan', runId] });
      void queryClient.invalidateQueries({ queryKey: ['agent-run', runId] });
      void queryClient.invalidateQueries({ queryKey: ['agent-timeline', runId] });
    }
  });

  const awaitingAnswer = plan.status === 'proposed';
  const included = plan.items.filter(item => !excluded.has(item.category));
  const plannedTests = included.reduce((total, item) => total + item.toGenerate, 0);

  return (
    <Card
      title={awaitingAnswer ? 'The agent is waiting for an answer' : 'The plan'}
      description={awaitingAnswer
        ? 'Nothing has been generated or run. The pass stops here until somebody decides.'
        : `${humanize(plan.status)}${plan.decidedByEmail ? ` by ${plan.decidedByEmail}` : ''}`}
      className={awaitingAnswer ? 'border-warn' : ''}
    >
      <p className="text-sm text-ink mb-3">{plan.summary}</p>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4 mb-3">
        <Counter label="Pages found" value={plan.pagesDiscovered} />
        <Counter label="Endpoints found" value={plan.endpointsDiscovered} />
        <Counter label="Journeys recorded" value={plan.journeysKnown} />
        <Counter label="Tests proposed" value={plan.totalTests} />
      </dl>

      <ul className="space-y-2">
        {plan.items.map(item => {
          const off = excluded.has(item.category);
          return (
            <li
              key={item.id}
              className={`rounded border px-3 py-2 ${
                off || !item.included ? 'border-line bg-surface-sunken opacity-60' : 'border-line'
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                {awaitingAnswer && canDecide && (
                  <input
                    type="checkbox"
                    checked={!off}
                    aria-label={`Include ${humanize(item.category)}`}
                    onChange={() => setExcluded(previous => {
                      const next = new Set(previous);
                      if (next.has(item.category)) next.delete(item.category);
                      else next.add(item.category);
                      return next;
                    })}
                  />
                )}
                <span className="text-sm font-medium text-ink">{humanize(item.category)}</span>
                <span className={`badge ${severityClass(item.risk)}`}>{humanize(item.risk)}</span>
                <span className="text-xs text-ink-muted">
                  {item.testCount} test(s), {item.toGenerate} to write
                </span>
                {!item.included && <span className="badge bg-surface-sunken text-ink-muted">switched off</span>}
              </div>
              <p className="mt-1 text-sm text-ink-muted">{item.why}</p>
              <p className="mt-0.5 text-xs text-ink-muted">
                Covers: {item.coverage} · {item.potentialImpact}
              </p>
              {/* Where the estimate came from, every time. A number whose provenance is
                  invisible is one people either over-trust or ignore. */}
              <p className="mt-0.5 text-xs text-ink-muted">
                Roughly {Math.round(item.estimatedSeconds / 60)} minute(s) —{' '}
                {item.estimateFromHistory
                  ? 'estimated from how long these have taken on this application before'
                  : 'estimated from defaults; this application has no execution history yet'}
              </p>
            </li>
          );
        })}
      </ul>

      {/* What the plan does not cover, shown before anybody approves it rather than
          discovered afterwards. */}
      {plan.notCovered.length > 0 && (
        <div className="mt-3 rounded border border-line bg-surface-sunken px-3 py-2">
          <p className="text-xs font-medium text-ink">This plan does not cover</p>
          <ul className="mt-1 space-y-0.5">
            {plan.notCovered.map((entry, index) => (
              <li key={index} className="text-xs text-ink-muted">· {entry}</li>
            ))}
          </ul>
        </div>
      )}

      {awaitingAnswer && canDecide && (
        <div className="mt-3 space-y-2 border-t border-line pt-3">
          <label className="block text-xs text-ink-muted" htmlFor="plan-note">
            Why (recorded with your name against this decision)
          </label>
          <input
            id="plan-note"
            className="input w-full"
            value={note}
            placeholder="Approved for the release candidate."
            onChange={event => setNote(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="btn-primary"
              disabled={decide.isPending || included.length === 0}
              onClick={() => decide.mutate(true)}
            >
              {excluded.size > 0
                ? `Approve ${included.length} of ${plan.items.length} categories (${plannedTests} new test(s))`
                : `Approve the plan (${plan.totalTests} test(s))`}
            </button>
            <button className="btn-secondary" disabled={decide.isPending} onClick={() => decide.mutate(false)}>
              Refuse the plan
            </button>
            {included.length === 0 && (
              <span className="text-xs text-warn">
                Nothing is included. Refuse the plan instead of approving an empty one.
              </span>
            )}
          </div>
          {decide.error ? <ErrorNotice error={decide.error} /> : null}
        </div>
      )}

      {plan.decisionNote && (
        <p className="mt-3 text-xs text-ink-muted">
          “{plan.decisionNote}”
          {plan.decidedByEmail && ` — ${plan.decidedByEmail}`}
          {plan.decidedAt && `, ${formatRelative(plan.decidedAt)}`}
        </p>
      )}
    </Card>
  );
}

/**
 * The questions the pass stopped to ask, and the answers.
 *
 * Every answer needs a reason, because the API refuses one without: an approval with nobody's
 * reasoning behind it is indistinguishable from the control being switched off. The form makes
 * that a field rather than a surprise 400.
 */
function ApprovalQueue({ runId, approvals, canDecide }: {
  runId: string; approvals: AgentApproval[]; canDecide: boolean;
}) {
  const pending = approvals.filter(approval => approval.status === 'pending');
  const answered = approvals.filter(approval => approval.status !== 'pending');

  if (approvals.length === 0) {
    return (
      <Card title="Questions" description="Anything that changes state stops the pass and asks.">
        <p className="text-sm text-ink-muted">This pass has not needed to ask anything yet.</p>
      </Card>
    );
  }

  return (
    <Card
      title={pending.length > 0 ? `${pending.length} question(s) waiting` : 'Questions'}
      description="Anything that changes state stops the pass and asks. Asking is not granting."
      className={pending.length > 0 ? 'border-warn' : ''}
    >
      <ul className="space-y-3">
        {pending.map(approval => (
          <PendingApproval key={approval.id} runId={runId} approval={approval} canDecide={canDecide} />
        ))}
        {answered.map(approval => (
          <li key={approval.id} className="rounded border border-line px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="badge bg-surface-sunken text-ink-muted font-mono text-xs">{approval.tool}</span>
              <StatusBadge status={approval.status} />
              {approval.risk && <span className={`badge ${severityClass(approval.risk)}`}>{humanize(approval.risk)}</span>}
            </div>
            <p className="mt-1 text-sm text-ink">{approval.proposal}</p>
            {approval.justification && (
              <p className="mt-1 text-xs text-ink-muted">
                “{approval.justification}”
                {approval.decidedByEmail && ` — ${approval.decidedByEmail}`}
                {approval.decidedAt && `, ${formatRelative(approval.decidedAt)}`}
              </p>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function PendingApproval({ runId, approval, canDecide }: {
  runId: string; approval: AgentApproval; canDecide: boolean;
}) {
  const queryClient = useQueryClient();
  const [justification, setJustification] = useState('');

  const decide = useMutation({
    mutationFn: (grant: boolean) => apiRequest<AgentApproval>(
      `/api/v1/agent/approvals/${approval.id}/decision`,
      { method: 'POST', body: { grant, justification } }
    ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agent-approvals', runId] });
      void queryClient.invalidateQueries({ queryKey: ['agent-run', runId] });
      void queryClient.invalidateQueries({ queryKey: ['agent-timeline', runId] });
      void queryClient.invalidateQueries({ queryKey: ['agent-decisions', runId] });
    }
  });

  // The API's own bar, applied here so the refusal is not a surprise. It exists because a
  // two-word justification is not a reason anybody can review later.
  const tooThin = justification.trim().length < 10;

  return (
    <li className="rounded border border-warn bg-warn-light/20 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge bg-surface-sunken text-ink-muted font-mono text-xs">{approval.tool}</span>
        <span className={`badge ${severityClass(approval.risk)}`}>{humanize(approval.risk)}</span>
      </div>
      <p className="mt-1.5 text-sm font-medium text-ink">{approval.proposal}</p>
      <p className="mt-1 text-sm text-ink-muted">{approval.reason}</p>
      {approval.expectedImpact && (
        <p className="mt-1 text-sm text-ink">
          <span className="text-ink-muted">If granted: </span>{approval.expectedImpact}
        </p>
      )}

      {approval.evidence.length > 0 && <EvidenceList evidence={approval.evidence} />}

      {canDecide ? (
        <div className="mt-2.5 space-y-2 border-t border-line pt-2.5">
          <label className="block text-xs text-ink-muted" htmlFor={`justify-${approval.id}`}>
            Why — stored with your name against this answer, and required
          </label>
          <input
            id={`justify-${approval.id}`}
            className="input w-full"
            value={justification}
            placeholder="Authorized for the staging environment by the release owner."
            onChange={event => setJustification(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="btn-primary"
              disabled={decide.isPending || tooThin}
              onClick={() => decide.mutate(true)}
            >
              Grant {approval.tool}
            </button>
            <button
              className="btn-secondary"
              disabled={decide.isPending || tooThin}
              onClick={() => decide.mutate(false)}
            >
              Refuse {approval.tool}
            </button>
            {tooThin && (
              <span className="text-xs text-ink-muted">
                A reason of at least ten characters is required.
              </span>
            )}
          </div>
          {decide.error ? <ErrorNotice error={decide.error} /> : null}
        </div>
      ) : (
        <p className="mt-2 text-xs text-ink-muted">
          Answering this needs the agent:run permission.
        </p>
      )}
    </li>
  );
}

/** Evidence, as name/value pairs. Masked before it was stored; shown as stored. */
function EvidenceList({ evidence }: { evidence: AgentEvidenceEntry[] }) {
  return (
    <dl className="mt-2 space-y-0.5 rounded bg-surface-sunken px-2.5 py-1.5">
      {evidence.map((entry, index) => (
        <div key={index} className="flex gap-2 text-xs">
          <dt className="shrink-0 font-mono text-ink-muted">{entry.name}</dt>
          <dd className="break-all text-ink">{entry.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The run, in order, assembled from its phases, decisions and questions.
 *
 * A refusal is rendered as distinctly as a permitted action, because on this screen the
 * refusals are the reassuring entries: they are the pass declining to do something nobody
 * authorized. Folding them in with everything else would lose that.
 */
function TimelineCard({ entries }: { entries: AgentTimelineEntry[] }) {
  return (
    <Card
      title="Timeline"
      description="Every phase, question and decision in the order it happened."
    >
      {entries.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing recorded yet.</p>
      ) : (
        <ol className="space-y-2">
          {entries.map((entry, index) => (
            <li key={index} className={`border-l-2 pl-3 ${timelineTone(entry.kind)}`}>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="badge bg-surface-sunken text-ink-muted text-xs">{humanize(entry.kind)}</span>
                {entry.phase && (
                  <span className="text-xs text-ink-muted">{humanize(entry.phase)}</span>
                )}
                <span className="text-sm text-ink">{entry.title}</span>
              </div>
              {entry.detail && <p className="mt-0.5 text-xs text-ink-muted">{entry.detail}</p>}
              <p className="mt-0.5 text-xs text-ink-muted">{formatRelative(entry.at)}</p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/**
 * The eight kinds the API actually emits, listed rather than pattern-matched.
 *
 * The first version of this guessed at substrings — 'question', 'denial' — that the API never
 * sends, so refusals and approvals rendered in the neutral colour and the distinction the
 * function existed to draw was silently absent. Driving a real pass and reading the payload
 * is what caught it. Naming the kinds means an unrecognised one is visibly plain rather than
 * accidentally plain.
 */
function timelineTone(kind: string): string {
  switch (kind) {
    // A refusal is the reassuring entry on this screen: the pass declining something nobody
    // authorized. It is coloured like a problem because it is the thing to go and read.
    case 'refusal':
    case 'phase-failed':
    case 'approval-refused':
      return 'border-bad';
    case 'approval-requested':
    case 'approval-granted':
      return 'border-warn';
    case 'run':
    case 'phase':
    case 'decision':
      return 'border-line';
    default:
      return 'border-line';
  }
}

/**
 * Every decision, with the evidence behind it.
 *
 * The platform refuses to record a permitted decision with no evidence, so an empty evidence
 * list here can only belong to a refusal — and that is worth saying rather than leaving as a
 * blank space somebody has to interpret.
 */
function DecisionLog({ decisions }: { decisions: AgentDecision[] }) {
  const refused = decisions.filter(decision => !decision.allowed);
  const spend = decisions.reduce((total, decision) => total + decision.aiCostUsd, 0);

  return (
    <Card
      title={`Decisions (${decisions.length})`}
      description={
        `${refused.length} refused. Every permitted decision carries the evidence it rests on — `
        + `the platform will not record one without. Model spend across all of them: $${spend.toFixed(2)}.`
      }
    >
      {decisions.length === 0 ? (
        <p className="text-sm text-ink-muted">No decisions recorded yet.</p>
      ) : (
        <ol className="space-y-2.5">
          {decisions.map(decision => (
            <li
              key={decision.id}
              className={`rounded border px-3 py-2 ${
                decision.allowed ? 'border-line' : 'border-bad bg-bad-light/15'
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-ink-muted">#{decision.sequence}</span>
                <span className="badge bg-surface-sunken text-ink-muted text-xs">{humanize(decision.phase)}</span>
                {decision.tool && (
                  <span className="badge bg-surface-sunken font-mono text-xs text-ink-muted">{decision.tool}</span>
                )}
                {decision.risk && (
                  <span className="badge bg-surface-sunken text-ink-muted text-xs">{humanize(decision.risk)}</span>
                )}
                {decision.allowed
                  ? <span className="badge bg-ok-light text-ok text-xs">permitted</span>
                  : <span className="badge bg-bad-light text-bad text-xs">refused</span>}
                {decision.modelContributed && (
                  <span className="badge bg-brand-light text-brand text-xs">model-assisted</span>
                )}
              </div>

              <p className="mt-1 text-sm font-medium text-ink">{decision.summary}</p>
              <p className="mt-0.5 text-sm text-ink-muted">{decision.reason}</p>

              {/* Which rung of the ladder stopped it. Without this a refusal is a shrug. */}
              {decision.denial && (
                <p className="mt-1 text-xs text-bad">Stopped by: {humanize(decision.denial)}</p>
              )}
              {decision.result && (
                <p className="mt-0.5 text-xs text-ink-muted">Result: {decision.result}</p>
              )}

              {decision.evidence.length > 0
                ? <EvidenceList evidence={decision.evidence} />
                : (
                  <p className="mt-1.5 text-xs text-ink-muted">
                    No evidence — which is only possible on a refusal, because nothing was done.
                  </p>
                )}

              <p className="mt-1 text-xs text-ink-muted">
                {formatRelative(decision.occurredAt)}
                {decision.aiCostUsd > 0 && ` · $${decision.aiCostUsd.toFixed(4)} of model spend`}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/**
 * What a person has told the platform about this application.
 *
 * Read-only here on purpose: this screen is about one pass, and the context belongs to the
 * application across all of them. What matters is that a reader of a pass can see what steered
 * it — including, when the platform noticed, that something a person named matched nothing.
 */
function ContextCard({ context }: { context: ApplicationContextView }) {
  const empty = context.criticalJourneys.length === 0
    && context.highRiskAreas.length === 0
    && context.excludedAreas.length === 0
    && !context.notes;

  return (
    <Card
      title="What a person said about this application"
      description="Loaded once when the pass started. Editing it cannot widen a pass already running."
    >
      {empty ? (
        <p className="text-sm text-ink-muted">
          Nobody has described this application. That is not the same as nothing being critical —
          the pass scored it on structure alone.
        </p>
      ) : (
        <dl className="space-y-2">
          <ContextRow label="Critical journeys" values={context.criticalJourneys} />
          <ContextRow label="High-risk areas" values={context.highRiskAreas} />
          <ContextRow
            label="Never touch"
            values={context.excludedAreas}
            note="Honoured absolutely, before any risk score is computed."
          />
          {context.notes && (
            <div className="kv">
              <dt>Notes</dt>
              <dd className="text-sm text-ink">{context.notes}</dd>
            </div>
          )}
        </dl>
      )}
    </Card>
  );
}

function ContextRow({ label, values, note }: { label: string; values: string[]; note?: string }) {
  if (values.length === 0) return null;
  return (
    <div className="kv">
      <dt>{label}</dt>
      <dd>
        <div className="flex flex-wrap gap-1">
          {values.map(value => (
            <span key={value} className="badge bg-surface-sunken text-ink-muted">{value}</span>
          ))}
        </div>
        {note && <p className="mt-0.5 text-xs text-ink-muted">{note}</p>}
      </dd>
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
