import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

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

const TestingPage = (await import('./TestingPage')).default;

const CATEGORIES = ['smoke', 'functional', 'negative', 'boundary', 'accessibility', 'security'];
const TAXONOMY = {
  modes: [
    { mode: 'quick', categories: ['smoke', 'functional', 'negative', 'accessibility'] },
    { mode: 'comprehensive', categories: CATEGORIES },
    { mode: 'custom', categories: [] }
  ],
  categories: CATEGORIES.map(key => ({ key, name: key[0]!.toUpperCase() + key.slice(1), description: `${key} tests`, group: 'Functional', automation: 'automated' })),
  defaultWeights: { functional: 3 },
  defaultViewports: []
};
const PROFILE = {
  mode: 'comprehensive', categories: [], browsers: ['chromium', 'firefox', 'webkit'],
  viewports: [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }],
  pageLoadBudgetMs: 3000, submitBudgetMs: 2000, allowSafeSecurityProbes: true, visualThresholdPercent: 0.5, weights: { functional: 3 }
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><TestingPage /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  apiRequest.mockReset();
  localStorage.clear();
  apiRequest.mockImplementation((path: string, options?: { method?: string; body?: unknown }) => {
    if (path.startsWith('/api/v1/applications?')) return Promise.resolve([{ id: 'app-1', name: 'Form lab', baseUrl: 'http://lab', pageCount: 21 }]);
    if (path === '/api/v1/meta/testing-taxonomy') return Promise.resolve(TAXONOMY);
    if (path.endsWith('/testing-profile') && options?.method === 'PUT') return Promise.resolve(options.body);
    if (path.endsWith('/testing-profile')) return Promise.resolve(PROFILE);
    if (path.endsWith('/forms')) return Promise.resolve([{ id: 'f1', formKey: 'registration', name: 'Create an account', route: '/registration', pageUrl: 'http://lab/registration', method: 'post', isMultiStep: false, hasCsrfToken: true, fieldCount: 5, requiredFieldCount: 5, dependencyCount: 0, isPresent: true, lastSeenAt: '2026-10-12T00:00:00Z' }]);
    throw new Error(`unexpected call to ${path}`);
  });
});

describe('TestingPage', () => {
  test('comprehensive mode selects every category, and deselect all leaves none', async () => {
    renderPage();
    expect(await screen.findByText(/Test categories \(6 of 6\)/)).toBeInTheDocument();
    for (const name of ['Smoke', 'Functional', 'Boundary', 'Security']) {
      expect(screen.getByRole('checkbox', { name: new RegExp(`^${name}`) })).toBeChecked();
    }

    fireEvent.click(screen.getByRole('button', { name: 'Deselect all' }));
    expect(screen.getByText(/Test categories \(0 of 6\)/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^Custom/ })).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getByText(/Test categories \(6 of 6\)/)).toBeInTheDocument();
  });

  test('choosing categories by hand saves a custom profile with exactly those categories', async () => {
    renderPage();
    await screen.findByText(/Test categories \(6 of 6\)/);
    fireEvent.click(screen.getByRole('radio', { name: /^Quick/ }));
    expect(screen.getByText(/Test categories \(4 of 6\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /^Security/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));

    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith('/api/v1/applications/app-1/testing-profile', expect.objectContaining({ method: 'PUT' })));
    const saved = apiRequest.mock.calls.find(([, options]) => options?.method === 'PUT')![1].body;
    expect(saved.mode).toBe('custom');
    expect([...saved.categories].sort()).toEqual(['accessibility', 'functional', 'negative', 'security', 'smoke']);
  });

  test('the discovered forms are listed with their fields', async () => {
    renderPage();
    expect(await screen.findByText('Create an account')).toBeInTheDocument();
    expect(screen.getByText('/registration')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate tests' })).toBeEnabled();
  });
});
