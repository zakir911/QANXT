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

vi.mock('../lib/auth', async () => {
  const actual = await vi.importActual<typeof import('../lib/auth')>('../lib/auth');
  return { ...actual, useAuth: () => ({ can: () => true }) };
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
describe('the robots.txt setting on the add-application form', () => {
  const renderPage = () => render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ApplicationsPage />
      </QueryClientProvider>
    </MemoryRouter>
  );

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
