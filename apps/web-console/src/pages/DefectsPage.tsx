import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../api/client';
import { Permissions, useAuth } from '../lib/auth';
import { useProject } from '../lib/project';
import { Card, EmptyState, ErrorNotice, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { categoryLabel } from '../lib/quality';

interface DefectSummary {
  id: string; reference: string; title: string; severity: string; status: string; category?: string | null;
  affectedTestCount: number; occurrenceCount: number; firstSeenAt?: string | null; lastSeenAt?: string | null;
  applicationFormId?: string | null; regressionTestCaseId?: string | null;
}

interface DefectDetail {
  summary: DefectSummary; description: string; stepsToReproduce: string; expectedBehaviour: string; actualBehaviour: string;
  affectedTests: { testCaseId: string; reference: string; name: string; failureId: string; executionId: string; at: string }[];
}

/**
 * Defects, one per underlying problem.
 *
 * Failures that share a symptom and a place are proposed as one defect, with every affected
 * test listed under it. A proposal is not a finding until a person confirms it; a confirmed
 * defect can become a permanent regression test.
 */
export default function DefectsPage() {
  const { can } = useAuth();
  const { projectId } = useProject();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const { data: defects = [], isLoading } = useQuery({
    queryKey: ['defects', projectId, status],
    queryFn: () => apiRequest<DefectSummary[]>(`/api/v1/defects?projectId=${projectId}${status ? `&status=${status}` : ''}`),
    enabled: Boolean(projectId)
  });
  const { data: detail } = useQuery({
    queryKey: ['defect', open],
    queryFn: () => apiRequest<DefectDetail>(`/api/v1/defects/${open}`),
    enabled: Boolean(open)
  });

  const refresh = async () => {
    setError(null);
    await queryClient.invalidateQueries({ queryKey: ['defects'] });
    await queryClient.invalidateQueries({ queryKey: ['defect'] });
  };
  const setDefectStatus = useMutation({
    mutationFn: ({ id, next }: { id: string; next: string }) => apiRequest(`/api/v1/defects/${id}/status`, { method: 'POST', body: { status: next } }),
    onSuccess: refresh, onError: setError
  });
  const regression = useMutation({
    mutationFn: (id: string) => apiRequest<{ testCaseId: string }>(`/api/v1/defects/${id}/regression-test`, { method: 'POST' }),
    onSuccess: refresh, onError: setError
  });

  if (!projectId) return <EmptyState title="Choose a project" description="Defects belong to a project." />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Defects"
        description="One defect per underlying problem, however many tests found it. Proposed until a person confirms it."
        actions={
          <select className="input" aria-label="Filter by status" value={status} onChange={e => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {['proposed', 'open', 'triaged', 'inProgress', 'resolved', 'rejected', 'duplicate'].map(s => <option key={s} value={s}>{s === 'open' ? 'Confirmed (open)' : s === 'inProgress' ? 'In progress' : s[0]!.toUpperCase() + s.slice(1)}</option>)}
          </select>
        }
      />
      {error ? <ErrorNotice error={error} /> : null}
      {isLoading ? <Spinner label="Loading defects" /> : null}
      {!isLoading && defects.length === 0 ? <EmptyState title="No defects" description="A failing test that shows an application problem proposes one here." /> : null}

      {defects.length > 0 ? (
        <Card>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Defect</th><th>Severity</th><th>Status</th><th>Category</th><th>Affected tests</th><th>Occurrences</th><th>Actions</th></tr></thead>
              <tbody>
                {defects.map(d => (
                  <tr key={d.id}>
                    <td>
                      <button type="button" className="text-left text-brand underline" aria-expanded={open === d.id} onClick={() => setOpen(open === d.id ? null : d.id)}>
                        {d.reference}: {d.title}
                      </button>
                    </td>
                    <td><StatusBadge status={d.severity === 'major' ? 'high' : d.severity === 'blocker' ? 'critical' : d.severity} title={d.severity} /></td>
                    <td><StatusBadge status={d.status === 'open' ? 'confirmed' : d.status} title={d.status} /></td>
                    <td className="text-xs">{d.category ? categoryLabel(d.category) : '—'}</td>
                    <td>{d.affectedTestCount}</td>
                    <td>{d.occurrenceCount}</td>
                    <td className="space-x-1 whitespace-nowrap">
                      {can(Permissions.defectWrite) && d.status === 'proposed' ? (
                        <>
                          <button type="button" className="btn-primary btn-sm" onClick={() => setDefectStatus.mutate({ id: d.id, next: 'Open' })}>Confirm</button>
                          <button type="button" className="btn-secondary btn-sm" onClick={() => setDefectStatus.mutate({ id: d.id, next: 'Rejected' })}>Reject</button>
                        </>
                      ) : null}
                      {can(Permissions.testWrite) && !['proposed', 'rejected', 'duplicate'].includes(d.status) ? (
                        d.regressionTestCaseId
                          ? <Link className="btn-secondary btn-sm" to={`/tests/${d.regressionTestCaseId}`}>Regression test</Link>
                          : <button type="button" className="btn-secondary btn-sm" onClick={() => regression.mutate(d.id)}>Make regression test</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {open && detail ? (
        <Card title={`${detail.summary.reference}: ${detail.summary.title}`} description={detail.description}>
          <div className="grid gap-4 md:grid-cols-2 text-sm">
            <div><h3 className="label">Expected</h3><p>{detail.expectedBehaviour}</p></div>
            <div><h3 className="label">Actual</h3><p className="whitespace-pre-wrap">{detail.actualBehaviour}</p></div>
            <div className="md:col-span-2"><h3 className="label">Steps to reproduce</h3><pre className="whitespace-pre-wrap text-xs">{detail.stepsToReproduce}</pre></div>
          </div>
          <h3 className="label mt-4">Affected tests ({detail.affectedTests.length})</h3>
          <ul className="text-sm list-disc pl-5">
            {detail.affectedTests.map(t => (
              <li key={t.failureId}>
                <Link className="text-brand underline" to={`/tests/${t.testCaseId}`}>{t.reference}</Link> {t.name}
                {' — '}<Link className="text-brand underline" to={`/executions/${t.executionId}`}>evidence</Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
