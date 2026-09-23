import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../api/client';
import { Permissions, useAuth } from '../lib/auth';
import { useProject } from '../lib/project';
import { Card, EmptyState, ErrorNotice, Metric, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { formatRelative, humanize } from '../lib/format';

interface AuditEntry {
  id: string;
  projectId?: string | null;
  userEmail?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  changesJson?: string | null;
  correlationId?: string | null;
  succeeded: boolean;
  occurredAt: string;
}

interface AuditPageResponse { entries: AuditEntry[]; total: number; limit: number; offset: number }

const PAGE_SIZE = 50;

/**
 * Who did what, and whether it worked.
 *
 * Separate from every other screen because it answers a different question. The rest of the
 * console shows what the application under test did; this shows what people did to the
 * platform — and it needs its own permission, because it names them.
 *
 * Failures are given their own filter and their own badge rather than a column, because a
 * run of failed sign-ins is the thing somebody opens this page to find, and it is invisible
 * in a list where success and failure look alike.
 */
export default function AuditPage() {
  const { can } = useAuth();
  const { projectId } = useProject();
  const [action, setAction] = useState('');
  const [failedOnly, setFailedOnly] = useState(false);
  const [correlationId, setCorrelationId] = useState('');
  const [offset, setOffset] = useState(0);

  const mayRead = can(Permissions.auditRead);

  const { data: actions = [] } = useQuery({
    queryKey: ['audit-actions'],
    queryFn: () => apiRequest<Array<{ name: string; value: number }>>('/api/v1/audit/actions'),
    enabled: mayRead,
    staleTime: Infinity
  });

  const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (action) query.set('action', action);
  if (failedOnly) query.set('succeeded', 'false');
  if (correlationId.trim()) query.set('correlationId', correlationId.trim());
  if (projectId) query.set('projectId', projectId);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['audit', query.toString()],
    queryFn: () => apiRequest<AuditPageResponse>(`/api/v1/audit?${query.toString()}`),
    enabled: mayRead
  });

  // Said plainly rather than by showing an empty table. "You cannot see this" and "there is
  // nothing here" are different answers and must not look the same.
  if (!mayRead) {
    return (
      <div>
        <PageHeader title="Audit" description="Who did what, and whether it worked." />
        <EmptyState
          title="You do not have permission to read the audit trail"
          description={
            'The trail names people and what they did, so it needs audit:read — a separate '
            + 'permission from reading test results. Project administrators and above hold it. '
            + 'Ask an organization administrator if you need it.'
          }
        />
      </div>
    );
  }

  const entries = data?.entries ?? [];
  const shown = (data?.offset ?? 0) + entries.length;
  const failedInPage = entries.filter(e => !e.succeeded).length;

  const reset = (apply: () => void) => { apply(); setOffset(0); };

  return (
    <div>
      <PageHeader
        title="Audit"
        description="Append-only. Nothing in the product can change or delete these records."
      />

      {error ? <ErrorNotice error={error} onRetry={() => refetch()} /> : null}

      <div className="grid gap-3 sm:grid-cols-3 mb-4">
        <Metric label="Matching records" value={data ? String(data.total) : '—'} />
        <Metric
          label="Failed in this page"
          value={String(failedInPage)}
          tone={failedInPage > 0 ? 'bad' : 'neutral'}
          hint="Actions that did not succeed — a refused sign-in, a rejected change."
        />
        <Metric label="Action kinds recorded" value={String(actions.length)} />
      </div>

      <Card title="Filter">
        <div className="flex flex-wrap items-end gap-4">
          <label className="label">
            <span className="block mb-1">Action</span>
            <select
              className="input w-auto"
              value={action}
              onChange={e => reset(() => setAction(e.target.value))}
            >
              <option value="">Every action</option>
              {actions.map(entry => (
                <option key={entry.name} value={entry.name.charAt(0).toLowerCase() + entry.name.slice(1)}>
                  {humanize(entry.name)}
                </option>
              ))}
            </select>
          </label>

          <label className="label">
            <span className="block mb-1">Correlation id</span>
            <input
              className="input w-auto font-mono"
              type="text"
              placeholder="Everything one request did"
              value={correlationId}
              onChange={e => reset(() => setCorrelationId(e.target.value))}
            />
          </label>

          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={failedOnly}
              onChange={e => reset(() => setFailedOnly(e.target.checked))}
            />
            Only what did not succeed
          </label>
        </div>
      </Card>

      {isLoading ? <Spinner label="Reading the audit trail" /> : null}

      {!isLoading && entries.length === 0 ? (
        <EmptyState
          title="No audit records match"
          description={
            failedOnly
              ? 'Nothing failed under these filters. That is the answer you want.'
              : 'Not every request is audited — only security- and governance-relevant actions are.'
          }
        />
      ) : null}

      {entries.map(entry => (
        <Card key={entry.id}>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge
                status={entry.succeeded ? 'passed' : 'failed'}
                title={entry.succeeded ? 'Succeeded' : 'Did not succeed'}
              />
              <strong>{humanize(entry.action)}</strong>
              <span className="text-sm text-ink-muted">{entry.entityType}</span>
              <span className="text-xs text-ink-muted ml-auto" title={entry.occurredAt}>{formatRelative(entry.occurredAt)}</span>
            </div>

            <p className="text-sm text-ink">{entry.summary}</p>

            <div className="flex flex-wrap items-center gap-3 text-xs text-ink-muted">
              <span>{entry.userEmail ?? 'no user in context'}</span>
              {entry.correlationId ? (
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  title="Show everything this request did"
                  onClick={() => reset(() => setCorrelationId(entry.correlationId!))}
                >
                  correlation {entry.correlationId.slice(0, 12)}…
                </button>
              ) : null}
            </div>

            {entry.changesJson ? (
              <details>
                <summary className="text-xs text-ink-muted cursor-pointer">What changed</summary>
                <pre className="mt-2 rounded-lg bg-surface-sunken p-3 text-xs overflow-x-auto">{entry.changesJson}</pre>
              </details>
            ) : null}
          </div>
        </Card>
      ))}

      {data && data.total > PAGE_SIZE ? (
        <div className="flex items-center justify-center gap-3 py-4">
          <button type="button" className="btn btn-sm btn-secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
            Newer
          </button>
          {/* Says what is not being shown. A pager that only offers "next" lets a reader
              assume they have seen everything. */}
          <span className="text-sm text-ink-muted tabular-nums">{shown} of {data.total}</span>
          <button type="button" className="btn btn-sm btn-secondary" disabled={shown >= data.total} onClick={() => setOffset(offset + PAGE_SIZE)}>
            Older
          </button>
        </div>
      ) : null}
    </div>
  );
}
