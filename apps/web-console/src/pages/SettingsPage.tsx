import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../api/client';
import { useAuth } from '../lib/auth';
import { Card, PageHeader, Spinner } from '../components/ui';
import { humanize } from '../lib/format';

interface PermissionCatalogue {
  permissions: { name: string; category: string; description: string }[];
  roles: { role: string; description: string; permissions: string[] }[];
}

interface ProviderStatus {
  kind: string; name: string; isConfigured: boolean; defaultModel: string; notes: string;
}

export default function SettingsPage() {
  const { user } = useAuth();

  const { data: catalogue, isLoading } = useQuery({
    queryKey: ['permissions'],
    queryFn: () => apiRequest<PermissionCatalogue>('/api/v1/meta/permissions', { authenticated: false }),
    staleTime: Infinity
  });

  const { data: providers = [] } = useQuery({
    queryKey: ['ai-providers'],
    queryFn: () => apiRequest<ProviderStatus[]>('/api/v1/ai/providers'),
    staleTime: 300_000
  });

  const myPermissions = new Set(user?.permissions ?? []);

  return (
    <>
      <PageHeader title="Settings" description="Your access, and how this deployment is configured." />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Your account">
          <dl className="space-y-2.5">
            <div className="kv"><dt>Name</dt><dd>{user?.displayName}</dd></div>
            <div className="kv"><dt>Email</dt><dd>{user?.email}</dd></div>
            <div className="kv">
              <dt>Roles</dt>
              <dd className="flex flex-wrap gap-1 mt-0.5">
                {user?.roles.map(role => (
                  <span key={role} className="badge bg-brand-light text-brand">{humanize(role)}</span>
                ))}
              </dd>
            </div>
            <div className="kv"><dt>Permissions</dt><dd>{user?.permissions.length ?? 0} granted</dd></div>
          </dl>
        </Card>

        <Card title="AI providers"
              description="A provider without an API key falls back to the built-in rules, and its output is labelled accordingly.">
          <ul className="space-y-2.5">
            {providers.map(provider => (
              <li key={provider.kind} className="flex items-start gap-3">
                <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                  provider.isConfigured ? 'bg-good' : 'bg-line-strong'
                }`} aria-hidden="true" />
                <div>
                  <div className="text-sm font-medium text-ink">
                    {provider.name}
                    <span className={`ml-2 badge ${
                      provider.isConfigured ? 'bg-good-light text-good' : 'bg-surface-sunken text-ink-muted'
                    }`}>
                      {provider.isConfigured ? 'configured' : 'not configured'}
                    </span>
                  </div>
                  {provider.defaultModel && (
                    <div className="text-xs font-mono text-ink-muted">{provider.defaultModel}</div>
                  )}
                  <p className="text-xs text-ink-muted mt-0.5">{provider.notes}</p>
                </div>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Roles and permissions" className="lg:col-span-2"
              description="The capability each built-in role carries. Every one of these is enforced server-side.">
          {isLoading ? <Spinner /> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Role</th><th>What it can do</th><th>Permissions</th></tr></thead>
                <tbody>
                  {catalogue?.roles.map(role => (
                    <tr key={role.role} className={user?.roles.includes(role.role) ? 'bg-brand-light/40' : undefined}>
                      <td className="font-medium whitespace-nowrap">
                        {humanize(role.role)}
                        {user?.roles.includes(role.role) && (
                          <span className="ml-2 badge bg-brand-light text-brand">yours</span>
                        )}
                      </td>
                      <td className="text-sm text-ink-muted">{role.description}</td>
                      <td>
                        <details>
                          <summary className="cursor-pointer text-xs text-brand">
                            {role.permissions.length} permission(s)
                          </summary>
                          <ul className="mt-1.5 flex flex-wrap gap-1">
                            {role.permissions.map(permission => (
                              <li key={permission}
                                  className={`badge font-mono ${
                                    myPermissions.has(permission)
                                      ? 'bg-good-light text-good'
                                      : 'bg-surface-sunken text-ink-muted'
                                  }`}>
                                {permission}
                              </li>
                            ))}
                          </ul>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
