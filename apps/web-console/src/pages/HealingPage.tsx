import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../api/client';
import { Permissions, useAuth } from '../lib/auth';
import { useProject } from '../lib/project';
import { Card, ConfidenceBar, EmptyState, ErrorNotice, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { formatRelative, humanize } from '../lib/format';

interface HealingProposal {
  id: string; projectId: string; testCaseId: string; testCaseName: string;
  testStepId: string; stepDescription: string;
  originalLocator: string; healedLocator: string; reason: string;
  confidence: number; outcome: string; outcomeVerified: boolean;
  policyAtTime: string; producedByAi: boolean; occurredAt: string;
  reviewedByUserId?: string; reviewedAt?: string; reviewComment?: string;
  scoreBreakdownJson?: string; applicationBuildRef?: string;
}

/**
 * Locator healing, and the decision about whether it becomes permanent.
 *
 * Approving is the only way a heal reaches the stored test. Everything needed to decide is
 * on the card: what broke, what replaced it, how confident the engine was, which signals
 * agreed, and whether the replacement was verified by actually re-running the action.
 */
export default function HealingPage() {
  const { can } = useAuth();
  const { projectId } = useProject();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<string>('');
  const [error, setError] = useState<unknown>(null);

  const { data: proposals = [], isLoading } = useQuery({
    queryKey: ['healing', projectId, filter],
    queryFn: () => apiRequest<HealingProposal[]>(
      `/api/v1/healing?limit=100${projectId ? `&projectId=${projectId}` : ''}${filter ? `&outcome=${filter}` : ''}`)
  });

  const review = useMutation({
    mutationFn: ({ id, action, comment }: { id: string; action: string; comment?: string }) =>
      apiRequest(`/api/v1/healing/${id}/${action}`, { method: 'POST', body: { comment } }),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['healing'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: setError
  });

  if (isLoading) return <Spinner label="Loading healing proposals" />;

  return (
    <>
      <PageHeader
        title="Self-healing"
        description="When a locator stops matching, the engine looks for the element the step meant to reach. Nothing becomes permanent without approval."
        actions={
          <select value={filter} onChange={e => setFilter(e.target.value)} className="input w-auto">
            <option value="">All outcomes</option>
            <option value="proposed">Awaiting review</option>
            <option value="applied">Applied in a run</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="reverted">Reverted</option>
          </select>
        }
      />

      {error !== null && <div className="mb-4"><ErrorNotice error={error} /></div>}

      {proposals.length === 0 ? (
        <Card>
          <EmptyState
            title="No healing proposals"
            description="Nothing has needed repair. When an application's markup changes and a stored locator stops matching, the proposals appear here with the evidence behind them."
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {proposals.map(proposal => {
            const breakdown = parseBreakdown(proposal.scoreBreakdownJson);
            const decided = ['approved', 'rejected', 'reverted'].includes(proposal.outcome);

            return (
              <Card
                key={proposal.id}
                title={proposal.testCaseName}
                description={proposal.stepDescription}
                actions={
                  <div className="flex items-center gap-2">
                    <StatusBadge status={proposal.outcome} />
                    {proposal.outcomeVerified && (
                      <span className="badge bg-good-light text-good"
                            title="The replacement was only accepted after the action it stood in for actually succeeded">
                        verified
                      </span>
                    )}
                  </div>
                }
              >
                <div className="grid gap-4 lg:grid-cols-3">
                  <div className="lg:col-span-2 space-y-3">
                    <div className="rounded-lg bg-surface-sunken p-3">
                      <div className="font-mono text-xs break-all">
                        <div className="text-bad line-through">{proposal.originalLocator}</div>
                        <div className="text-good mt-1">{proposal.healedLocator}</div>
                      </div>
                    </div>

                    <p className="text-sm text-ink-muted">{proposal.reason}</p>

                    {Object.keys(breakdown).length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle mb-1.5">
                          Signal agreement
                        </h4>
                        <ul className="flex flex-wrap gap-1.5">
                          {Object.entries(breakdown).map(([signal, points]) => (
                            <li key={signal}
                                className={`badge ${points >= 0 ? 'bg-surface-sunken text-ink-muted' : 'bg-warn-light text-warn'}`}>
                              {humanize(signal)} {points >= 0 ? '+' : ''}{points}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  <div className="space-y-3">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-wide text-ink-subtle mb-1.5">
                        Confidence
                      </div>
                      <ConfidenceBar value={proposal.confidence} />
                    </div>

                    <dl className="space-y-1.5 text-xs">
                      <div className="kv"><dt>Policy at the time</dt><dd>{humanize(proposal.policyAtTime)}</dd></div>
                      <div className="kv"><dt>Detected</dt><dd>{formatRelative(proposal.occurredAt)}</dd></div>
                      {proposal.applicationBuildRef && (
                        <div className="kv"><dt>Application build</dt><dd className="font-mono">{proposal.applicationBuildRef}</dd></div>
                      )}
                      {proposal.reviewedAt && (
                        <div className="kv"><dt>Reviewed</dt><dd>{formatRelative(proposal.reviewedAt)}</dd></div>
                      )}
                    </dl>

                    {proposal.reviewComment && (
                      <p className="text-xs text-ink-muted italic">“{proposal.reviewComment}”</p>
                    )}

                    {can(Permissions.healingApprove) && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {!decided && (
                          <>
                            <button type="button" className="btn-primary btn-sm" disabled={review.isPending}
                                    onClick={() => review.mutate({ id: proposal.id, action: 'approve' })}>
                              Approve
                            </button>
                            <button type="button" className="btn-secondary btn-sm" disabled={review.isPending}
                                    onClick={() => review.mutate({ id: proposal.id, action: 'reject' })}>
                              Reject
                            </button>
                          </>
                        )}
                        {proposal.outcome === 'approved' && (
                          <button type="button" className="btn-danger btn-sm" disabled={review.isPending}
                                  onClick={() => review.mutate({ id: proposal.id, action: 'revert' })}>
                            Revert
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}

function parseBreakdown(json: string | undefined): Record<string, number> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as Record<string, number>;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
