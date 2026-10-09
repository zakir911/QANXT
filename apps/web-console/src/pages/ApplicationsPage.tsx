import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../api/client';
import { Permissions, useAuth } from '../lib/auth';
import { useProject } from '../lib/project';
import { Card, EmptyState, ErrorNotice, PageHeader, Spinner, StatusBadge, useDisclosedPanel } from '../components/ui';
import { formatRelative, humanize } from '../lib/format';

interface ApplicationSummary {
  id: string; projectId: string; name: string; baseUrl: string; description: string;
  authStrategy: string; hasCredentials: boolean;
  pageCount: number; elementCount: number; apiEndpointCount: number; journeyCount: number;
  lastDiscoveredAt?: string; lastDiscoveryStatus?: string;
  respectRobotsTxt: boolean; createdAt: string;
}

// The same words the Strategy dropdown uses. The card printed the wire value, so an
// application registered through the form's own "Form login" option came back reading
// "Authentication: formLogin" — the one piece of camelCase on a card that is otherwise
// prose. Unknown values fall through to humanize rather than being hidden, so a strategy
// added to the API but not to this map still reads as something.
const AUTH_STRATEGY_LABELS: Record<string, string> = {
  none: 'none',
  formLogin: 'Form login',
  bearerToken: 'Bearer token',
  basicAuth: 'HTTP basic'
};

