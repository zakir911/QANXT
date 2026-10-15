import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, apiUpload } from '../api/client';
import { Permissions, useAuth } from '../lib/auth';
import { useProject } from '../lib/project';
import { Card, EmptyState, ErrorNotice, Metric, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { ApplicationPicker, CATEGORY_LABEL, categoryLabel, useApplications, useSelectedApplication, type FormSummary } from '../lib/quality';

interface RepositoryItem {
  id: string; reference: string; name: string; category?: string | null; technique?: string | null; lifecycle: string;
  automation: string; priority: string; tags: string; applicationFormId?: string | null; fieldKey?: string | null;
  source: string; version: number; lastStatus?: string | null; lastExecutedAt?: string | null;
  executionCount: number; passCount: number; failCount: number;
}

interface ImportResult {
  format: string; rows: number; imported: number; automatable: number; humanVerification: number; skipped: number;
  tests: { row: number; title: string; reference: string; automatable: boolean; reason: string; testCaseId: string }[];
  problems: string[];
}

interface Version { version: number; changeSummary: string; at: string }

const LIFECYCLES = ['Draft', 'Active', 'Disabled', 'Deprecated', 'Archived'];
const PAGE = 200;

/**
 * The test repository: every test, whatever made it — generated, imported, recorded or
 * written by hand — searchable, filterable, versioned, and changeable in bulk.
 */
export default function RepositoryPage() {
  const { can } = useAuth();
  const { projectId } = useProject();
  const queryClient = useQueryClient();
  const { data: applications = [] } = useApplications();
  const [applicationId, setApplicationId] = useSelectedApplication(applications);
  const [filters, setFilters] = useState({ category: '', lifecycle: '', automation: '', formId: '', lastStatus: '', search: '' });
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tag, setTag] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [imported, setImported] = useState<ImportResult | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const [compare, setCompare] = useState<{ from: number; to: number } | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams({ projectId: projectId ?? '', skip: String(page * PAGE), take: String(PAGE) });
    if (applicationId) params.set('applicationId', applicationId);
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    return params.toString();
  }, [projectId, applicationId, filters, page]);

  const { data, isLoading } = useQuery({
    queryKey: ['repository', query],
    queryFn: () => apiRequest<{ total: number; items: RepositoryItem[]; facets?: { lifecycle: Record<string, number>; lastStatus: { passed: number; failed: number; neverRun: number } } }>(`/api/v1/test-repository?${query}`),
    enabled: Boolean(projectId)
  });
  const { data: forms = [] } = useQuery({
    queryKey: ['forms', applicationId],
    queryFn: () => apiRequest<FormSummary[]>(`/api/v1/applications/${applicationId}/forms`),
    enabled: Boolean(applicationId)
  });
  const { data: versions = [] } = useQuery({
    queryKey: ['versions', history],
    queryFn: () => apiRequest<Version[]>(`/api/v1/test-cases/${history}/versions`),
    enabled: Boolean(history)
  });
  const { data: comparison } = useQuery({
    queryKey: ['compare', history, compare],
    queryFn: () => apiRequest<{ differences: string[] }>(`/api/v1/test-cases/${history}/versions/compare?from=${compare!.from}&to=${compare!.to}`),
    enabled: Boolean(history && compare)
  });

  const refresh = async (text?: string) => {
    setError(null);
    setMessage(text ?? null);
    setSelected(new Set());
    await queryClient.invalidateQueries({ queryKey: ['repository'] });
  };
  const bulk = useMutation({
    mutationFn: (lifecycle: string) => apiRequest<{ changed: number }>('/api/v1/test-cases/bulk/lifecycle', { method: 'POST', body: { projectId, testCaseIds: [...selected], lifecycle } }),
    onSuccess: (result, lifecycle) => refresh(`${result.changed} test(s) moved to ${lifecycle}.`), onError: setError
  });
  const bulkTag = useMutation({
    mutationFn: (remove: boolean) => apiRequest<{ changed: number }>('/api/v1/test-cases/bulk/tags', { method: 'POST', body: { projectId, testCaseIds: [...selected], tag, remove } }),
    onSuccess: result => refresh(`${result.changed} test(s) re-tagged.`), onError: setError
  });
  const runSelected = useMutation({
    mutationFn: () => apiRequest<{ id: string }>('/api/v1/testruns', { method: 'POST', body: { projectId, testCaseIds: [...selected], name: 'Selected from repository' } }),
    onSuccess: run => refresh(`Run started: ${run.id}`), onError: setError
  });
  const duplicate = useMutation({
    mutationFn: (id: string) => apiRequest<{ testCaseId: string }>(`/api/v1/test-cases/${id}/duplicate`, { method: 'POST', body: {} }),
    onSuccess: () => refresh('Duplicated as a draft.'), onError: setError
  });
  const importFile = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return apiUpload<ImportResult>(`/api/v1/applications/${applicationId}/manual-tests/import`, form);
    },
    onSuccess: async result => { setImported(result); await refresh(); }, onError: setError
  });

  if (!projectId) return <EmptyState title="Choose a project" description="The repository belongs to a project." />;
  const items = data?.items ?? [];
  const mayWrite = can(Permissions.testWrite);
  const allSelected = items.length > 0 && items.every(i => selected.has(i.id));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Test repository"
        description="Every test, whatever made it. Lifecycle decides what runs: only Active tests are part of Run all."
        actions={applications.length > 0 ? <ApplicationPicker applications={applications} value={applicationId} onChange={setApplicationId} /> : undefined}
      />
      {error ? <ErrorNotice error={error} /> : null}
      {message ? <p role="status" className="text-sm">{message}</p> : null}

      {data?.facets ? (() => {
        const facets = data.facets;
        const total = Object.values(facets.lifecycle).reduce((a, b) => a + b, 0);
        const pick = (next: Partial<typeof filters>) => { setPage(0); setFilters({ ...filters, lifecycle: '', lastStatus: '', ...next }); };
        const isOnly = (lifecycle: string, lastStatus: string) => filters.lifecycle === lifecycle && filters.lastStatus === lastStatus;
        return (
          <div className="grid gap-4 sm:grid-cols-4 lg:grid-cols-8">
            <Metric label="All tests" value={total} onClick={() => pick({})} active={isOnly('', '')} />
            {LIFECYCLES.map(l => (
              <Metric key={l} label={l} value={facets.lifecycle[l] ?? 0} tone={l === 'Active' ? 'good' : 'neutral'}
                      onClick={() => pick(isOnly(l, '') ? {} : { lifecycle: l })} active={isOnly(l, '')} />
            ))}
            <Metric label="Last run passed" value={facets.lastStatus.passed} tone="good" onClick={() => pick(isOnly('Active', 'Passed') ? {} : { lifecycle: 'Active', lastStatus: 'Passed' })} active={isOnly('Active', 'Passed')} />
            <Metric label="Last run failed" value={facets.lastStatus.failed} tone={facets.lastStatus.failed ? 'bad' : 'neutral'} onClick={() => pick(isOnly('Active', 'Failed') ? {} : { lifecycle: 'Active', lastStatus: 'Failed' })} active={isOnly('Active', 'Failed')} />
          </div>
        );
      })() : null}

      <Card title="Filter">
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6 text-sm">
          <input className="input" placeholder="Search name, reference, tag" aria-label="Search" value={filters.search} onChange={e => { setPage(0); setFilters({ ...filters, search: e.target.value }); }} />
          <select className="input" aria-label="Category" value={filters.category} onChange={e => { setPage(0); setFilters({ ...filters, category: e.target.value }); }}>
            <option value="">All categories</option>
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select className="input" aria-label="Lifecycle" value={filters.lifecycle} onChange={e => { setPage(0); setFilters({ ...filters, lifecycle: e.target.value }); }}>
            <option value="">All lifecycles</option>
            {LIFECYCLES.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          <select className="input" aria-label="Automation" value={filters.automation} onChange={e => { setPage(0); setFilters({ ...filters, automation: e.target.value }); }}>
            <option value="">Automated and human</option>
            <option value="Automated">Automated</option>
            <option value="HumanVerification">Human verification</option>
            <option value="PartiallyAutomated">Partially automated</option>
          </select>
          <select className="input" aria-label="Form" value={filters.formId} onChange={e => { setPage(0); setFilters({ ...filters, formId: e.target.value }); }}>
            <option value="">All forms</option>
            {forms.map(f => <option key={f.id} value={f.id}>{f.name} ({f.route})</option>)}
          </select>
          <select className="input" aria-label="Last result" value={filters.lastStatus} onChange={e => { setPage(0); setFilters({ ...filters, lastStatus: e.target.value }); }}>
            <option value="">Any last result</option>
            {['Passed', 'Failed', 'Error', 'Blocked', 'Skipped'].map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </Card>

      {mayWrite ? (
        <Card title={`Selected: ${selected.size}`} description="Bulk changes apply to the selected tests.">
          <div className="flex flex-wrap items-center gap-2">
            {LIFECYCLES.map(l => (
              <button key={l} type="button" className="btn-secondary btn-sm" disabled={selected.size === 0 || bulk.isPending} onClick={() => bulk.mutate(l)}>
                {l === 'Active' ? 'Activate' : l === 'Disabled' ? 'Disable' : `Mark ${l.toLowerCase()}`}
              </button>
            ))}
            <input className="input w-36" placeholder="Tag" aria-label="Tag" value={tag} onChange={e => setTag(e.target.value)} />
            <button type="button" className="btn-secondary btn-sm" disabled={selected.size === 0 || !tag} onClick={() => bulkTag.mutate(false)}>Add tag</button>
            <button type="button" className="btn-secondary btn-sm" disabled={selected.size === 0 || !tag} onClick={() => bulkTag.mutate(true)}>Remove tag</button>
            {can(Permissions.executionRun) ? (
              <button type="button" className="btn-primary btn-sm" disabled={selected.size === 0 || runSelected.isPending} onClick={() => runSelected.mutate()}>Run selected</button>
            ) : null}
          </div>
        </Card>
      ) : null}

      {isLoading ? <Spinner label="Loading tests" /> : null}
      {data ? (
        <Card title={`${data.total} test(s)`}>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th><input type="checkbox" aria-label="Select all on this page" checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(items.map(i => i.id)))} /></th>
                  <th>Test</th><th>Category</th><th>Lifecycle</th><th>Automation</th><th>Source</th><th>v</th><th>Last result</th><th>Runs</th><th></th>
                </tr>
              </thead>
              <tbody>
                {items.map(item => (
                  <tr key={item.id}>
                    <td><input type="checkbox" aria-label={`Select ${item.reference}`} checked={selected.has(item.id)}
                      onChange={() => { const next = new Set(selected); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); setSelected(next); }} /></td>
                    <td><Link className="text-brand underline" to={`/tests/${item.id}`}>{item.reference}</Link> <span className="text-xs">{item.name}</span></td>
                    <td className="text-xs">{item.category ? categoryLabel(item.category.charAt(0).toLowerCase() + item.category.slice(1)) : '—'}{item.technique ? <span className="block text-ink-muted">{item.technique}</span> : null}</td>
                    <td className="text-xs">{item.lifecycle}</td>
                    <td className="text-xs">{item.automation === 'HumanVerification' ? 'Human' : item.automation}</td>
                    <td className="text-xs">{item.source}</td>
                    <td>{item.version}</td>
                    <td>{item.lastStatus ? <StatusBadge status={String(item.lastStatus)} /> : <span className="text-xs text-ink-muted">not run</span>}</td>
                    <td className="text-xs">{item.passCount}/{item.executionCount}</td>
                    <td className="whitespace-nowrap space-x-1">
                      {mayWrite ? <button type="button" className="btn-secondary btn-sm" onClick={() => duplicate.mutate(item.id)}>Duplicate</button> : null}
                      <button type="button" className="btn-secondary btn-sm" aria-expanded={history === item.id} onClick={() => { setHistory(history === item.id ? null : item.id); setCompare(null); }}>History</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-2 mt-3 text-sm">
            <button type="button" className="btn-secondary btn-sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
            <span>Page {page + 1} of {Math.max(1, Math.ceil(data.total / PAGE))}</span>
            <button type="button" className="btn-secondary btn-sm" disabled={(page + 1) * PAGE >= data.total} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        </Card>
      ) : null}

      {history ? (
        <Card title="Version history">
          <ul className="text-sm space-y-1">
            {versions.map(v => (
              <li key={`${v.version}-${v.at}`} className="flex items-center gap-2">
                <span className="font-mono">v{v.version}</span> <span>{v.changeSummary}</span> <span className="text-xs text-ink-muted">{new Date(v.at).toLocaleString()}</span>
                {versions.length > 1 && v.version !== versions[versions.length - 1]!.version ? (
                  <button type="button" className="btn-secondary btn-sm" onClick={() => setCompare({ from: v.version, to: versions[versions.length - 1]!.version })}>Compare with current</button>
                ) : null}
              </li>
            ))}
          </ul>
          {comparison ? (
            <div className="mt-3 text-sm">
              <h3 className="label">Differences</h3>
              {comparison.differences.length === 0 ? <p>None.</p> : <ul className="list-disc pl-5 text-xs">{comparison.differences.map(d => <li key={d}>{d}</li>)}</ul>}
            </div>
          ) : null}
        </Card>
      ) : null}

      {mayWrite && applicationId ? (
        <Card title="Import manual tests" description="CSV, TSV, Excel (.xlsx), JSON or structured text. Columns: Title, Steps, Expected result, and optionally ID, Preconditions, Priority, Category, Tags.">
          <label className="btn-primary btn-sm cursor-pointer inline-block">
            {importFile.isPending ? 'Importing…' : 'Choose a file'}
            <input type="file" className="sr-only" accept=".csv,.tsv,.xlsx,.json,.txt,.md"
              onChange={e => { const file = e.target.files?.[0]; if (file) importFile.mutate(file); e.target.value = ''; }} />
          </label>
          <p className="text-xs text-ink-muted mt-2">
            Steps a machine can perform (Open /path · Enter "value" in Label · Choose "option" in Label · Click Button · Verify "text" is shown) become an automated draft.
            Anything else becomes a human verification task with its steps intact. Imported tests start as drafts; activate them to include them in runs.
          </p>
          {imported ? (
            <div className="mt-3 text-sm" role="status">
              <p className="font-semibold">{imported.imported} imported from {imported.format}: {imported.automatable} automatable, {imported.humanVerification} for human verification{imported.skipped ? `, ${imported.skipped} skipped` : ''}.</p>
              <ul className="list-disc pl-5 text-xs mt-1">
                {imported.tests.map(t => <li key={t.testCaseId}><Link className="text-brand underline" to={`/tests/${t.testCaseId}`}>{t.reference}</Link> {t.title} — {t.automatable ? 'automation' : 'human verification'}: {t.reason}</li>)}
              </ul>
              {imported.problems.length > 0 ? <ul className="list-disc pl-5 text-xs text-warn mt-1">{imported.problems.map(p => <li key={p}>{p}</li>)}</ul> : null}
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
