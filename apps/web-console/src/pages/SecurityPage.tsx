import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiRequest } from '../api/client';
import { Permissions, useAuth } from '../lib/auth';
import { useProject } from '../lib/project';
import { Card, EmptyState, ErrorNotice, Metric, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { formatRelative } from '../lib/format';
import SecurityScopeEditor, { type SecurityScopeRecord } from './SecurityScopeEditor';

// The editor round-trips the whole record, so the full shape lives with it rather than
// being partially restated here. This used to list only the six fields the read-only view
// displayed, which is why nothing could edit it.
type SecurityScope = SecurityScopeRecord;

interface Finding {
  id: string; reference: string; category: string; title: string;
  severity: string; confidence: string; status: string;
  cwe?: string | null; owaspWebCategory?: string | null;
  endpoint?: string | null; parameter?: string | null; observedAsRole?: string | null;
  firstSeenAt: string; lastSeenAt: string;
  isNew: boolean; isRegression: boolean; dispositionNote?: string | null;
}

interface GateRule { name: string; passed: boolean; measured: boolean; explanation: string }
interface Gate { outcome: string; summary: string; blocked: boolean; rules: GateRule[]; reasons: string[] }

interface Scan {
  id: string; reference: string; profile: string; status: string;
  requestsIssued: number; requestsBlocked: number;
  testsExecuted: number; testsSkipped: number;
  startedAt: string; findings: Finding[]; gate: Gate;
  errorMessage?: string | null;
}

interface TrendPoint {
  scanId: string; reference: string; at: string; profile: string;
  critical: number; high: number; medium: number; low: number; informational: number;
  newFindings: number; regressions: number;
  checksConfigured: number; checksExecuted: number;
  requestsIssued: number; requestsBlocked: number;
  comparableToPrevious: boolean; notComparableBecause?: string | null;
}

interface Trend {
  applicationId: string; points: TrendPoint[];
  openNow: number; openCritical: number; openHigh: number;
  medianDaysToResolution?: number | null; resolvedCount: number;
  summary: string;
}

interface AppSummary { id: string; name: string; baseUrl?: string }

interface SurfaceItem {
  kind: string; id: string; identifier: string; httpMethod?: string | null;
  requiresAuthentication: boolean; changesState: boolean; acceptsInput: boolean;
  acceptsFileUpload: boolean; carriesObjectIdentifier: boolean; carriesUrlParameter: boolean;
  parameters: string[]; relevantChecks: string[]; why: string;
}

interface Surface {
  applicationId: string; items: SurfaceItem[];
  pagesInGraph: number; endpointsInGraph: number; graphLastSeenAt?: string | null;
  caveats: string[]; checksImplied: string[]; summary: string;
}

interface StartedScan {
  securityScanId: string; reference: string; queue: string; jobId: string;
  targets: number; checksToRun: number; checksConfigured: number; summary: string;
}

/**
 * Security findings, and the coverage that decides what they mean.
 *
 * Two decisions shape this page, and both are about what it refuses to show.
 *
 * It never renders an empty findings list as a clean result. An application nobody has
 * scanned and an application scanned thoroughly with nothing found produce the same empty
 * table, and a screen that draws them the same way is the single most misleading thing a
 * security tool can put in front of somebody. The empty state says which of the two it is.
 *
 * The trend breaks its line where the scans are not comparable, rather than sloping down.
 * Narrowing a scope makes findings fall, and a chart that rewards that is worse than no
 * chart. Each point carries the coverage it was measured at, and the ones the API flagged as
 * incomparable are drawn hollow with the reason beside them.
 */
export default function SecurityPage() {
  const { can } = useAuth();
  const { projectId } = useProject();
  const queryClient = useQueryClient();
  const [applicationId, setApplicationId] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [triaging, setTriaging] = useState<Finding | null>(null);

  const [started, setStarted] = useState<StartedScan | null>(null);
  const [editingScope, setEditingScope] = useState(false);

  const mayRead = can(Permissions.securityRead);
  const mayTriage = can(Permissions.securityTriage);
  const mayScan = can(Permissions.securityScan);
  const mayAuthorize = can(Permissions.securityAuthorize);

  const { data: applications = [] } = useQuery({
    queryKey: ['applications', projectId],
    queryFn: () => apiRequest<AppSummary[]>(
      `/api/v1/applications${projectId ? `?projectId=${projectId}` : ''}`),
    enabled: mayRead
  });

  const selected = applicationId || applications[0]?.id || '';

  const scopeQuery = useQuery({
    queryKey: ['security-scope', selected],
    queryFn: () => apiRequest<SecurityScope>(`/api/v1/security/applications/${selected}/scope`),
    enabled: mayRead && Boolean(selected),
    retry: false
  });

  const trendQuery = useQuery({
    queryKey: ['security-trend', selected],
    queryFn: () => apiRequest<Trend>(`/api/v1/security/applications/${selected}/trend`),
    enabled: mayRead && Boolean(selected)
  });

  const surfaceQuery = useQuery({
    queryKey: ['security-surface', selected],
    queryFn: () => apiRequest<Surface>(`/api/v1/security/applications/${selected}/surface`),
    enabled: mayRead && Boolean(selected)
  });

  const scansQuery = useQuery({
    queryKey: ['security-scans', selected],
    queryFn: () => apiRequest<Scan[]>(`/api/v1/security/scans?applicationId=${selected}&take=10`),
    enabled: mayRead && Boolean(selected)
  });

  const findingsQuery = useQuery({
    queryKey: ['security-findings', selected, statusFilter],
    queryFn: () => {
      const query = new URLSearchParams({ applicationId: selected });
      if (statusFilter) query.set('status', statusFilter);
      return apiRequest<Finding[]>(`/api/v1/security/findings?${query}`);
    },
    enabled: mayRead && Boolean(selected)
  });

  /**
   * Asking QA NXT to scan this application.
   *
   * The refusals are the useful part of this control, so they are shown as the API worded them
   * rather than as "something went wrong": "nobody has authorized this", "discovery has not
   * walked it" and "you do not hold security:scan:destructive" each tell somebody what to do
   * next, and a generic failure tells them to ask an engineer.
   */
  const startScan = useMutation({
    mutationFn: () => apiRequest<StartedScan>('/api/v1/security/scans/start', {
      method: 'POST', body: { applicationId: selected }
    }),
    onSuccess: scan => {
      setStarted(scan);
      queryClient.invalidateQueries({ queryKey: ['security-scans'] });
    }
  });

  // The queued scan, watched until a worker reports it. Polling stops the moment it is no
  // longer queued, and the interval is generous: a security scan is not a progress bar.
  const queuedScan = useQuery({
    queryKey: ['security-scan', started?.securityScanId],
    queryFn: () => apiRequest<Scan>(`/api/v1/security/scans/${started!.securityScanId}`),
    enabled: Boolean(started?.securityScanId),
    refetchInterval: query =>
      (query.state.data as Scan | undefined)?.status === 'queued' ? 4000 : false
  });

  const queuedStatus = queuedScan.data?.status;

  useEffect(() => {
    if (!queuedStatus || queuedStatus === 'queued') return;
    // It has reported. Everything on this page is now out of date.
    queryClient.invalidateQueries({ queryKey: ['security-scans'] });
    queryClient.invalidateQueries({ queryKey: ['security-findings'] });
    queryClient.invalidateQueries({ queryKey: ['security-trend'] });
  }, [queuedStatus, queryClient]);

  // Selecting a different application drops the watch: the scan belongs to the old one, and
  // leaving its banner up would attach a result to an application it says nothing about.
  useEffect(() => {
    setStarted(null);
    startScan.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const triage = useMutation({
    mutationFn: ({ id, status, justification }: { id: string; status: string; justification: string }) =>
      apiRequest<Finding>(`/api/v1/security/findings/${id}/triage`, {
        method: 'POST', body: { status, justification }
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['security-findings'] });
      queryClient.invalidateQueries({ queryKey: ['security-trend'] });
      setTriaging(null);
    }
  });

  const latestScan = scansQuery.data?.[0];
  const trend = trendQuery.data;

  const maxSeverityTotal = useMemo(() => Math.max(
    1, ...(trend?.points ?? []).map(p => p.critical + p.high + p.medium + p.low)), [trend]);

  if (!mayRead) {
    return (
      <>
        <PageHeader title="Security" />
        <EmptyState
          title="You do not have access to security findings"
          description={
            'A security finding is a working description of how to break the application, so it '
            + 'needs the security:read permission rather than the read access that covers test '
            + 'results. A QA lead or an administrator can grant it.'
          }
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Security"
        description="Findings, the coverage behind them, and what has not been tested."
        actions={
          <select
            className="input w-auto"
            value={selected}
            onChange={event => setApplicationId(event.target.value)}
            aria-label="Application"
            data-testid="security-application"
          >
            {applications.map(app => <option key={app.id} value={app.id}>{app.name}</option>)}
          </select>
        }
      />

      {!selected && (
        <EmptyState
          title="No applications"
          description="Register an application before it can be security tested."
        />
      )}

      {selected && (
        <>
          {/* ---- Authorization, first, because nothing else matters without it ---- */}
          <Card
            title="Authorization"
            description="Nothing can be security tested without a written authorization against this application."
            actions={mayAuthorize ? (
              <button
                type="button"
                className={scopeQuery.data ? 'btn-secondary btn-sm' : 'btn-primary btn-sm'}
                onClick={() => setEditingScope(open => !open)}
                data-testid="scope-edit"
              >
                {editingScope
                  ? 'Close'
                  : scopeQuery.data ? 'Edit authorization' : 'Authorize this application'}
              </button>
            ) : undefined}
          >
            {scopeQuery.isLoading && <Spinner label="Loading the scope" />}
            {scopeQuery.isError && (
              <EmptyState
                title="This application has not been authorized for security testing"
                description={
                  'There is no security scope. That is not a configuration gap to fill in casually: '
                  + 'a scope records that a named person authorized testing of this application, and '
                  + 'until somebody writes one, nothing here can be scanned.'
                  + (mayAuthorize
                    ? ' Use "Authorize this application" to write one.'
                    : ' Writing one needs the security:authorize permission, which this account'
                      + ' does not have. A project administrator can do it.')
                }
              />
            )}
            {scopeQuery.data && (
              <dl className="grid gap-3 sm:grid-cols-2 [&_dt]:text-xs [&_dt]:font-semibold [&_dt]:uppercase [&_dt]:tracking-wide [&_dt]:text-ink-subtle [&_dd]:text-sm [&_dd]:text-ink [&_dd]:mb-2" data-testid="security-scope">
                <dt>Status</dt>
                <dd><StatusBadge status={scopeQuery.data.enabled ? 'enabled' : 'disabled'} /></dd>
                <dt>Authorization</dt>
                <dd>{scopeQuery.data.authorizationNote ?? <span className="text-ink-muted">none</span>}</dd>
                <dt>Authorized</dt>
                <dd>
                  {scopeQuery.data.authorizedAt
                    ? formatRelative(scopeQuery.data.authorizedAt)
                    : <span className="text-ink-muted">never</span>}
                </dd>
                <dt>Hosts</dt>
                <dd>{scopeQuery.data.allowedDomains
                  || <span className="text-ink-muted">none — an empty allowlist permits nothing</span>}</dd>
                <dt>Active testing</dt>
                <dd>{scopeQuery.data.allowActiveTesting ? 'permitted' : 'not permitted'}</dd>
                <dt>Destructive</dt>
                <dd>{scopeQuery.data.allowDestructiveTesting
                  ? <StatusBadge status="permitted" /> : 'not permitted'}</dd>
                <dt>Production</dt>
                <dd>{scopeQuery.data.allowProduction
                  ? <StatusBadge status="permitted" /> : 'not permitted'}</dd>
              </dl>
            )}
          </Card>

          {mayAuthorize && (
            <SecurityScopeEditor
              applicationId={selected}
              applicationName={applications.find(a => a.id === selected)?.name ?? 'this application'}
              // Offered as a starting point, not applied silently: the host the application
              // already points at is almost always the one being authorized, and making the
              // user retype it invites a typo that would quietly permit nothing.
              suggestedHost={hostOf(applications.find(a => a.id === selected)?.baseUrl)}
              existing={scopeQuery.data ?? null}
              open={editingScope}
              onClose={() => setEditingScope(false)}
            />
          )}

          {/* ---- Running one ------------------------------------------------- */}
          {mayScan && (
            <Card
              title="Run a scan"
              description="QA NXT queues the scan, a worker issues the requests, and the result appears here when it reports."
              actions={
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => startScan.mutate()}
                  disabled={startScan.isPending || queuedStatus === 'queued'}
                  data-testid="security-start-scan"
                >
                  {startScan.isPending ? 'Queueing…' : 'Scan this application'}
                </button>
              }
            >
              {startScan.isError && (
                <p className="text-sm text-bad" data-testid="security-start-refused">
                  {startScan.error instanceof ApiError
                    ? startScan.error.displayMessage
                    : 'The scan could not be started.'}
                </p>
              )}

              {started && !startScan.isError && (
                <div data-testid="security-started">
                  <p className="text-sm text-ink">{started.summary}</p>

                  {queuedStatus === 'abandoned' ? (
                    // The platform gave up on it. Not a result either, and the reason belongs on
                    // the screen rather than only in a log somebody would have to go and find.
                    <p className="mt-2 text-sm text-bad" data-testid="security-abandoned">
                      <StatusBadge status="abandoned" />{' '}
                      {queuedScan.data?.errorMessage
                        ?? 'No worker reported this scan, so the platform stopped waiting for it.'}
                    </p>
                  ) : queuedStatus === 'queued' || !queuedStatus ? (
                    // The whole point of this branch. A queued scan has issued no requests, and
                    // a screen that showed it beside a green tick would be reporting a build as
                    // tested at the moment nothing had been tested.
                    <p className="mt-2 text-sm text-ink-muted" data-testid="security-queued-note">
                      <StatusBadge status="queued" />{' '}
                      {started.reference} has not run yet. Nothing about this application&rsquo;s
                      security has been established by queueing it, and nothing here should be read
                      as a result until a worker reports.
                    </p>
                  ) : (
                    <p className="mt-2 text-sm text-ink" data-testid="security-reported">
                      <StatusBadge status={queuedScan.data?.gate.outcome ?? queuedStatus} />{' '}
                      {queuedScan.data?.gate.summary}
                    </p>
                  )}
                </div>
              )}

              {!started && !startScan.isError && (
                <p className="text-sm text-ink-muted">
                  A scan needs an enabled scope carrying a written authorization, and a surface for
                  discovery to have walked. Either one missing is a refusal with the reason, not a
                  scan that runs and finds nothing.
                </p>
              )}
            </Card>
          )}

          {/* ---- Where things stand ------------------------------------------ */}
          <div className="grid gap-3 sm:grid-cols-4 my-4">
            <Metric label="Open findings" value={trend?.openNow ?? '—'}
                    tone={(trend?.openNow ?? 0) > 0 ? 'warn' : 'neutral'} />
            <Metric label="Critical" value={trend?.openCritical ?? '—'}
                    tone={(trend?.openCritical ?? 0) > 0 ? 'bad' : 'neutral'} />
            <Metric label="High" value={trend?.openHigh ?? '—'}
                    tone={(trend?.openHigh ?? 0) > 0 ? 'bad' : 'neutral'} />
            <Metric
              label="Median days to resolution"
              value={trend?.medianDaysToResolution?.toFixed(1) ?? '—'}
              hint={trend?.medianDaysToResolution == null
                ? `${trend?.resolvedCount ?? 0} resolved — too few for a median that would mean anything`
                : `over ${trend?.resolvedCount} resolved finding(s)`}
            />
          </div>

          {/* The sentence that must never be replaced by a green tick. */}
          {trend && (
            <p className="text-sm text-ink-muted mb-4" data-testid="security-summary">{trend.summary}</p>
          )}

          {/* ---- The gate on the most recent scan ---------------------------- */}
          {latestScan && (
            <Card
              title={`Latest scan — ${latestScan.reference}`}
              description={`${latestScan.profile} profile, ${formatRelative(latestScan.startedAt)}`}
            >
              <p>
                <StatusBadge status={latestScan.gate.outcome} />{' '}
                <span data-testid="security-gate-summary">{latestScan.gate.summary}</span>
              </p>
              <ul className="space-y-2 mt-3">
                {latestScan.gate.rules.map(rule => (
                  <li key={rule.name} className="flex flex-wrap items-baseline gap-2">
                    <StatusBadge status={!rule.measured ? 'not measured' : rule.passed ? 'passed' : 'failed'} />
                    <span className="text-sm text-ink">{rule.name}</span>
                    <span className="w-full text-xs text-ink-muted">{rule.explanation}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* ---- The trend, with its line broken where it has to be ---------- */}
          <Card
            title="Trend"
            description="Each point carries the coverage it was measured at. A point the API flagged as not comparable is drawn hollow: narrowing a scan makes findings fall, and a line that slopes down for that reason is worse than no line."
          >
            {trendQuery.isLoading && <Spinner label="Loading the trend" />}
            {(trend?.points.length ?? 0) === 0 && !trendQuery.isLoading && (
              <EmptyState
                title="Nothing has been scanned"
                description="This is not a clean result. No security scan has been recorded for this application, so nothing is known about it from QA NXT."
              />
            )}
            {(trend?.points.length ?? 0) > 0 && (
              <ol
                className="flex items-end gap-3 overflow-x-auto h-48 pt-2"
                data-testid="security-trend"
              >
                {trend!.points.map(point => {
                  const total = point.critical + point.high + point.medium + point.low;
                  const height = Math.round((total / maxSeverityTotal) * 100);
                  return (
                    <li
                      key={point.scanId}
                      className="flex h-full min-w-[5.5rem] flex-col justify-end gap-1"
                      title={point.notComparableBecause ?? point.reference}
                    >
                      <div
                        // Hollow rather than filled where the scan is not comparable to the one
                        // before it. The eye reads a solid falling bar as progress, and this is
                        // exactly the case where it would not be.
                        className={
                          point.comparableToPrevious
                            ? 'w-full rounded-t bg-brand'
                            : 'w-full rounded-t border-2 border-dashed border-warn bg-transparent'
                        }
                        style={{ height: `${Math.max(height, 3)}%` }}
                        aria-hidden
                      />
                      <strong className="text-sm text-ink">{total}</strong>
                      <span className="text-xs text-ink-muted">
                        {point.checksExecuted}/{point.checksConfigured} checks
                      </span>
                      <span className="text-xs text-ink-subtle">{formatRelative(point.at)}</span>
                      {!point.comparableToPrevious && (
                        <span className="text-xs font-semibold text-warn">not comparable</span>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>

          {/* ---- What is being tested, and what is not ------------------------ */}
          <Card
            title="Attack surface"
            description="What discovery walked, what each part of it implies, and — first — what this does not cover."
          >
            {surfaceQuery.isLoading && <Spinner label="Loading the surface" />}
            {surfaceQuery.data && (
              <>
                <p className="text-sm text-ink" data-testid="security-surface-summary">
                  {surfaceQuery.data.summary}
                </p>

                {/* The caveats come before the list, deliberately. A reader who takes the
                    items as complete will treat everywhere else as safe, and nothing here
                    has looked at anywhere else. */}
                {surfaceQuery.data.caveats.length > 0 && (
                  <ul className="mt-3 space-y-1" data-testid="security-surface-caveats">
                    {surfaceQuery.data.caveats.map(caveat => (
                      <li key={caveat} className="text-sm text-warn flex gap-2">
                        <span aria-hidden>•</span><span>{caveat}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {surfaceQuery.data.items.length > 0 && (
                  <table className="table mt-4" data-testid="security-surface">
                    <thead>
                      <tr>
                        <th>Where</th>
                        <th>Why it is here</th>
                        <th>Checks it implies</th>
                      </tr>
                    </thead>
                    <tbody>
                      {surfaceQuery.data.items.map(item => (
                        <tr key={item.id}>
                          <td>
                            <code className="font-mono text-xs">
                              {item.httpMethod ? `${item.httpMethod} ` : ''}{item.identifier}
                            </code>
                            {item.requiresAuthentication ? (
                              <span className="block text-xs text-ink-muted">needs a session</span>
                            ) : null}
                          </td>
                          {/* Stated so a reader can disagree with it. A surface nobody can
                              argue with is one nobody checks. */}
                          <td className="text-sm text-ink-muted">{item.why}</td>
                          <td className="text-xs font-mono text-ink-muted">
                            {item.relevantChecks.join(', ')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </Card>

          {/* ---- Findings ---------------------------------------------------- */}
          <Card
            title="Findings"
            actions={
              <select
                className="input w-auto"
                value={statusFilter}
                onChange={event => setStatusFilter(event.target.value)}
                aria-label="Status"
              >
                <option value="">Every status</option>
                <option value="potential">Potential</option>
                <option value="confirmed">Confirmed</option>
                <option value="needsReview">Needs review</option>
                <option value="regressed">Regressed</option>
                <option value="falsePositive">False positive</option>
                <option value="accepted">Accepted</option>
                <option value="resolved">Resolved</option>
              </select>
            }
          >
            {findingsQuery.isLoading && <Spinner label="Loading findings" />}
            {findingsQuery.isError && <ErrorNotice error={findingsQuery.error} />}
            {findingsQuery.data?.length === 0 && (
              <EmptyState
                title={statusFilter ? 'No findings with that status' : 'No stored findings'}
                description={
                  (trend?.points.length ?? 0) === 0
                    ? 'Nothing has been scanned, so this says nothing about the application.'
                    : 'Within the scope and coverage of the scans recorded here, no findings are '
                      + 'stored. This is not a statement that the application is secure, and areas '
                      + 'those scans did not reach are untested rather than clean.'
                }
              />
            )}
            {(findingsQuery.data?.length ?? 0) > 0 && (
              <div className="table-wrap mt-3">
              <table className="table" data-testid="security-findings">
                <thead>
                  <tr>
                    <th>Severity</th><th>Finding</th><th>Where</th>
                    <th>Status</th><th>Last seen</th><th />
                  </tr>
                </thead>
                <tbody>
                  {findingsQuery.data!.map(finding => (
                    <tr key={finding.id}>
                      <td>
                        <StatusBadge status={finding.severity}
                                     title={`${finding.confidence} confidence`} />
                      </td>
                      <td>
                        <strong>{finding.category}</strong>
                        {finding.cwe && <span className="text-xs text-ink-muted"> {finding.cwe}</span>}
                        {finding.isRegression && <> <StatusBadge status="regression" /></>}
                        <div className="text-xs text-ink-muted">{finding.title}</div>
                      </td>
                      <td className="text-xs text-ink-muted">
                        {finding.endpoint}
                        {finding.parameter && <> · {finding.parameter}</>}
                        {finding.observedAsRole && <> · as {finding.observedAsRole}</>}
                      </td>
                      <td>
                        <StatusBadge status={finding.status} />
                        {finding.dispositionNote && (
                          <div className="text-xs text-ink-muted">{finding.dispositionNote}</div>
                        )}
                      </td>
                      <td className="text-xs text-ink-muted">{formatRelative(finding.lastSeenAt)}</td>
                      <td>
                        {mayTriage && (
                          <button
                            type="button"
                            className="btn btn-sm btn-secondary"
                            onClick={() => setTriaging(finding)}
                          >
                            Triage
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </Card>

          {triaging && (
            <TriageDialog
              finding={triaging}
              pending={triage.isPending}
              error={triage.error}
              onCancel={() => setTriaging(null)}
              onSubmit={(status, justification) =>
                triage.mutate({ id: triaging.id, status, justification })}
            />
          )}
        </>
      )}
    </>
  );
}

/**
 * Setting a finding aside.
 *
 * The justification is required in the form as well as by the API, and the button stays
 * disabled until it says something. An operator should find out that a suppression needs a
 * reason while they are writing it, not from a rejected request — and the sentence under the
 * field explains why rather than just demanding it.
 */
function TriageDialog({ finding, pending, error, onCancel, onSubmit }: {
  finding: Finding;
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (status: string, justification: string) => void;
}) {
  const [status, setStatus] = useState('falsePositive');
  const [justification, setJustification] = useState('');

  const needsAReason = ['falsePositive', 'accepted', 'resolved'].includes(status);
  const ready = !needsAReason || justification.trim().length >= 20;

  return (
    <Card title={`Triage ${finding.reference}`} description={finding.title}>
      <form
        onSubmit={event => { event.preventDefault(); onSubmit(status, justification); }}
        data-testid="security-triage"
        className="space-y-3"
      >
        <label className="label" htmlFor="triage-status">Status</label>
        <select
          id="triage-status"
          className="input w-auto"
          value={status}
          onChange={e => setStatus(e.target.value)}
        >
          <option value="confirmed">Confirmed</option>
          <option value="needsReview">Needs review</option>
          <option value="falsePositive">False positive</option>
          <option value="accepted">Accepted risk</option>
          <option value="resolved">Resolved</option>
        </select>

        <label className="label" htmlFor="triage-reason">Justification</label>
        <textarea
          id="triage-reason"
          className="input"
          value={justification}
          onChange={e => setJustification(e.target.value)}
          rows={4}
          placeholder="What did you check, and what did it show?"
        />
        {needsAReason && (
          <p className="text-xs text-ink-muted">
            Required. A suppression with no stated reason is indistinguishable from turning the
            check off, and the security gate counts it as open either way. Your name is recorded
            against this decision.
          </p>
        )}

        {error ? <ErrorNotice error={error} /> : null}

        <div className="flex gap-2">
          <button type="submit" className="btn btn-primary" disabled={!ready || pending}>
            {pending ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </Card>
  );
}

/**
 * The host of an application's base URL, for the scope's starting allowlist.
 *
 * Returns an empty string rather than guessing when the URL will not parse: an allowlist
 * that silently contains something wrong is worse than one the user has to fill in, because
 * the guard would refuse every request and the reason would look like a product fault.
 */
function hostOf(baseUrl: string | undefined): string {
  if (!baseUrl) return '';
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return '';
  }
}
