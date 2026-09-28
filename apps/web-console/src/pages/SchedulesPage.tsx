import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../api/client';
import { Permissions, useAuth } from '../lib/auth';
import { useProject } from '../lib/project';
import { Card, EmptyState, ErrorNotice, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { formatRelative } from '../lib/format';

interface Schedule {
  id: string; projectId: string; name: string;
  /** What it starts: a test run, or a security scan of one application. */
  kind: 'testRun' | 'securityScan';
  applicationId?: string | null;
  cronExpression: string; timeZone: string;
  testSuiteId?: string | null; includeTags?: string | null;
  environmentId?: string | null; browser: string;
  isEnabled: boolean; disabledReason?: string | null;
  lastRunAt?: string | null; lastRunId?: string | null;
  nextRunAt?: string | null; consecutiveFailureCount: number;
}

/**
 * Regression that happens without anybody asking.
 *
 * The screen is built around the two things that go wrong with schedules and are invisible
 * from a list of cron expressions: one that stopped running, and one whose expression does
 * not mean what whoever typed it thought.
 *
 * A schedule the platform disabled after repeated failure is the loudest thing here, because
 * it is not running and nobody chose that.
 */
export default function SchedulesPage() {
  const { can } = useAuth();
  const { projectId } = useProject();
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);

  const mayWrite = can(Permissions.projectWrite);

  const { data: schedules = [], isLoading } = useQuery({
    queryKey: ['schedules', projectId],
    queryFn: () => apiRequest<Schedule[]>(`/api/v1/schedules?projectId=${projectId}`),
    enabled: Boolean(projectId)
  });

  const { data: preview = [] } = useQuery({
    queryKey: ['schedule-preview', previewing],
    queryFn: () => apiRequest<string[]>(`/api/v1/schedules/${previewing}/preview?count=5`),
    enabled: Boolean(previewing)
  });

  const setEnabled = useMutation({
    mutationFn: ({ id, isEnabled }: { id: string; isEnabled: boolean }) =>
      apiRequest(`/api/v1/schedules/${id}`, { method: 'PATCH', body: { isEnabled } }),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['schedules'] });
    },
    onError: setError
  });

  if (!projectId) {
    return (
      <div>
        <PageHeader title="Schedules" description="Regression that happens without anybody asking." />
        <EmptyState title="Choose a project" description="Schedules belong to a project." />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Schedules"
        description="Regression that happens without anybody asking. A schedule that turns itself off says why."
      />

      {error ? <ErrorNotice error={error} /> : null}
      {isLoading ? <Spinner label="Loading schedules" /> : null}

      {!isLoading && schedules.length === 0 ? (
        <EmptyState
          title="No schedules"
          description={'Create one with the CLI: qanxt schedule add --name "Nightly" --cron "0 2 * * *" --timezone Europe/London'}
        />
      ) : null}

      {schedules.map(schedule => (
        <Card key={schedule.id}>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <StatusBadge
              status={schedule.isEnabled ? 'passed' : 'failed'}
              title={schedule.isEnabled ? 'Enabled' : 'Not running'}
            />
            <strong>{schedule.name}</strong>
            {schedule.kind === 'securityScan' ? (
              <StatusBadge status="security scan" title="Starts a security scan, not a test run" />
            ) : null}
            <code className="font-mono text-xs bg-surface-sunken rounded px-1.5 py-0.5">{schedule.cronExpression}</code>
            <span className="text-sm text-ink-muted">{schedule.timeZone}</span>
          </div>

          {/* A schedule the platform turned off is the case worth being loud about: it is
              not running, and nobody chose that. */}
          {!schedule.isEnabled && schedule.disabledReason ? (
            <p className="text-sm text-warn bg-warn-light rounded-lg px-3 py-2 my-2">{schedule.disabledReason}</p>
          ) : null}

          {schedule.isEnabled && schedule.consecutiveFailureCount > 0 ? (
            <p className="text-sm text-warn bg-warn-light rounded-lg px-3 py-2 my-2">
              {schedule.consecutiveFailureCount} run(s) in a row have failed. Three disables it.
            </p>
          ) : null}

          <dl className="kv mt-3">
            <div>
              <dt>Next</dt>
              <dd>{schedule.isEnabled ? (schedule.nextRunAt ?? 'never') : 'not scheduled'}</dd>
            </div>
            <div>
              <dt>Last</dt>
              <dd>
                {/* A security schedule has no run to link to: lastRunId points at a test run,
                    and a security scan is not one. Linking anyway sends the reader to a page
                    for a run that does not exist. */}
                {schedule.lastRunAt && schedule.lastRunId
                  ? <a className="underline" href={`/runs/${schedule.lastRunId}`}>{formatRelative(schedule.lastRunAt)}</a>
                  : schedule.lastRunAt
                    ? formatRelative(schedule.lastRunAt)
                    : 'has not run yet'}
              </dd>
            </div>
            <div>
              <dt>Runs</dt>
              <dd>
                {schedule.kind === 'securityScan' ? 'a security scan of one application' : null}
                {schedule.kind !== 'securityScan' && schedule.includeTags
                  ? `tests tagged ${schedule.includeTags}` : null}
                {schedule.kind !== 'securityScan' && !schedule.includeTags && schedule.testSuiteId
                  ? 'one suite' : null}
                {schedule.kind !== 'securityScan' && !schedule.includeTags && !schedule.testSuiteId
                  ? 'every enabled test' : null}
              </dd>
            </div>
          </dl>

          <div className="flex flex-wrap gap-2 pt-3">
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => setPreviewing(previewing === schedule.id ? null : schedule.id)}
            >
              {previewing === schedule.id ? 'Hide' : 'When does this fire?'}
            </button>

            {mayWrite ? (
              <button
                type="button"
                className={schedule.isEnabled ? 'btn btn-sm btn-danger' : 'btn btn-sm btn-primary'}
                onClick={() => setEnabled.mutate({ id: schedule.id, isEnabled: !schedule.isEnabled })}
                disabled={setEnabled.isPending}
              >
                {schedule.isEnabled ? 'Disable' : 'Enable'}
              </button>
            ) : null}
          </div>

          {/* The cheapest way to find out an expression means something else, before waiting
              a night to be told. */}
          {previewing === schedule.id ? (
            <ul className="mt-3 rounded-lg bg-surface-sunken p-3 text-sm font-mono space-y-1">
              {preview.map(when => <li key={when}>{when}</li>)}
            </ul>
          ) : null}
        </Card>
      ))}
    </div>
  );
}
