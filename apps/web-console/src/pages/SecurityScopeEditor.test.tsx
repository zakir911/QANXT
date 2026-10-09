import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiRequest = vi.fn();
vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return { ...actual, apiRequest: (path: string, options?: unknown) => apiRequest(path, options) };
});

const SecurityScopeEditor = (await import('./SecurityScopeEditor')).default;
type Record_ = import('./SecurityScopeEditor').SecurityScopeRecord;

/**
 * The console displayed a security scope and had no way to write one, so the empty state
 * told a user that "until somebody writes one, nothing here can be scanned" and then offered
 * nothing to write it with. The only route was a PUT by hand.
 *
 * What this form writes is not configuration: it is a record that a named person authorized
 * testing of somebody's application. So the tests that matter are the ones that stop it
 * being filled in casually.
 */
const scope = (overrides: Partial<Record_> = {}): Record_ => ({
  id: 'scope-1', applicationId: 'app-1', enabled: true,
  authorizationNote: 'Authorized by R. Patel, Head of Engineering, for staging. SEC-114.',
  authorizedByUserId: 'user-1', authorizedAt: '2026-10-01T00:00:00Z',
  allowedDomains: 'staging.example.test', allowedApiDomains: '',
  allowedPaths: '', blockedPaths: '/admin/billing',
  environmentId: null,
  maxRequestsPerSecond: 5, maxConcurrentRequests: 2, maxScanDurationMinutes: 20,
  allowActiveTesting: true, allowDestructiveTesting: false, allowProduction: false,
  ...overrides
});

const renderEditor = (existing: Record_ | null = null, suggestedHost = 'site.example.test') => {
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SecurityScopeEditor
        applicationId="app-1"
        applicationName="Public Site"
        suggestedHost={suggestedHost}
        existing={existing}
        open
        onClose={onClose}
      />
    </QueryClientProvider>
  );
  return { onClose };
};

const sentBody = () => {
  const call = apiRequest.mock.calls.find(([path]) => String(path).endsWith('/scope'));
  return (call?.[1] as { body: Record<string, unknown> } | undefined)?.body;
};

