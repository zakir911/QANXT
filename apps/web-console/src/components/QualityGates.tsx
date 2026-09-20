import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../api/client';
import { useAuth } from '../lib/auth';
import { Card, ErrorNotice, Spinner } from '../components/ui';
import { humanize } from '../lib/format';

/**
 * Configuring what blocks a pipeline.
 *
 * The rules are the only place a person decides that a run is not good enough to ship, so
 * this screen shows the rule in the words the evaluator will use, not as a row of raw
 * fields. Editing needs the quality-gate permission; without it the rules are readable but
 * the controls are absent rather than present-and-failing.
 */

interface GateRule {
  id: string;
  projectId: string;
  name: string;
  metric: string;
  operator: string;
  threshold: number;
  isBlocking: boolean;
  isEnabled: boolean;
}

const METRICS = [
  'passRatePercent', 'failedCount', 'criticalFailedCount', 'flakyCount', 'newFailureCount',
  'highConfidenceDefectCount', 'criticalJourneyFailedCount', 'healedCount', 'averageDurationMs'
] as const;

const OPERATORS = [
  'lessThan', 'lessThanOrEqual', 'greaterThan', 'greaterThanOrEqual', 'equal', 'notEqual'
] as const;

const OPERATOR_WORDS: Record<string, string> = {
  lessThan: 'is below',
  lessThanOrEqual: 'is at most',
  greaterThan: 'is above',
  greaterThanOrEqual: 'is at least',
  equal: 'equals',
  notEqual: 'differs from'
};

const describe = (rule: Pick<GateRule, 'metric' | 'operator' | 'threshold'>): string =>
  `Block when ${humanize(rule.metric).toLowerCase()} is not ${OPERATOR_WORDS[rule.operator] ?? rule.operator} ${rule.threshold}.`;