export default function ApplicationsPage() {
  const { can } = useAuth();
  const { projectId, project } = useProject();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const panel = useDisclosedPanel('add-application', adding);
  const [error, setError] = useState<unknown>(null);

  const { data: applications = [], isLoading, refetch } = useQuery({
    queryKey: ['applications', projectId],
    queryFn: () => apiRequest<ApplicationSummary[]>(
      `/api/v1/applications${projectId ? `?projectId=${projectId}` : ''}`)
  });

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest('/api/v1/applications', { method: 'POST', body }),
    onSuccess: async () => {
      setAdding(false);
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['applications'] });
    },
    onError: setError
  });

  const setRobots = useMutation({
    mutationFn: ({ applicationId, respectRobotsTxt }: { applicationId: string; respectRobotsTxt: boolean }) =>
      apiRequest(`/api/v1/applications/${applicationId}`, {
        method: 'PATCH', body: { respectRobotsTxt }
      }),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['applications'] });
    },
    onError: setError
  });

  const startDiscovery = useMutation({
    mutationFn: (applicationId: string) =>
      apiRequest('/api/v1/discovery/runs', { method: 'POST', body: { applicationId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['discovery-runs'] });
      await refetch();
    },
    onError: setError
  });

  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const username = String(form.get('username') ?? '');
    const password = String(form.get('password') ?? '');
    const authStrategy = String(form.get('authStrategy') ?? 'none');

    create.mutate({
      projectId,
      name: String(form.get('name') ?? ''),
      baseUrl: String(form.get('baseUrl') ?? ''),
      description: String(form.get('description') ?? ''),
      allowedDomains: String(form.get('allowedDomains') ?? ''),
      excludedPaths: String(form.get('excludedPaths') ?? '/logout,/signout,/delete'),
      maxCrawlDepth: Number(form.get('maxCrawlDepth') ?? 3),
      maxPages: Number(form.get('maxPages') ?? 50),
      // An unchecked checkbox sends nothing, so the absence is the "off" — reading it as
      // a missing field would leave the default on and silently ignore the choice.
      respectRobotsTxt: form.get('respectRobotsTxt') !== null,
      authStrategy,
      loginUrl: String(form.get('loginUrl') ?? '') || null,
      loginFlowJson: form.get('successUrlContains')
        ? JSON.stringify({ successUrlContains: String(form.get('successUrlContains')) })
        : null,
      // Credentials are write-only: they are encrypted on arrival and never returned.
      credentials: authStrategy === 'formLogin' && (username || password)
        ? { username, password, bearerToken: null, storageStateJson: null }
        : null
    });
  };

  if (!projectId) {
    return (
      <Card>
        <EmptyState
          title="Select a project"
          description="Applications belong to a project. Choose one from the header, or create a project first."
          action={<Link to="/projects" className="btn-primary">Go to projects</Link>}
        />
      </Card>
    );
  }

  if (isLoading) return <Spinner label="Loading applications" />;

  return (
    <>
      <PageHeader
        title="Applications"
        description={`Applications under test in ${project?.name ?? 'this project'}.`}
        actions={can(Permissions.applicationWrite) && !adding && (
          <button type="button" className="btn-primary" onClick={() => setAdding(true)} {...panel.triggerProps}>Add application</button>
        )}
      />

      {adding && (
        <Card title="Add an application" {...panel.panelProps}
              description="Discovery will stay inside the allowed domains and budgets you set here."
              className="mb-4">
          <form onSubmit={handleCreate} className="grid gap-3.5 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="app-name">Name</label>
              <input id="app-name" name="name" required className="input" placeholder="Demo Bank" />
            </div>
            <div>
              <label className="label" htmlFor="baseUrl">Base URL</label>
              <input id="baseUrl" name="baseUrl" type="url" required className="input"
                     placeholder="http://localhost:4200/dashboard" />
              <p className="mt-1 text-xs text-ink-muted">Where discovery starts once signed in.</p>
            </div>
            <div className="sm:col-span-2">
              <label className="label" htmlFor="description">Description</label>
              <input id="description" name="description" className="input" />
            </div>
            <div>
              <label className="label" htmlFor="allowedDomains">Additional allowed domains</label>
              <input id="allowedDomains" name="allowedDomains" className="input" placeholder="cdn.example.com" />
              <p className="mt-1 text-xs text-ink-muted">Comma-separated. The base URL's host is always allowed.</p>
            </div>
            <div>
              <label className="label" htmlFor="excludedPaths">Excluded paths</label>
              <input id="excludedPaths" name="excludedPaths" className="input"
                     defaultValue="/logout,/signout,/delete" />
              <p className="mt-1 text-xs text-ink-muted">Paths the crawler must never open.</p>
            </div>
            <div>
              <label className="label" htmlFor="maxCrawlDepth">Crawl depth</label>
              <input id="maxCrawlDepth" name="maxCrawlDepth" type="number" min={1} max={10}
                     defaultValue={3} className="input" />
            </div>
            <div>
              <label className="label" htmlFor="maxPages">Page budget</label>
              <input id="maxPages" name="maxPages" type="number" min={1} max={1000}
                     defaultValue={50} className="input" />
            </div>
            <div className="sm:col-span-2">
              <label className="flex items-center gap-2 text-sm text-ink" htmlFor="respectRobotsTxt">
                <input id="respectRobotsTxt" name="respectRobotsTxt" type="checkbox" defaultChecked />
                Respect robots.txt
              </label>
              <p className="mt-1 text-xs text-ink-muted">
                Discovery reads the site's robots.txt and will not open a path it disallows. If the
                file cannot be read at all, nothing is explored, because rules nobody can see are
                not permission. Turn this off only for an application you are responsible for.
              </p>
            </div>

            <fieldset className="sm:col-span-2 grid gap-3.5 sm:grid-cols-2 border-t border-line pt-3.5">
              <legend className="label">Authentication</legend>
              <div>
                <label className="label" htmlFor="authStrategy">Strategy</label>
                <select id="authStrategy" name="authStrategy" className="input" defaultValue="formLogin">
                  <option value="none">None — the application needs no sign-in</option>
                  <option value="formLogin">Form login</option>
                  <option value="bearerToken">Bearer token</option>
                  <option value="basicAuth">HTTP basic</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="loginUrl">Login URL</label>
                <input id="loginUrl" name="loginUrl" type="url" className="input"
                       placeholder="http://localhost:4200/login" />
              </div>
              <div>
                <label className="label" htmlFor="username">Username</label>
                <input id="username" name="username" className="input" autoComplete="off" />
              </div>
              <div>
                <label className="label" htmlFor="password">Password</label>
                <input id="password" name="password" type="password" className="input" autoComplete="off" />
                <p className="mt-1 text-xs text-ink-muted">
                  Encrypted with AES-256-GCM on arrival. Never returned by the API, never written to evidence.
                </p>
              </div>
              <div className="sm:col-span-2">
                <label className="label" htmlFor="successUrlContains">Post-login URL contains</label>
                <input id="successUrlContains" name="successUrlContains" className="input" placeholder="/dashboard" />
                <p className="mt-1 text-xs text-ink-muted">
                  How the platform confirms sign-in worked instead of mapping the login page repeatedly.
                </p>
              </div>
            </fieldset>

            {error !== null && <div className="sm:col-span-2"><ErrorNotice error={error} /></div>}

            <div className="sm:col-span-2 flex gap-2">
              <button type="submit" className="btn-primary" disabled={create.isPending}>
                {create.isPending ? 'Adding…' : 'Add application'}
              </button>
              <button type="button" className="btn-secondary" onClick={() => { setAdding(false); setError(null); }}>
                Cancel
              </button>
            </div>
          </form>
        </Card>
      )}

      {applications.length === 0 && !adding ? (
        <Card>
          <EmptyState
            title="No applications yet"
            description="Add the web application you want to test. The platform will explore it, build a model of its pages and elements, and generate tests from that model."
            action={can(Permissions.applicationWrite) && (
              <button type="button" className="btn-primary" onClick={() => setAdding(true)} {...panel.triggerProps}>Add an application</button>
            )}
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {applications.map(application => (
            <Card
              key={application.id}
              title={application.name}
              description={application.baseUrl}
              actions={application.lastDiscoveryStatus
                ? <StatusBadge status={application.lastDiscoveryStatus} />
                : <span className="badge bg-surface-sunken text-ink-muted">Not yet discovered</span>}
            >
              <dl className="grid grid-cols-4 gap-3 mb-4">
                <div className="kv"><dt>Pages</dt><dd className="font-semibold">{application.pageCount}</dd></div>
                <div className="kv"><dt>Elements</dt><dd className="font-semibold">{application.elementCount}</dd></div>
                <div className="kv"><dt>API calls</dt><dd className="font-semibold">{application.apiEndpointCount}</dd></div>
                <div className="kv"><dt>Journeys</dt><dd className="font-semibold">{application.journeyCount}</dd></div>
              </dl>

              <p className="text-xs text-ink-muted mb-3">
                Authentication: {AUTH_STRATEGY_LABELS[application.authStrategy] ?? humanize(application.authStrategy)}
                {application.hasCredentials && ' · credentials configured'}
                {application.lastDiscoveredAt && ` · last explored ${formatRelative(application.lastDiscoveredAt)}`}
              </p>

              {/* The off state is the one worth noticing without reading, because it is the
                  one where a crawl ignores what the site asked for. On is the default and
                  stays as quiet prose. */}
              <p className="text-xs mb-3">
                {application.respectRobotsTxt ? (
                  <span className="text-ink-muted">Crawl boundary: robots.txt is respected.</span>
                ) : (
                  <span className="badge bg-warn-light text-warn">robots.txt is ignored</span>
                )}
              </p>

              <div className="flex flex-wrap items-center gap-2">
                {can(Permissions.discoveryRun) && (
                  <button
                    type="button"
                    className="btn-primary btn-sm"
                    disabled={startDiscovery.isPending}
                    onClick={() => startDiscovery.mutate(application.id)}
                  >
                    {startDiscovery.isPending ? 'Starting…' : 'Run discovery'}
                  </button>
                )}
                {application.pageCount > 0 && (
                  <Link to={`/applications/${application.id}/graph`} className="btn-secondary btn-sm">
                    View application map
                  </Link>
                )}
                {can(Permissions.applicationWrite) && (
                  <label className="flex items-center gap-2 text-xs text-ink ml-auto">
                    <input
                      type="checkbox"
                      checked={application.respectRobotsTxt}
                      // Scoped to the card being saved. A single isPending would disable
                      // every application's checkbox while one of them is in flight.
                      disabled={setRobots.isPending && setRobots.variables?.applicationId === application.id}
                      onChange={event => {
                        const respectRobotsTxt = event.target.checked;
                        // Only the off direction is confirmed. Turning it back on restores
                        // the default and needs no ceremony; turning it off from a list card
                        // is a decision about somebody else's site and is too easy to click.
                        if (!respectRobotsTxt && !confirm(
                          `Ignore robots.txt when exploring ${application.name}? `
                          + 'Discovery will open paths the site asked crawlers to leave alone. '
                          + 'This is recorded in the audit log.')) return;
                        setRobots.mutate({ applicationId: application.id, respectRobotsTxt });
                      }}
                    />
                    Respect robots.txt
                  </label>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