describe('writing a security scope', () => {
  beforeEach(() => {
    apiRequest.mockReset();
    apiRequest.mockResolvedValue(scope());
  });

  test('offers the application host as the starting allowlist, since an empty one permits nothing', () => {
    renderEditor(null, 'site.example.test');
    expect(screen.getByLabelText(/^Hosts/)).toHaveValue('site.example.test');
  });

  test('starts with active, destructive and production all off', () => {
    renderEditor();
    expect(screen.getByRole('checkbox', { name: /Active testing/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Destructive testing/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Production/ })).not.toBeChecked();
  });

  test('refuses a one-word authorization note', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.type(screen.getByLabelText(/^Authorization/), 'Authorized');
    await user.click(screen.getByTestId('scope-save'));

    expect(await screen.findByTestId('scope-problem')).toHaveTextContent(/who approved this/i);
    // Nothing is sent: a note the scanner would refuse anyway must not be stored looking valid.
    expect(sentBody()).toBeUndefined();
  });

  test('refuses an empty host list rather than storing a scope that cannot scan', async () => {
    const user = userEvent.setup();
    renderEditor(null, '');

    await user.type(screen.getByLabelText(/^Authorization/),
      'Authorized by Z. Inamdar, owner, for the staging site. Ticket QA-1.');
    await user.click(screen.getByTestId('scope-save'));

    expect(await screen.findByTestId('scope-problem')).toHaveTextContent(/permits nothing/i);
    expect(sentBody()).toBeUndefined();
  });

  test('saves a passive scope with the note and host', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.type(screen.getByLabelText(/^Authorization/),
      'Authorized by Z. Inamdar, owner, for the staging site. Ticket QA-1.');
    await user.click(screen.getByTestId('scope-save'));

    await waitFor(() => expect(sentBody()).toBeDefined());
    const body = sentBody()!;
    expect(body.authorizationNote).toContain('Z. Inamdar');
    expect(body.allowedDomains).toBe('site.example.test');
    expect(body.allowActiveTesting).toBe(false);
    expect(body.allowDestructiveTesting).toBe(false);
    expect(body.allowProduction).toBe(false);
    // Zero refuses every request, so the form must not quietly save a scope that permits
    // nothing while reading as authorized.
    expect(body.maxRequestsPerSecond).toBe(5);
  });

  test('cannot enable destructive testing without active testing', async () => {
    const user = userEvent.setup();
    renderEditor();

    const destructive = screen.getByRole('checkbox', { name: /Destructive testing/ });
    expect(destructive).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: /Active testing/ }));
    expect(destructive).toBeEnabled();
  });

  test('turning active testing off also turns destructive off', async () => {
    const user = userEvent.setup();
    renderEditor();

    const active = screen.getByRole('checkbox', { name: /Active testing/ });
    await user.click(active);
    await user.click(screen.getByRole('checkbox', { name: /Destructive testing/ }));
    expect(screen.getByRole('checkbox', { name: /Destructive testing/ })).toBeChecked();

    await user.click(active);
    expect(screen.getByRole('checkbox', { name: /Destructive testing/ })).not.toBeChecked();
  });

  test('destructive testing needs a typed confirmation, not just a checkbox', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.type(screen.getByLabelText(/^Authorization/),
      'Authorized by Z. Inamdar, owner, for the throwaway staging copy. QA-2.');
    await user.click(screen.getByRole('checkbox', { name: /Active testing/ }));
    await user.click(screen.getByRole('checkbox', { name: /Destructive testing/ }));
    await user.click(screen.getByTestId('scope-save'));

    expect(await screen.findByTestId('scope-problem')).toHaveTextContent(/Type DESTRUCTIVE/);
    expect(sentBody()).toBeUndefined();

    await user.type(screen.getByLabelText(/Type DESTRUCTIVE/), 'DESTRUCTIVE');
    await user.click(screen.getByTestId('scope-save'));

    await waitFor(() => expect(sentBody()).toBeDefined());
    expect(sentBody()!.allowDestructiveTesting).toBe(true);
  });

  test('production needs a typed confirmation too', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.type(screen.getByLabelText(/^Authorization/),
      'Authorized by Z. Inamdar, owner, read-only checks against production. QA-3.');
    await user.click(screen.getByRole('checkbox', { name: /Production/ }));
    await user.click(screen.getByTestId('scope-save'));

    expect(await screen.findByTestId('scope-problem')).toHaveTextContent(/Type PRODUCTION/);
    expect(sentBody()).toBeUndefined();

    await user.type(screen.getByLabelText(/Type PRODUCTION/), 'PRODUCTION');
    await user.click(screen.getByTestId('scope-save'));

    await waitFor(() => expect(sentBody()).toBeDefined());
    expect(sentBody()!.allowProduction).toBe(true);
  });

  test('loads an existing scope so an edit starts from what is authorized now', () => {
    renderEditor(scope({ allowedDomains: 'live.example.test', maxRequestsPerSecond: 9 }));

    expect(screen.getByLabelText(/^Authorization/)).toHaveValue(
      'Authorized by R. Patel, Head of Engineering, for staging. SEC-114.');
    expect(screen.getByLabelText(/^Hosts/)).toHaveValue('live.example.test');
    expect(screen.getByLabelText(/Requests per second/)).toHaveValue('9');
    expect(screen.getByLabelText(/Blocked paths/)).toHaveValue('/admin/billing');
    expect(screen.getByRole('checkbox', { name: /Active testing/ })).toBeChecked();
  });

  test('withdrawing authorization is possible without deleting the record', async () => {
    const user = userEvent.setup();
    renderEditor(scope());

    await user.click(screen.getByRole('checkbox', { name: /Scope is enabled/ }));
    await user.click(screen.getByTestId('scope-save'));

    await waitFor(() => expect(sentBody()).toBeDefined());
    expect(sentBody()!.enabled).toBe(false);
    // The note survives, because the record of who authorized it is the point.
    expect(sentBody()!.authorizationNote).toContain('R. Patel');
  });

  test('surfaces a refusal from the API rather than appearing to have saved', async () => {
    const user = userEvent.setup();
    apiRequest.mockRejectedValue(new Error('refused'));
    renderEditor();

    await user.type(screen.getByLabelText(/^Authorization/),
      'Authorized by Z. Inamdar, owner, for the staging site. Ticket QA-1.');
    await user.click(screen.getByTestId('scope-save'));

    expect(await screen.findByTestId('scope-save-error')).toBeInTheDocument();
  });

  test('a non-numeric limit is refused rather than sent as NaN', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.type(screen.getByLabelText(/^Authorization/),
      'Authorized by Z. Inamdar, owner, for the staging site. Ticket QA-1.');
    await user.clear(screen.getByLabelText(/Requests per second/));
    await user.type(screen.getByLabelText(/Requests per second/), 'fast');
    await user.click(screen.getByTestId('scope-save'));

    expect(await screen.findByTestId('scope-problem')).toHaveTextContent(/zero or more/i);
    expect(sentBody()).toBeUndefined();
  });
});
