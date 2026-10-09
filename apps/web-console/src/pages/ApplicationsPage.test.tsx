import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiRequest = vi.fn();
vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return { ...actual, apiRequest: (path: string, options?: unknown) => apiRequest(path, options) };
});

const permissions = { current: new Set<string>(['application:write', 'discovery:run']) };
vi.mock('../lib/auth', async () => {
  const actual = await vi.importActual<typeof import('../lib/auth')>('../lib/auth');
  return { ...actual, useAuth: () => ({ can: (p: string) => permissions.current.has(p) }) };
});

vi.mock('../lib/project', async () => {
  const actual = await vi.importActual<typeof import('../lib/project')>('../lib/project');
  return { ...actual, useProject: () => ({ projectId: 'project-1', project: { name: 'Retail' } }) };
});

const ApplicationsPage = (await import('./ApplicationsPage')).default;

/**
 * Whether robots.txt is respected is now enforced by the crawler, and an origin whose
 * robots.txt cannot be read is not explored at all. A setting with that consequence has to
 * be visible and changeable here: it was readable over the API and settable nowhere, which
 * is what made the enforcement unsafe to add on its own (BUG-0042).
 */
const renderPage = () => render(
  <MemoryRouter>
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ApplicationsPage />
    </QueryClientProvider>
  </MemoryRouter>
);

const application = (respectRobotsTxt: boolean) => ({
  id: 'app-1', projectId: 'project-1', name: 'Public Site',
  baseUrl: 'https://site.example.test/', description: '',
  authStrategy: 'none', hasCredentials: false,
  pageCount: 4, elementCount: 20, apiEndpointCount: 2, journeyCount: 0,
  lastDiscoveryStatus: 'completed', respectRobotsTxt, createdAt: '2026-10-01T09:00:00Z'
});

describe('the robots.txt setting on the add-application form', () => {
  // The page's trigger and the form's submit share the label "Add application"; the trigger
  // is removed once the form is open, so after this there is exactly one of them.
  const openForm = async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Add application' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Public Site');
    await userEvent.type(screen.getByLabelText('Base URL'), 'https://site.example.test/');
  };

  const submit = () => userEvent.click(screen.getByRole('button', { name: 'Add application' }));

  const submittedBody = () => {
    const call = apiRequest.mock.calls.find(([path, options]) =>
      path === '/api/v1/applications' && (options as { method?: string })?.method === 'POST');
    return (call?.[1] as { body: Record<string, unknown> }).body;
  };

  beforeEach(() => {
    permissions.current = new Set(['application:write', 'discovery:run']);
    apiRequest.mockReset();
    apiRequest.mockImplementation(async (path: string) =>
      path.startsWith('/api/v1/applications?') ? [] : { id: 'app-1' });
  });

  test('is on by default, and says what it does', async () => {
    await openForm();

    const checkbox = screen.getByLabelText('Respect robots.txt') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    // The consequence of leaving it on is the part somebody needs before pointing this at a
    // site they do not run, so it is on the form rather than only in the manual.
    expect(screen.getByText(/will not open a path it disallows/i)).toBeInTheDocument();
  });

  test('sends true when left alone', async () => {
    await openForm();
    await submit();

    await waitFor(() => expect(submittedBody()).toBeDefined());
    expect(submittedBody().respectRobotsTxt).toBe(true);
  });

  test('sends false when unchecked', async () => {
    await openForm();
    await userEvent.click(screen.getByLabelText('Respect robots.txt'));
    await submit();

    await waitFor(() => expect(submittedBody()).toBeDefined());
    // An unchecked checkbox sends no form field at all. Reading it as a missing value would
    // leave the default on and silently discard the choice.
    expect(submittedBody().respectRobotsTxt).toBe(false);
  });
});

/**
 * The same setting after registration. There is no separate application detail route — the
 * card on this page is the detail view — so this is where its current state has to be
 * readable and where it has to be changeable. Before this it could only be changed by
 * calling the API by hand.
 */
describe('the robots.txt setting on an application card', () => {
  const listed = (respectRobotsTxt: boolean) => {
    apiRequest.mockReset();
    apiRequest.mockImplementation(async (path: string) =>
      path.startsWith('/api/v1/applications?') ? [application(respectRobotsTxt)] : {});
    return renderPage();
  };

  const patchBody = () => {
    const call = apiRequest.mock.calls.find(([path, options]) =>
      path === '/api/v1/applications/app-1' && (options as { method?: string })?.method === 'PATCH');
    return call === undefined ? undefined : (call[1] as { body: Record<string, unknown> }).body;
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    permissions.current = new Set(['application:write', 'discovery:run']);
  });

  test('says so quietly when it is on', async () => {
    listed(true);

    expect(await screen.findByText(/robots\.txt is respected/i)).toBeInTheDocument();
    expect(screen.queryByText('robots.txt is ignored')).not.toBeInTheDocument();
    const checkbox = screen.getByLabelText('Respect robots.txt') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  test('is visible without reading when it is off', async () => {
    listed(false);

    // The off state is a badge rather than a sentence: it is the state where a crawl
    // ignores what the site asked for, and somebody scanning a list of applications should
    // not have to read prose to find it.
    expect(await screen.findByText('robots.txt is ignored')).toBeInTheDocument();
    expect((screen.getByLabelText('Respect robots.txt') as HTMLInputElement).checked).toBe(false);
  });

  test('turning it off asks first, then saves', async () => {
    const confirmed = vi.spyOn(window, 'confirm').mockReturnValue(true);
    listed(true);

    await userEvent.click(await screen.findByLabelText('Respect robots.txt'));

    expect(confirmed).toHaveBeenCalledOnce();
    expect(confirmed.mock.calls[0]?.[0]).toContain('Public Site');
    // Somebody needs to know it is recorded before they do it, not afterwards.
    expect(confirmed.mock.calls[0]?.[0]).toContain('audit log');
    await waitFor(() => expect(patchBody()).toEqual({ respectRobotsTxt: false }));
  });

  test('declining the confirmation changes nothing', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    listed(true);

    const checkbox = await screen.findByLabelText('Respect robots.txt') as HTMLInputElement;
    await userEvent.click(checkbox);

    expect(patchBody()).toBeUndefined();
    // A controlled checkbox whose handler returns early can be left visually unchecked
    // while the data says otherwise, which would read as a saved change that never was.
    expect(checkbox.checked).toBe(true);
  });

  test('turning it back on needs no confirmation', async () => {
    const confirmed = vi.spyOn(window, 'confirm').mockReturnValue(true);
    listed(false);

    await userEvent.click(await screen.findByLabelText('Respect robots.txt'));

    // Restoring the default is not a decision anybody needs talking out of.
    expect(confirmed).not.toHaveBeenCalled();
    await waitFor(() => expect(patchBody()).toEqual({ respectRobotsTxt: true }));
  });

  test('is read-only without application:write', async () => {
    permissions.current = new Set(['discovery:run']);
    listed(false);

    // The state still has to be visible: somebody who cannot change it can still be the
    // person who needs to know a crawl is ignoring robots.txt.
    expect(await screen.findByText('robots.txt is ignored')).toBeInTheDocument();
    expect(screen.queryByLabelText('Respect robots.txt')).not.toBeInTheDocument();
  });
});
