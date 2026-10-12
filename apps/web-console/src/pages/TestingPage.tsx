import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../api/client';
import { Permissions, useAuth } from '../lib/auth';
import { useProject } from '../lib/project';
import { Card, EmptyState, ErrorNotice, PageHeader, Spinner, StatusBadge } from '../components/ui';
import {
  ApplicationPicker, categoryLabel, useApplications, useSelectedApplication, useTaxonomy,
  type FormSummary, type TestingProfile
} from '../lib/quality';

interface GenerationResult {
  testSuiteId: string; testSuiteName: string; forms: number; testsCreated: number; testsUpdated: number;
  testsUnchanged: number; testsDeprecated: number; testsLeftAsEdited: number; gaps: number; humanTasks: number;
  findings: number; usedAi: boolean; engine: string;
  perForm: { formId: string; name: string; route: string; fields: number; tests: number; gaps: number; humanTasks: number; testsByCategory: Record<string, number>; notApplicable: string[] }[];
  warnings: string[];
}

interface SelectionResult { testRunId?: string | null; mode: string; selected: number; explanation: string }

const MODES: { key: string; label: string; description: string }[] = [
  { key: 'quick', label: 'Quick', description: 'Smoke, functional, required fields and automated accessibility.' },
  { key: 'standard', label: 'Standard', description: 'Quick, plus boundaries, validation, input handling, cross-field, dynamic, wizards, errors, security, API and states.' },
  { key: 'comprehensive', label: 'Comprehensive', description: 'Every category that applies to each form.' },
  { key: 'fullRegression', label: 'Full regression', description: 'Every category, for running the whole suite again.' },
  { key: 'custom', label: 'Custom', description: 'Exactly the categories you choose.' }
];

/**
 * How an application is to be tested, and the button that makes it so.
 *
 * The configuration says which categories apply; generation makes every applicable test for
 * every discovered form, with no cap; running chooses which of them to execute. Each step
 * says what it did, including what it could not do.
 */
