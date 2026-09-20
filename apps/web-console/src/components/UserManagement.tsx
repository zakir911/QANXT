import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../api/client';
import { Permissions, useAuth } from '../lib/auth';
import { Card, ErrorNotice, Spinner } from '../components/ui';
import { formatRelative, humanize } from '../lib/format';

/**
 * The people in an organization.
 *
 * This platform sends no mail, so an invitation cannot deliver anything. It produces a
 * one-time password shown here exactly once, and the screen says so plainly rather than
 * implying an email that nobody sent.
 */

interface UserSummary {
  id: string;
  email: string;
  displayName: string;
  status: string;
  roles: string[];
  createdAt: string;
  lastLoginAt?: string;
  isLockedOut: boolean;
}

interface InvitedUser {
  user: UserSummary;
  temporaryPassword: string;
  handoverNote: string;
}

// SuperAdmin is deliberately absent: it cannot be granted through an invitation.
const ROLES = [
  'organizationAdmin', 'projectAdmin', 'qaLead', 'qaEngineer', 'developer', 'viewer'
] as const;

export default function UserManagement() {
  const { can, user: me } = useAuth();
  const queryClient = useQueryClient();
  const canEdit = can(Permissions.userWrite);
  const [isInviting, setIsInviting] = useState(false);
  const [handover, setHandover] = useState<InvitedUser | null>(null);

  const { data: users = [], isLoading, error, refetch } = useQuery({
    queryKey: ['users'],
    queryFn: () => apiRequest<UserSummary[]>('/api/v1/users')
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['users'] });

  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; role?: string; status?: string }) =>
      apiRequest<UserSummary>(`/api/v1/users/${id}`, { method: 'PATCH', body }),
    onSuccess: () => void invalidate()
  });

  const reset = useMutation({
    mutationFn: (id: string) =>
      apiRequest<InvitedUser>(`/api/v1/users/${id}/reset-password`, { method: 'POST' }),
    onSuccess: result => { setHandover(result); void invalidate(); }
  });

  return (
    <Card
      title="People"
      className="lg:col-span-2"
      description="Who is in this organization and what each of them can do."
      actions={canEdit && !isInviting
        ? <button className="btn-secondary text-xs" onClick={() => setIsInviting(true)}>Add someone</button>
        : undefined}
    >
      {handover && <HandoverNotice invited={handover} onDismiss={() => setHandover(null)} />}

      {error ? <ErrorNotice error={error} onRetry={() => void refetch()} /> : isLoading ? <Spinner /> : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Name</th><th>Role</th><th>Status</th><th>Last signed in</th>{canEdit && <th>Actions</th>}</tr>
              </thead>
              <tbody>
                {users.map(person => (
                  <tr key={person.id}>
                    <td>
                      <div className="text-sm font-medium text-ink">
                        {person.displayName}
                        {person.id === me?.userId && (
                          <span className="ml-2 badge bg-brand-light text-brand">you</span>
                        )}
                      </div>
                      <div className="text-xs text-ink-muted">{person.email}</div>
                    </td>
                    <td>
                      {canEdit && person.id !== me?.userId ? (
                        <select
                          className="input text-xs"
                          value={person.roles[0] ? toCamel(person.roles[0]) : ''}
                          disabled={update.isPending}
                          onChange={event => update.mutate({ id: person.id, role: event.target.value })}
                        >
                          {ROLES.map(role => <option key={role} value={role}>{humanize(role)}</option>)}
                        </select>
                      ) : (
                        <span className="badge bg-surface-sunken text-ink-muted">
                          {humanize(person.roles[0] ?? 'none')}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${statusClass(person.status)}`}>{humanize(person.status)}</span>
                      {person.isLockedOut && (
                        <span className="ml-1 badge bg-warn-light text-warn">locked out</span>
                      )}
                    </td>
                    <td className="text-xs text-ink-muted">
                      {person.lastLoginAt ? formatRelative(person.lastLoginAt) : 'never'}
                    </td>
                    {canEdit && (
                      <td className="whitespace-nowrap">
                        {person.id !== me?.userId && (
                          <button
                            className="btn-secondary text-xs mr-1"
                            disabled={update.isPending}
                            onClick={() => update.mutate({
                              id: person.id,
                              status: person.status === 'disabled' ? 'active' : 'disabled'
                            })}
                          >
                            {person.status === 'disabled' ? 'Enable' : 'Disable'}
                          </button>
                        )}
                        <button
                          className="btn-secondary text-xs"
                          disabled={reset.isPending}
                          onClick={() => {
                            if (confirm(`Reset the password for ${person.email}? Every session it holds ends immediately.`)) {
                              reset.mutate(person.id);
                            }
                          }}
                        >
                          Reset password
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {update.error ? <div className="mt-2"><ErrorNotice error={update.error} /></div> : null}

          {isInviting && (
            <InviteForm
              onCancel={() => setIsInviting(false)}
              onInvited={result => { setIsInviting(false); setHandover(result); void invalidate(); }}
            />
          )}
        </>
      )}
    </Card>
  );
}

/**
 * Shown once, and impossible to get back. Made deliberately hard to miss, because the one
 * failure mode here is someone closing the page before copying it.
 */
function HandoverNotice({ invited, onDismiss }: { invited: InvitedUser; onDismiss(): void }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="mb-3 rounded border border-warn bg-warn-light/40 px-3 py-2.5">
      <p className="text-sm font-medium text-ink">
        One-time password for {invited.user.email}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <code className="rounded bg-surface px-2 py-1 font-mono text-sm select-all">
          {invited.temporaryPassword}
        </code>
        <button
          className="btn-secondary text-xs"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(invited.temporaryPassword);
              setCopied(true);
            } catch {
              // Clipboard access can be refused; the value is selectable either way.
              setCopied(false);
            }
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button className="btn-secondary text-xs" onClick={onDismiss}>Dismiss</button>
      </div>
      <p className="mt-1.5 text-xs text-ink-muted">{invited.handoverNote}</p>
    </div>
  );
}

function InviteForm({ onInvited, onCancel }: {
  onInvited(result: InvitedUser): void;
  onCancel(): void;
}) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<string>('qaEngineer');

  const invite = useMutation({
    mutationFn: () => apiRequest<InvitedUser>('/api/v1/users', {
      method: 'POST',
      body: { email: email.trim(), displayName: displayName.trim(), role }
    }),
    onSuccess: onInvited
  });

  return (
    <form
      className="mt-3 space-y-3 rounded border border-line bg-surface-sunken p-3"
      onSubmit={event => { event.preventDefault(); invite.mutate(); }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="label">Email</span>
          <input className="input" type="email" required value={email}
                 onChange={event => setEmail(event.target.value)} />
        </label>
        <label className="block">
          <span className="label">Name</span>
          <input className="input" required maxLength={200} value={displayName}
                 onChange={event => setDisplayName(event.target.value)} />
        </label>
        <label className="block">
          <span className="label">Role</span>
          <select className="input" value={role} onChange={event => setRole(event.target.value)}>
            {ROLES.map(option => <option key={option} value={option}>{humanize(option)}</option>)}
          </select>
        </label>
      </div>

      <p className="text-xs text-ink-muted">
        No email is sent — this platform has no mail transport. You will be shown a one-time
        password to pass on yourself, once.
      </p>

      {invite.error ? <ErrorNotice error={invite.error} /> : null}

      <div className="flex gap-2">
        <button className="btn-primary text-xs" type="submit"
                disabled={invite.isPending || !email.trim() || !displayName.trim()}>
          {invite.isPending ? 'Adding…' : 'Add them'}
        </button>
        <button className="btn-secondary text-xs" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function statusClass(status: string): string {
  switch (status) {
    case 'active': return 'bg-good-light text-good';
    case 'invited': return 'bg-brand-light text-brand';
    case 'suspended':
    case 'disabled': return 'bg-bad-light text-bad';
    default: return 'bg-surface-sunken text-ink-muted';
  }
}

/** Role names come back as the server spells them; the selector's values are camelCase. */
function toCamel(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}
