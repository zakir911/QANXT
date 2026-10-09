import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiRequest = vi.fn();
vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return { ...actual, apiRequest: (path: string, options?: unknown) => apiRequest(path, options) };
});

vi.mock('./auth', async () => {
  const actual = await vi.importActual<typeof import('./auth')>('./auth');
  return { ...actual, useAuth: () => ({ isAuthenticated: true }) };
});

const { ProjectProvider, useProject } = await import('./project');

const STORAGE_KEY = 'qanxt.project';

/**
 * The selected project is remembered in localStorage and sent as projectId on almost every
 * request. A remembered project that no longer exists therefore does not produce an empty
 * screen, it produces "The project was not found." on every action, including Run all,
 * because the pages only guard against a null selection and a stale id is not null.
 *
 * The provider is supposed to clear a selection that is not in the project list. It used
 * the list being non-empty as a proxy for the query having loaded, so the one case where
 * clearing matters most — no projects at all — was the case it skipped.
 */
function Probe() {
  const { projectId, projects, isLoading } = useProject();
  return (
    <div>
      <span data-testid="selected">{projectId ?? 'none'}</span>
      <span data-testid="count">{projects.length}</span>
      <span data-testid="loading">{String(isLoading)}</span>
    </div>
  );
}

const renderProvider = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ProjectProvider><Probe /></ProjectProvider>
  </QueryClientProvider>
);

const project = (id: string, name: string) => ({
  id, name, key: name.toUpperCase(), description: '',
  applicationCount: 0, testCaseCount: 0, openDefectCount: 0,
  createdAt: '2026-10-09T00:00:00Z'
});

describe('the remembered project', () => {
  beforeEach(() => {
    apiRequest.mockReset();
    localStorage.clear();
  });

  test('A remembered project is kept when the account still has it', async () => {
    localStorage.setItem(STORAGE_KEY, 'project-1');
    apiRequest.mockResolvedValue([project('project-1', 'Retail'), project('project-2', 'Ops')]);

    renderProvider();

    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('2'));
    expect(screen.getByTestId('selected').textContent).toBe('project-1');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('project-1');
  });

  test('A remembered project is cleared when the account has other projects but not that one', async () => {
    localStorage.setItem(STORAGE_KEY, 'deleted-project');
    apiRequest.mockResolvedValue([project('project-2', 'Ops')]);

    renderProvider();

    // One project left, so it is also selected for the user rather than left unset.
    await waitFor(() => expect(screen.getByTestId('selected').textContent).toBe('project-2'));
    expect(localStorage.getItem(STORAGE_KEY)).toBe('project-2');
  });

  test('A remembered project is cleared when the account has no projects at all', async () => {
    localStorage.setItem(STORAGE_KEY, 'deleted-project');
    apiRequest.mockResolvedValue([]);

    renderProvider();

    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    // Without this the console keeps posting a dead projectId and every action comes back
    // as "The project was not found." with a correlation reference and no way to recover
    // from inside the UI, because the project switcher has nothing to switch to.
    expect(screen.getByTestId('selected').textContent).toBe('none');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test('A remembered project survives a failed project query rather than being discarded', async () => {
    localStorage.setItem(STORAGE_KEY, 'project-1');
    apiRequest.mockRejectedValue(new Error('the API is down'));

    renderProvider();

    // A network failure is not evidence that the project is gone. Clearing here would lose
    // the user's selection every time the API blips.
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    expect(screen.getByTestId('selected').textContent).toBe('project-1');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('project-1');
  });
});