export default function TestingPage() {
  const { can } = useAuth();
  const { projectId } = useProject();
  const queryClient = useQueryClient();
  const { data: applications = [], isLoading: loadingApps } = useApplications();
  const [applicationId, setApplicationId] = useSelectedApplication(applications);
  const { data: taxonomy } = useTaxonomy();
  const [draft, setDraft] = useState<TestingProfile | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [generation, setGeneration] = useState<GenerationResult | null>(null);
  const [lastRun, setLastRun] = useState<SelectionResult | null>(null);
  const [runBrowser, setRunBrowser] = useState('Chromium');

  const { data: profile, isLoading: loadingProfile } = useQuery({
    queryKey: ['testing-profile', applicationId],
    queryFn: () => apiRequest<TestingProfile>(`/api/v1/applications/${applicationId}/testing-profile`),
    enabled: Boolean(applicationId)
  });
  useEffect(() => { if (profile) setDraft(profile); }, [profile]);

  const { data: forms = [], isLoading: loadingForms } = useQuery({
    queryKey: ['forms', applicationId],
    queryFn: () => apiRequest<FormSummary[]>(`/api/v1/applications/${applicationId}/forms`),
    enabled: Boolean(applicationId)
  });

  const effective = useMemo(() => {
    if (!draft || !taxonomy) return new Set<string>();
    if (draft.mode === 'custom') return new Set(draft.categories);
    return new Set(taxonomy.modes.find(m => m.mode === draft.mode.toLowerCase())?.categories ?? []);
  }, [draft, taxonomy]);

  const save = useMutation({
    mutationFn: (body: TestingProfile) => apiRequest<TestingProfile>(`/api/v1/applications/${applicationId}/testing-profile`, { method: 'PUT', body }),
    onSuccess: async () => { setError(null); await queryClient.invalidateQueries({ queryKey: ['testing-profile', applicationId] }); },
    onError: setError
  });

  const generate = useMutation({
    mutationFn: () => apiRequest<GenerationResult>(`/api/v1/applications/${applicationId}/form-tests/generate`, { method: 'POST', body: {} }),
    onSuccess: async result => {
      setError(null);
      setGeneration(result);
      await queryClient.invalidateQueries({ queryKey: ['coverage'] });
    },
    onError: setError
  });

  const run = useMutation({
    mutationFn: (body: { mode: string; categories?: string[] }) =>
      apiRequest<SelectionResult>(`/api/v1/applications/${applicationId}/runs`, { method: 'POST', body: { ...body, browser: runBrowser } }),
    onSuccess: result => { setError(null); setLastRun(result); },
    onError: setError
  });

  if (!projectId) return <EmptyState title="Choose a project" description="Testing is configured per application within a project." />;

  const toggle = (key: string) => {
    if (!draft) return;
    const next = new Set(effective);
    if (next.has(key)) next.delete(key); else next.add(key);
    setDraft({ ...draft, mode: 'custom', categories: [...next] });
  };
  const setAll = (all: boolean) => draft && taxonomy && setDraft({
    ...draft, mode: 'custom', categories: all ? taxonomy.categories.map(c => c.key) : []
  });
  const dirty = JSON.stringify(draft) !== JSON.stringify(profile);
  const groups = taxonomy ? [...new Set(taxonomy.categories.map(c => c.group))] : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Testing"
        description="What to test, for every discovered form, and when to run it. Generation and execution need no AI model."
        actions={applications.length > 0 ? <ApplicationPicker applications={applications} value={applicationId} onChange={setApplicationId} /> : undefined}
      />
      {error ? <ErrorNotice error={error} /> : null}
      {loadingApps ? <Spinner label="Loading applications" /> : null}
      {!loadingApps && applications.length === 0 ? (
        <EmptyState title="No applications" description="Add an application and discover it first." action={<Link className="btn-primary" to="/applications">Applications</Link>} />
      ) : null}

      {applicationId && draft && taxonomy ? (
        <Card
          title="Testing configuration"
          description="A mode is a preset. Choosing categories by hand switches to Custom. Within a category every applicable test is generated; nothing is capped."
          actions={can(Permissions.applicationWrite) ? (
            <button type="button" className="btn-primary btn-sm" disabled={!dirty || save.isPending} onClick={() => save.mutate(draft)}>
              {save.isPending ? 'Saving…' : 'Save configuration'}
            </button>
          ) : undefined}
        >
          <fieldset className="mb-5">
            <legend className="label mb-2">Testing mode</legend>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              {MODES.map(mode => (
                <label key={mode.key} className={`rounded-lg border p-3 text-sm cursor-pointer ${draft.mode.toLowerCase() === mode.key.toLowerCase() ? 'border-brand bg-brand-light' : 'border-line'}`}>
                  <input type="radio" name="testing-mode" className="mr-2" checked={draft.mode.toLowerCase() === mode.key.toLowerCase()}
                    onChange={() => setDraft({ ...draft, mode: mode.key, categories: mode.key === 'custom' ? [...effective] : draft.categories })} />
                  <span className="font-semibold">{mode.label}</span>
                  <span className="block text-xs text-ink-muted mt-1">{mode.description}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <legend className="label">Test categories ({effective.size} of {taxonomy.categories.length})</legend>
              <button type="button" className="btn-secondary btn-sm" onClick={() => setAll(true)}>Select all</button>
              <button type="button" className="btn-secondary btn-sm" onClick={() => setAll(false)}>Deselect all</button>
            </div>
            {groups.map(group => (
              <div key={group} className="mb-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle mb-1">{group}</h3>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {taxonomy.categories.filter(c => c.group === group).map(category => (
                    <label key={category.key} className="flex items-start gap-2 text-sm rounded border border-line p-2">
                      <input type="checkbox" checked={effective.has(category.key)} onChange={() => toggle(category.key)} aria-describedby={`cat-${category.key}`} />
                      <span>
                        <span className="font-medium">{category.name}</span>{' '}
                        {category.automation !== 'automated' ? <StatusBadge status={category.automation === 'human' ? 'review' : 'partiallyCompleted'} title={category.automation} /> : null}
                        <span id={`cat-${category.key}`} className="block text-xs text-ink-muted">{category.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </fieldset>

          <div className="grid gap-4 md:grid-cols-3 mt-4">
            <fieldset>
              <legend className="label mb-1">Browsers</legend>
              {['Chromium', 'Firefox', 'Webkit'].map(browser => (
                <label key={browser} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={draft.browsers.some(b => b.toLowerCase() === browser.toLowerCase())}
                    onChange={e => setDraft({ ...draft, browsers: e.target.checked ? [...draft.browsers, browser.toLowerCase()] : draft.browsers.filter(b => b.toLowerCase() !== browser.toLowerCase()) })} />
                  {browser}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend className="label mb-1">Viewports</legend>
              {draft.viewports.map((viewport, i) => (
                <div key={viewport.name} className="flex items-center gap-2 text-sm mb-1">
                  <span className="w-16">{viewport.name}</span>
                  <input className="input w-20" aria-label={`${viewport.name} width`} type="number" min={200} max={4000} value={viewport.width}
                    onChange={e => setDraft({ ...draft, viewports: draft.viewports.map((v, j) => j === i ? { ...v, width: Number(e.target.value) } : v) })} />
                  ×
                  <input className="input w-20" aria-label={`${viewport.name} height`} type="number" min={200} max={4000} value={viewport.height}
                    onChange={e => setDraft({ ...draft, viewports: draft.viewports.map((v, j) => j === i ? { ...v, height: Number(e.target.value) } : v) })} />
                </div>
              ))}
            </fieldset>
            <fieldset className="space-y-2 text-sm">
              <legend className="label mb-1">Budgets and probes</legend>
              <label className="flex items-center gap-2">Page load ≤
                <input className="input w-24" type="number" min={100} value={draft.pageLoadBudgetMs} onChange={e => setDraft({ ...draft, pageLoadBudgetMs: Number(e.target.value) })} /> ms</label>
              <label className="flex items-center gap-2">Submission ≤
                <input className="input w-24" type="number" min={100} value={draft.submitBudgetMs} onChange={e => setDraft({ ...draft, submitBudgetMs: Number(e.target.value) })} /> ms</label>
              <label className="flex items-center gap-2">Visual threshold
                <input className="input w-20" type="number" min={0} max={100} step={0.1} value={draft.visualThresholdPercent} onChange={e => setDraft({ ...draft, visualThresholdPercent: Number(e.target.value) })} /> %</label>
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={draft.allowSafeSecurityProbes} onChange={e => setDraft({ ...draft, allowSafeSecurityProbes: e.target.checked })} />
                <span>Allow safe reflection probes <span className="block text-xs text-ink-muted">An inert marker element typed into text fields. No script. Turn off if the security scope forbids probing.</span></span>
              </label>
            </fieldset>
          </div>

          <details className="mt-4">
            <summary className="text-sm font-medium cursor-pointer">Coverage weights</summary>
            <p className="text-xs text-ink-muted my-2">How much each category counts towards a form's coverage score. 0 leaves it out of the score. A category that does not apply to a form never counts against it.</p>
            <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {taxonomy.categories.map(c => (
                <label key={c.key} className="text-xs flex items-center gap-1">
                  <span className="w-24 truncate" title={c.name}>{c.name}</span>
                  <input className="input w-14" type="number" min={0} max={10} value={draft.weights[c.key] ?? 1}
                    onChange={e => setDraft({ ...draft, weights: { ...draft.weights, [c.key]: Number(e.target.value) } })} />
                </label>
              ))}
            </div>
          </details>
        </Card>
      ) : applicationId && loadingProfile ? <Spinner label="Loading configuration" /> : null}

      {applicationId ? (
        <Card
          title={`Discovered forms (${forms.length})`}
          description="Every form discovery found, with its fields. Generation designs a suite for each one."
          actions={can(Permissions.testGenerate) ? (
            <button type="button" className="btn-primary btn-sm" disabled={generate.isPending || forms.length === 0 || dirty}
              title={dirty ? 'Save the configuration first' : undefined} onClick={() => generate.mutate()}>
              {generate.isPending ? 'Generating…' : 'Generate tests'}
            </button>
          ) : undefined}
        >
          {loadingForms ? <Spinner label="Loading forms" /> : forms.length === 0 ? (
            <EmptyState title="No forms yet" description="Run discovery on this application. Every form it finds, with its fields and their limits, appears here." />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Form</th><th>Page</th><th>Fields</th><th>Required</th><th>Dependencies</th><th>Kind</th><th>Changed</th></tr></thead>
                <tbody>
                  {forms.map(form => (
                    <tr key={form.id}>
                      <td>{form.name}</td>
                      <td className="font-mono text-xs">{form.route}</td>
                      <td>{form.fieldCount}</td>
                      <td>{form.requiredFieldCount}</td>
                      <td>{form.dependencyCount}</td>
                      <td>{form.isMultiStep ? 'Wizard' : form.method.toUpperCase()}{!form.hasCsrfToken && form.method !== 'get' ? ' · no token' : ''}</td>
                      <td className="text-xs">{form.changedAt ? new Date(form.changedAt).toLocaleString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {generation ? (
            <div className="mt-4 rounded-lg border border-line p-4 text-sm" role="status">
              <p className="font-semibold">
                {generation.testsCreated} created, {generation.testsUpdated} updated, {generation.testsUnchanged} unchanged,
                {' '}{generation.testsDeprecated} deprecated across {generation.forms} form(s). {generation.gaps} gap(s), {generation.humanTasks} human verification task(s), {generation.findings} finding(s).
              </p>
              <p className="text-ink-muted text-xs mt-1">{generation.engine}. AI used: {generation.usedAi ? 'yes' : 'no'}.</p>
              <div className="table-wrap mt-3">
                <table className="table">
                  <thead><tr><th>Form</th><th>Tests</th><th>Gaps</th><th>Human</th><th>Categories</th><th>Not applicable</th></tr></thead>
                  <tbody>
                    {generation.perForm.map(form => (
                      <tr key={form.formId}>
                        <td>{form.name}</td><td>{form.tests}</td><td>{form.gaps}</td><td>{form.humanTasks}</td>
                        <td className="text-xs">{Object.entries(form.testsByCategory).map(([k, v]) => `${categoryLabel(k)} ${v}`).join(' · ')}</td>
                        <td className="text-xs text-ink-muted">{form.notApplicable.map(categoryLabel).join(', ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {generation.warnings.length > 0 ? (
                <ul className="mt-3 list-disc pl-5 text-xs text-warn">{generation.warnings.slice(0, 20).map(w => <li key={w}>{w}</li>)}</ul>
              ) : null}
            </div>
          ) : null}
        </Card>
      ) : null}

      {applicationId && can(Permissions.executionRun) ? (
        <Card title="Run" description="The same tests, selected differently. Every run is repeatable and records its evidence.">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-sm flex items-center gap-2">Browser
              <select className="input" value={runBrowser} onChange={e => setRunBrowser(e.target.value)}>
                <option>Chromium</option><option>Firefox</option><option>Webkit</option>
              </select>
            </label>
            <button type="button" className="btn-primary btn-sm" disabled={run.isPending} onClick={() => run.mutate({ mode: 'all' })}>Run all</button>
            <button type="button" className="btn-secondary btn-sm" disabled={run.isPending} onClick={() => run.mutate({ mode: 'failed' })}>Run failed</button>
            <button type="button" className="btn-secondary btn-sm" disabled={run.isPending} onClick={() => run.mutate({ mode: 'impacted' })}>Run impacted by changes</button>
            <button type="button" className="btn-secondary btn-sm" disabled={run.isPending} onClick={() => run.mutate({ mode: 'regression' })}>Run regression suite</button>
            <button type="button" className="btn-secondary btn-sm" disabled={run.isPending || effective.size === 0}
              onClick={() => run.mutate({ mode: 'selection', categories: [...effective] })}>Run selected categories</button>
          </div>
          {lastRun ? (
            <p className="mt-3 text-sm" role="status">
              {lastRun.selected} test(s) selected. {lastRun.explanation}{' '}
              {lastRun.testRunId ? <Link className="text-brand underline" to={`/runs/${lastRun.testRunId}`}>Open the run</Link> : null}
            </p>
          ) : null}
          <p className="mt-2 text-xs text-ink-muted">Schedules (daily, weekly) and CI runs use the same tests: see Schedules and the CLI's <code>qanxt run</code>.</p>
        </Card>
      ) : null}
    </div>
  );
}