export default function QualityGates({ projectId }: { projectId: string | null }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const canEdit = user?.permissions.includes('qualitygate:write') ?? false;
  const [isAdding, setIsAdding] = useState(false);

  const { data: rules = [], isLoading, error, refetch } = useQuery({
    queryKey: ['quality-gates', projectId],
    queryFn: () => apiRequest<GateRule[]>(`/api/v1/quality-gates?projectId=${projectId}`),
    enabled: Boolean(projectId)
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['quality-gates', projectId] });

  const create = useMutation({
    mutationFn: (body: Omit<GateRule, 'id' | 'projectId'>) =>
      apiRequest<GateRule>(`/api/v1/quality-gates?projectId=${projectId}`, { method: 'POST', body }),
    onSuccess: () => { setIsAdding(false); void invalidate(); }
  });

  const update = useMutation({
    mutationFn: ({ id, ...body }: GateRule) =>
      apiRequest<GateRule>(`/api/v1/quality-gates/${id}`, { method: 'PUT', body }),
    onSuccess: () => void invalidate()
  });

  const remove = useMutation({
    mutationFn: (id: string) => apiRequest<void>(`/api/v1/quality-gates/${id}`, { method: 'DELETE' }),
    onSuccess: () => void invalidate()
  });

  if (!projectId) return null;

  return (
    <Card
      title="Quality gates"
      className="lg:col-span-2"
      description="What makes a run fail a pipeline. With no rules, a run never blocks."
      actions={canEdit && !isAdding
        ? <button className="btn-secondary text-xs" onClick={() => setIsAdding(true)}>Add a rule</button>
        : undefined}
    >
      {error ? <ErrorNotice error={error} onRetry={() => void refetch()} /> : isLoading ? <Spinner /> : (
        <>
          {rules.length === 0 && !isAdding && (
            <p className="text-sm text-ink-muted">
              No rules are configured, so every run reports its results without blocking.
              {canEdit ? ' Add one to start gating releases.' : ''}
            </p>
          )}

          {rules.length > 0 && (
            <ul className="space-y-2">
              {rules.map(rule => (
                <li key={rule.id}
                    className="flex items-start justify-between gap-3 rounded border border-line px-3 py-2">
                  <div className={rule.isEnabled ? '' : 'opacity-60'}>
                    <div className="text-sm font-medium text-ink">
                      {rule.name}
                      <span className={`ml-2 badge ${rule.isBlocking
                        ? 'bg-bad-light text-bad' : 'bg-surface-sunken text-ink-muted'}`}>
                        {rule.isBlocking ? 'blocking' : 'warning only'}
                      </span>
                      {!rule.isEnabled && (
                        <span className="ml-2 badge bg-surface-sunken text-ink-muted">disabled</span>
                      )}
                    </div>
                    <p className="text-xs text-ink-muted mt-0.5">{describe(rule)}</p>
                  </div>

                  {canEdit && (
                    <div className="flex shrink-0 gap-2">
                      <button
                        className="btn-secondary text-xs"
                        disabled={update.isPending}
                        onClick={() => update.mutate({ ...rule, isEnabled: !rule.isEnabled })}
                      >
                        {rule.isEnabled ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        className="btn-secondary text-xs"
                        disabled={remove.isPending}
                        onClick={() => {
                          // Deleting a gate is a release decision, so it is confirmed rather
                          // than being one stray click away.
                          if (confirm(`Delete the rule "${rule.name}"? Runs will no longer be blocked by it.`)) {
                            remove.mutate(rule.id);
                          }
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {isAdding && (
            <NewRuleForm
              isSaving={create.isPending}
              error={create.error}
              onCancel={() => setIsAdding(false)}
              onSave={rule => create.mutate(rule)}
            />
          )}
        </>
      )}
    </Card>
  );
}

function NewRuleForm({ onSave, onCancel, isSaving, error }: {
  onSave(rule: Omit<GateRule, 'id' | 'projectId'>): void;
  onCancel(): void;
  isSaving: boolean;
  error: unknown;
}) {
  const [name, setName] = useState('');
  const [metric, setMetric] = useState<string>('passRatePercent');
  const [operator, setOperator] = useState<string>('greaterThanOrEqual');
  const [threshold, setThreshold] = useState('95');
  const [isBlocking, setIsBlocking] = useState(true);

  const preview = describe({ metric, operator, threshold: Number(threshold) || 0 });

  return (
    <form
      className="mt-3 space-y-3 rounded border border-line bg-surface-sunken p-3"
      onSubmit={event => {
        event.preventDefault();
        onSave({ name, metric, operator, threshold: Number(threshold), isBlocking, isEnabled: true });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="label">Name</span>
          <input className="input" value={name} required maxLength={200}
                 placeholder="Pass rate at least 95%"
                 onChange={event => setName(event.target.value)} />
        </label>
        <label className="block">
          <span className="label">Measure</span>
          <select className="input" value={metric} onChange={event => setMetric(event.target.value)}>
            {METRICS.map(option => <option key={option} value={option}>{humanize(option)}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="label">Must be</span>
          <select className="input" value={operator} onChange={event => setOperator(event.target.value)}>
            {OPERATORS.map(option => (
              <option key={option} value={option}>{OPERATOR_WORDS[option] ?? option}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">Threshold</span>
          <input className="input" type="number" min="0" step="any" value={threshold} required
                 onChange={event => setThreshold(event.target.value)} />
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={isBlocking} onChange={event => setIsBlocking(event.target.checked)} />
        <span>Block the pipeline when this rule is not met</span>
      </label>

      {/* The rule is restated in the evaluator's own words before it is saved, so nobody
          discovers what they configured only when a release is blocked. */}
      <p className="text-xs text-ink-muted">{preview}</p>

      {error ? <ErrorNotice error={error} /> : null}

      <div className="flex gap-2">
        <button className="btn-primary text-xs" type="submit" disabled={isSaving || !name.trim()}>
          {isSaving ? 'Saving…' : 'Save rule'}
        </button>
        <button className="btn-secondary text-xs" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
