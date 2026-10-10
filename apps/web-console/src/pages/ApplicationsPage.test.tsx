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
  const openForm = async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Add application' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Public Site');
    await userEvent.type(screen.getByLabelText('Base URL'), 'https://site.example.test/');
  };

  // "Add application" opens the panel and stays mounted while it is open; "Create
  // application" is the submit. They were both called "Add application" until ISSUE-005.
  const submit = () => userEvent.click(screen.getByRole('button', { name: 'Create application' }));

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
 * The disclosure panel's keyboard and screen-reader contract.
 *
 * The trigger carried aria-expanded, but the page unmounted it the moment the panel
 * opened, so the attribute could only ever be read as "false" — a control that announces
 * collapsed and then vanishes rather than announcing expanded (QA pass, ISSUE-003). With
 * the trigger gone and focus moved into the panel, the only way out was Cancel or tabbing
 * the whole form (ISSUE-004).
 */
describe('the add-application panel as a disclosure', () => {
  beforeEach(() => {
    permissions.current = new Set(['application:write', 'discovery:run']);
    apiRequest.mockReset();
    apiRequest.mockImplementation(async (path: string) =>
      path.startsWith('/api/v1/applications?') ? [] : { id: 'app-1' });
  });

  const trigger = () => screen.getByRole('button', { name: 'Add application' });

  test('the trigger reports the panel as expanded while it is open', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Add application' }));

    // The trigger has to still be there to say so. aria-expanded="false" on a control that
    // never becomes true is a false statement in the accessibility tree.
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(trigger()).toHaveAttribute('aria-controls', 'add-application');
  });

  test('the trigger reports collapsed again once the panel closes', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Add application' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
  });

  test('Escape inside the panel closes it and gives focus back to the trigger', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Add application' }));
    expect(screen.getByLabelText('Name')).toHaveFocus();

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    // Dropping focus on <body> after closing strands a keyboard user at the top of the page.
    expect(trigger()).toHaveFocus();
  });

  test('focus still lands on a trigger when nothing was focused to open it', async () => {
    renderPage();
    const opener = await screen.findByRole('button', { name: 'Add application' });
    // A programmatic click never focuses the button, so the opener is <body>: connected,
    // but not a focus target. The browser caught this where userEvent did not.
    opener.click();
    await screen.findByLabelText('Name');

    await userEvent.keyboard('{Escape}');

    expect(screen.getByRole('button', { name: 'Add application' })).toHaveFocus();
  });

  test('each control that acts on the panel has its own name', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Add application' }));

    // Opening, submitting and cancelling are three different actions, so they read as
    // three different names. "Add application" used to name both the trigger and the
    // submit, and the empty state called the same action "Add an application".
    const names = screen.getAllByRole('button').map(b => b.textContent?.trim());
    expect(names).toContain('Add application');
    expect(names).toContain('Create application');
    expect(names.filter(n => n === 'Add application')).toHaveLength(1);
  });

  test('the empty state names the action distinctly too', async () => {
    renderPage();
    await screen.findByRole('button', { name: 'Add application' });

    expect(screen.getByRole('button', { name: 'Add your first application' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add an application' })).not.toBeInTheDocument();
  });
});

/**
 * A cleared field means "use the default", not "send nothing".
 *
 * FormData returns "" for a field the user emptied, never null, so `?? default` never fires
 * for one. Clearing "Excluded paths" therefore submitted an empty exclusion list and the
 * /logout,/signout,/delete protection vanished silently; clearing a number field submitted
 * 0, which the API rejects with a range the user never typed (QA pass, ISSUE-001).
 */
describe('a cleared field on the add-application form', () => {
  const openAndSubmit = async (clear: string[]) => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Add application' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Public Site');
    await userEvent.type(screen.getByLabelText('Base URL'), 'https://site.example.test/');
    for (const label of clear) await userEvent.clear(screen.getByLabelText(label));
    await userEvent.click(screen.getByRole('button', { name: 'Create application' }));
  };

  const body = () => {
    const call = apiRequest.mock.calls.find(([path, options]) =>
      path === '/api/v1/applications' && (options as { method?: string })?.method === 'POST');
    return (call?.[1] as { body: Record<string, unknown> } | undefined)?.body;
  };

  beforeEach(() => {
    permissions.current = new Set(['application:write', 'discovery:run']);
    apiRequest.mockReset();
    apiRequest.mockImplementation(async (path: string) =>
      path.startsWith('/api/v1/applications?') ? [] : { id: 'app-1' });
  });

  test('clearing the excluded paths sends the default, not an empty list', async () => {
    await openAndSubmit(['Excluded paths']);

    await waitFor(() => expect(body()).toBeDefined());
    // An empty list is the one value that drops the only control stopping a crawl from
    // opening sign-out or a delete link on somebody else's application.
    expect(body()!.excludedPaths).toBe('/logout,/signout,/delete');
  });

  test('clearing a budget sends its default, not zero', async () => {
    await openAndSubmit(['Crawl depth', 'Page budget']);

    await waitFor(() => expect(body()).toBeDefined());
    expect(body()!.maxCrawlDepth).toBe(3);
    expect(body()!.maxPages).toBe(50);
  });

  test('a value the user actually typed is still sent', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Add application' }));
    await userEvent.type(screen.getByLabelText('Name'), 'Public Site');
    await userEvent.type(screen.getByLabelText('Base URL'), 'https://site.example.test/');
    await userEvent.clear(screen.getByLabelText('Excluded paths'));
    await userEvent.type(screen.getByLabelText('Excluded paths'), '/admin');
    await userEvent.clear(screen.getByLabelText('Crawl depth'));
    await userEvent.type(screen.getByLabelText('Crawl depth'), '7');
    await userEvent.click(screen.getByRole('button', { name: 'Create application' }));

    // The guard must not reach past the blank case and overwrite a real choice.
    await waitFor(() => expect(body()).toBeDefined());
    expect(body()!.excludedPaths).toBe('/admin');
    expect(body()!.maxCrawlDepth).toBe(7);
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


/**
 * An application could be created and then never changed. The API has always accepted a
 * PATCH for every field; the console offered exactly one toggle, for robots.txt. So
 * somebody who registered an application before knowing its login had to delete it and
 * start again — which is how a user ended up with discovery reaching one page, the login
 * screen, and no way to give it credentials.
 */
describe('editing an application', () => {
  // Each describe in this file resets these itself: permissions is module-level state and
  // an earlier test empties it to check the button hides. Without this the edit button is
  // simply absent and the failure looks like the button was never added.
  beforeEach(() => {
    permissions.current = new Set(['application:write', 'discovery:run']);
    apiRequest.mockReset();
  });

  const detail = (overrides: Record<string, unknown> = {}) => ({
    id: 'app-1', name: 'Public Site', baseUrl: 'https://site.example.test/',
    description: 'A site', allowedDomains: 'cdn.example.test',
    excludedPaths: '/logout,/signout,/delete',
    maxCrawlDepth: 4, maxPages: 120,
    respectRobotsTxt: true, interactionMode: 'navigation',
    authStrategy: 'formLogin', loginUrl: 'https://site.example.test/login',
    hasCredentials: true, ...overrides
  });

  const openEditor = async () => {
    apiRequest.mockImplementation((path: string) => {
      if (path === '/api/v1/applications/app-1') return Promise.resolve(detail());
      if (String(path).startsWith('/api/v1/applications')) return Promise.resolve([application(true)]);
      return Promise.resolve([]);
    });

    renderPage();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('edit-app-1'));
    await waitFor(() => expect(screen.getByLabelText(/^Name/)).toHaveValue('Public Site'));
    return user;
  };

  const patchBody = () => {
    const call = apiRequest.mock.calls.find(
      ([, options]) => (options as { method?: string } | undefined)?.method === 'PATCH');
    return (call?.[1] as { body: Record<string, unknown> } | undefined)?.body;
  };

  test('loads the stored settings rather than the create defaults', async () => {
    await openEditor();

    expect(screen.getByLabelText(/Base URL/)).toHaveValue('https://site.example.test/');
    expect(screen.getByLabelText(/Excluded paths/i)).toHaveValue('/logout,/signout,/delete');
    expect(screen.getByLabelText(/Page budget/)).toHaveValue(120);
    expect(screen.getByLabelText(/How discovery explores/)).toHaveValue('navigation');
    expect(screen.getByLabelText(/Login URL/)).toHaveValue('https://site.example.test/login');
  });

  test('says credentials are stored, since the form cannot show them', async () => {
    await openEditor();
    expect(screen.getByText(/Credentials are already stored/)).toBeInTheDocument();
  });

  test('leaving the credential fields blank does not wipe the stored login', async () => {
    const user = await openEditor();

    await user.clear(screen.getByLabelText(/Page budget/));
    await user.type(screen.getByLabelText(/Page budget/), '200');
    await user.click(screen.getByRole('button', { name: /Save changes/ }));

    await waitFor(() => expect(patchBody()).toBeDefined());
    // null means "leave what is stored alone". Sending empty strings would destroy a
    // working login the moment somebody edited an unrelated field.
    expect(patchBody()!.credentials).toBeNull();
    expect(patchBody()!.maxPages).toBe(200);
  });

  test('typing a new password replaces the stored credentials', async () => {
    const user = await openEditor();

    await user.type(screen.getByLabelText(/^Username/), 'qa@example.test');
    await user.type(screen.getByLabelText(/^Password/), 'a-new-secret');
    await user.click(screen.getByRole('button', { name: /Save changes/ }));

    await waitFor(() => expect(patchBody()).toBeDefined());
    const credentials = patchBody()!.credentials as { username: string; password: string };
    expect(credentials.username).toBe('qa@example.test');
    expect(credentials.password).toBe('a-new-secret');
  });

  test('an edit patches rather than creating a second application', async () => {
    const user = await openEditor();

    await user.click(screen.getByRole('button', { name: /Save changes/ }));

    await waitFor(() => expect(patchBody()).toBeDefined());
    const posted = apiRequest.mock.calls.find(
      ([, options]) => (options as { method?: string } | undefined)?.method === 'POST');
    expect(posted).toBeUndefined();
    // projectId belongs to a create. Sending it on a PATCH would invite moving an
    // application between projects by accident.
    expect(patchBody()).not.toHaveProperty('projectId');
  });

  test('cancelling an edit leaves the application alone', async () => {
    const user = await openEditor();

    await user.click(screen.getByRole('button', { name: /^Cancel$/ }));

    await waitFor(() => expect(screen.queryByTestId('scope-form')).not.toBeInTheDocument());
    expect(patchBody()).toBeUndefined();
  });
});
