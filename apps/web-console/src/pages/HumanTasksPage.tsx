import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, apiUpload } from '../api/client';
import { Permissions, useAuth } from '../lib/auth';
import { useProject } from '../lib/project';
import { Card, EmptyState, ErrorNotice, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { categoryLabel } from '../lib/quality';

interface HumanTask {
  id: string; formName?: string | null; testCaseId?: string | null; title: string; category: string; reason: string;
  steps: string; expectedResult: string; status: string; comments?: string | null; origin: string;
  evidence: { storageKey: string; name: string; contentType: string; sizeBytes: number; uploadedAt: string }[];
  completedAt?: string | null;
}

const STATUSES = ['pending', 'passed', 'failed', 'blocked', 'notApplicable'];
const LABEL: Record<string, string> = { pending: 'Pending', passed: 'Passed', failed: 'Failed', blocked: 'Blocked', notApplicable: 'Not applicable' };

/**
 * The checks only a person can make, with the reason a machine could not, the steps, and
 * what should happen. A verdict is a person's and is never overwritten by the platform.
 */
export default function HumanTasksPage() {
  const { can } = useAuth();
  const { projectId } = useProject();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('pending');
  const [error, setError] = useState<unknown>(null);
  const [comments, setComments] = useState<Record<string, string>>({});

  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ['human-tasks', projectId, status],
    queryFn: () => apiRequest<HumanTask[]>(`/api/v1/human-tasks?projectId=${projectId}${status ? `&status=${status}` : ''}`),
    enabled: Boolean(projectId)
  });

  const refresh = async () => { setError(null); await queryClient.invalidateQueries({ queryKey: ['human-tasks'] }); };
  const verdict = useMutation({
    mutationFn: ({ id, next }: { id: string; next: string }) =>
      apiRequest(`/api/v1/human-tasks/${id}/verdict`, { method: 'POST', body: { status: next, comments: comments[id] || null } }),
    onSuccess: refresh, onError: setError
  });
  const upload = useMutation({
    mutationFn: ({ id, file }: { id: string; file: File }) => {
      const form = new FormData();
      form.append('file', file);
      return apiUpload(`/api/v1/human-tasks/${id}/evidence`, form);
    },
    onSuccess: refresh, onError: setError
  });

  if (!projectId) return <EmptyState title="Choose a project" description="Verification tasks belong to a project." />;
  const mayWrite = can(Permissions.testWrite);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Human verification"
        description="What a machine cannot decide — screen-reader experience, business rules, brute-force protection — done and recorded like any other result."
        actions={
          <select className="input" aria-label="Filter by status" value={status} onChange={e => setStatus(e.target.value)}>
            <option value="">All</option>
            {STATUSES.map(s => <option key={s} value={s}>{LABEL[s]}</option>)}
          </select>
        }
      />
      {error ? <ErrorNotice error={error} /> : null}
      {isLoading ? <Spinner label="Loading tasks" /> : null}
      {!isLoading && tasks.length === 0 ? <EmptyState title="Nothing here" description="Generation and manual-test import create tasks for anything that needs a person." /> : null}

      {tasks.map(task => (
        <Card key={task.id} title={task.title}
          description={`${categoryLabel(task.category)}${task.formName ? ` · ${task.formName}` : ''} · ${task.origin}`}
          actions={<StatusBadge status={['pending', 'passed', 'failed'].includes(task.status) ? task.status : 'skipped'} title={LABEL[task.status] ?? task.status} />}>
          <div className="grid gap-3 md:grid-cols-3 text-sm">
            <div><h3 className="label">Why a person</h3><p>{task.reason}</p></div>
            <div><h3 className="label">Steps</h3><p className="whitespace-pre-wrap">{task.steps}</p></div>
            <div><h3 className="label">Expected</h3><p className="whitespace-pre-wrap">{task.expectedResult}</p></div>
          </div>
          {task.evidence.length > 0 ? (
            <p className="mt-2 text-xs">Evidence: {task.evidence.map(e => `${e.name} (${Math.round(e.sizeBytes / 1024)} KB)`).join(', ')}</p>
          ) : null}
          {task.comments ? <p className="mt-2 text-sm"><span className="label">Comments:</span> {task.comments}</p> : null}
          {mayWrite ? (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <label className="text-sm flex-1 min-w-[16rem]">
                <span className="label block">Comment</span>
                <input className="input w-full" value={comments[task.id] ?? ''} onChange={e => setComments({ ...comments, [task.id]: e.target.value })}
                  placeholder="What you observed (required for a failure)" />
              </label>
              {['passed', 'failed', 'blocked', 'notApplicable'].map(next => (
                <button key={next} type="button" className={next === 'passed' ? 'btn-primary btn-sm' : next === 'failed' ? 'btn-danger btn-sm' : 'btn-secondary btn-sm'}
                  disabled={verdict.isPending} onClick={() => verdict.mutate({ id: task.id, next })}>
                  {LABEL[next]}
                </button>
              ))}
              <label className="btn-secondary btn-sm cursor-pointer">
                Attach evidence
                <input type="file" className="sr-only" accept="image/*,application/pdf,text/plain,video/webm,video/mp4"
                  onChange={e => { const file = e.target.files?.[0]; if (file) upload.mutate({ id: task.id, file }); e.target.value = ''; }} />
              </label>
            </div>
          ) : null}
        </Card>
      ))}
    </div>
  );
}
