import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../api/client';
import { useProject } from '../lib/project';
import { Card, EmptyState, ErrorNotice, FilterNote, Metric, PageHeader, Spinner, StatusBadge, useMetricFilter } from '../components/ui';
import {
  ApplicationPicker, categoryLabel, percent, useApplications, useSelectedApplication,
  type ApplicationCoverage, type CategoryCoverage, type FormCoverage
} from '../lib/quality';

const GAP_STATUS_LABEL: Record<string, string> = {
  'not-covered': 'Not covered', 'partially-covered': 'Partially covered', 'human-required': 'Human verification',
  unsupported: 'Unsupported here', unknown: 'Unknown'
};

/**
 * Coverage as measured.
 *
 * Every number on this page is counted by the API from tests that exist and executions that
 * happened. Coverage and pass rate are shown separately because they answer different
 * questions — "was it tested?" and "did it work?" — and gaps are listed with the reason for
 * each, so "not 100%" always comes with what is missing and why.
 */
type FormFilter = 'failed' | 'notRun' | 'belowFull' | 'gaps';
const FORM_FILTER_LABEL: Record<FormFilter, string> = { failed: 'Forms with failing tests', notRun: 'Forms with tests not yet run', belowFull: 'Forms below a 100% pass rate', gaps: 'Forms with gaps' };

export default function CoveragePage() {
  const { projectId } = useProject();
  const { data: applications = [], isLoading: loadingApps } = useApplications();
  const [applicationId, setApplicationId] = useSelectedApplication(applications);
  const [gapFilter, setGapFilter] = useState('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const formFilter = useMetricFilter<FormFilter>();

  const { data: coverage, isLoading, error, refetch } = useQuery({
    queryKey: ['coverage', applicationId],
    queryFn: () => apiRequest<ApplicationCoverage>(`/api/v1/applications/${applicationId}/coverage`),
    enabled: Boolean(applicationId),
    refetchInterval: 15_000
  });

  const gaps = useMemo(() => (coverage?.gaps ?? []).filter(g => gapFilter === 'all' || g.status === gapFilter), [coverage, gapFilter]);

  if (!projectId) return <EmptyState title="Choose a project" description="Coverage is measured per application." />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Coverage"
        description="Measured from what ran, never estimated. A category that does not apply to a form is N/A and does not count against it."
        actions={applications.length > 0 ? <ApplicationPicker applications={applications} value={applicationId} onChange={setApplicationId} /> : undefined}
      />
      {loadingApps || isLoading ? <Spinner label="Measuring coverage" /> : null}
      {error ? <ErrorNotice error={error} onRetry={() => void refetch()} /> : null}

      {coverage ? (
        <>
          <p className="text-sm text-ink-muted" role="status">{coverage.statement}</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Metric label="Coverage" value={percent(coverage.overallCoveragePercent)} tone={tone(coverage.overallCoveragePercent)}
              hint="Weighted share of applicable tests that have run, with each open gap counted against it."
              onClick={() => formFilter.set(null)} active={formFilter.filter === null} />
            <Metric label="Pass rate" value={percent(coverage.passPercent)} tone={tone(coverage.passPercent)} hint="Of the tests that ran, how many passed. Shows forms below 100%."
              onClick={() => formFilter.toggle('belowFull')} active={formFilter.is('belowFull')} />
            <Metric label="Tests" value={`${coverage.surface.executedTests} / ${coverage.surface.testableTests}`} hint="Executed of active tests. Shows forms with tests not yet run."
              onClick={() => formFilter.toggle('notRun')} active={formFilter.is('notRun')} />
            <Metric label="Failed" value={coverage.surface.failedTests} tone={coverage.surface.failedTests > 0 ? 'bad' : 'good'} hint="Shows forms with failing tests."
              onClick={() => formFilter.toggle('failed')} active={formFilter.is('failed')} />
            <Metric label="Gaps" value={coverage.gaps.length} tone={coverage.gaps.length ? 'warn' : 'good'} hint="Shows forms with gaps, and the gap list."
              onClick={() => formFilter.toggle('gaps')} active={formFilter.is('gaps')} />
          </div>
          <FilterNote label={formFilter.filter === null ? null : FORM_FILTER_LABEL[formFilter.filter]} onClear={() => formFilter.set(null)} />

          <Card title="Surface" description="What exists, what can be tested, what was, and what cannot be here.">
            <dl className="kv grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4 text-sm">
              <div><dt>Pages discovered</dt><dd>{coverage.surface.discoveredPages}</dd></div>
              <div><dt>Forms discovered</dt><dd>{coverage.surface.discoveredForms}</dd></div>
              <div><dt>Fields discovered</dt><dd>{coverage.surface.discoveredFields}</dd></div>
              <div><dt>API endpoints observed</dt><dd>{coverage.surface.discoveredEndpoints}</dd></div>
              <div><dt>Partially covered</dt><dd>{coverage.surface.partiallyCovered}</dd></div>
              <div><dt>Not covered</dt><dd>{coverage.surface.notCovered}</dd></div>
              <div><dt>Boundaries unknown</dt><dd>{coverage.surface.unknownBoundaries}</dd></div>
              <div><dt>Need a person</dt><dd><Link className="text-brand underline" to="/human-tasks">{coverage.surface.humanRequired}</Link></dd></div>
              <div><dt>Unsupported here</dt><dd>{coverage.surface.unsupported}</dd></div>
            </dl>
          </Card>

          <Card title="Coverage by dimension">
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Dimension</th><th>Discovered</th><th>With tests</th><th>Executed</th><th>What it means</th></tr></thead>
                <tbody>
                  {coverage.dimensions.map(d => (
                    <tr key={d.dimension}><td className="font-medium">{d.dimension}</td><td>{d.discovered}</td><td>{d.tested}</td><td>{d.executed}</td><td className="text-xs text-ink-muted">{d.detail}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Coverage by testing category">
            <CategoryTable categories={coverage.categories} />
          </Card>

          <section aria-label="Forms" className="grid gap-4 lg:grid-cols-2">
            {coverage.forms.filter(form => formFilter.filter === null
                || formFilter.filter === 'failed' && form.failed > 0
                || formFilter.filter === 'notRun' && form.notRun > 0
                || formFilter.filter === 'belowFull' && form.passPercent !== null && form.passPercent < 100
                || formFilter.filter === 'gaps' && form.gaps > 0).map(form => (
              <FormCard key={form.formId} form={form} open={expanded === form.formId} onToggle={() => setExpanded(expanded === form.formId ? null : form.formId)} />
            ))}
          </section>

          <Card
            title={`Gaps (${coverage.gaps.length})`}
            description="Everything that could not be tested automatically, and why. Nothing is left out silently."
            actions={
              <select className="input" aria-label="Filter gaps" value={gapFilter} onChange={e => setGapFilter(e.target.value)}>
                <option value="all">All</option>
                {Object.entries(GAP_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            }
          >
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Status</th><th>Form</th><th>Field</th><th>Category</th><th>Missing</th><th>Why</th><th>What to do</th></tr></thead>
                <tbody>
                  {gaps.map(g => (
                    <tr key={g.id}>
                      <td><StatusBadge status={g.status === 'unsupported' ? 'skipped' : g.status === 'human-required' ? 'review' : 'partiallyCompleted'} title={GAP_STATUS_LABEL[g.status]} /> <span className="text-xs">{GAP_STATUS_LABEL[g.status]}</span></td>
                      <td className="text-xs">{g.formName ?? 'Application'}</td>
                      <td className="text-xs font-mono">{g.fieldKey ?? '—'}</td>
                      <td className="text-xs">{categoryLabel(g.category)}</td>
                      <td className="text-xs">{g.missing}</td>
                      <td className="text-xs text-ink-muted">{g.reason}</td>
                      <td className="text-xs">{g.recommendedAction}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function tone(value: number | null | undefined): 'good' | 'warn' | 'bad' | 'neutral' {
  if (value === null || value === undefined) return 'neutral';
  return value >= 90 ? 'good' : value >= 60 ? 'warn' : 'bad';
}

function FormCard({ form, open, onToggle }: { form: FormCoverage; open: boolean; onToggle(): void }) {
  const counted = form.categories.filter(c => c.status !== 'not-selected' && c.status !== 'n/a');
  return (
    <Card
      title={`Form: ${form.name}`}
      description={<span className="font-mono text-xs">{form.route}</span>}
      actions={<button type="button" className="btn-secondary btn-sm" aria-expanded={open} onClick={onToggle}>{open ? 'Hide categories' : 'All categories'}</button>}
    >
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-sm">
        <div><dt className="text-ink-muted inline">Fields: </dt><dd className="inline font-semibold">{form.fields}</dd></div>
        <div><dt className="text-ink-muted inline">Generated tests: </dt><dd className="inline font-semibold">{form.generated}</dd></div>
        <div><dt className="text-ink-muted inline">Executed: </dt><dd className="inline font-semibold">{form.executed}</dd></div>
        <div><dt className="text-ink-muted inline">Passed: </dt><dd className="inline font-semibold text-good">{form.passed}</dd></div>
        <div><dt className="text-ink-muted inline">Failed: </dt><dd className={`inline font-semibold ${form.failed > 0 ? 'text-bad' : ''}`}>{form.failed}</dd></div>
        <div><dt className="text-ink-muted inline">Not run: </dt><dd className="inline font-semibold">{form.notRun}</dd></div>
      </dl>
      <ul className="mt-3 grid grid-cols-2 gap-x-4 text-sm font-mono">
        {counted.filter(c => open || c.generated > 0).map(c => (
          <li key={c.category} className="flex justify-between">
            <span>{categoryLabel(c.category)}:</span>
            <span>{c.executed}/{c.generated}{c.openGaps > 0 ? ` (+${c.openGaps} gap)` : ''}</span>
          </li>
        ))}
      </ul>
      {open ? (
        <p className="mt-2 text-xs text-ink-muted">
          N/A: {form.categories.filter(c => c.status === 'n/a').map(c => categoryLabel(c.category)).join(', ') || 'none'}.
          {' '}Not selected: {form.categories.filter(c => c.status === 'not-selected').map(c => categoryLabel(c.category)).join(', ') || 'none'}.
        </p>
      ) : null}
      <p className="mt-3 text-sm">
        <span className="font-semibold">Coverage: {percent(form.coveragePercent)}</span>
        {' · '}Pass rate: {percent(form.passPercent)}
        {' · '}Gaps: {form.gaps}
        {' · '}Human verification: {form.humanTasksOpen} open of {form.humanTasks}
        {' · '}Findings: {form.findings}
      </p>
    </Card>
  );
}

function CategoryTable({ categories }: { categories: CategoryCoverage[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Category</th><th>Status</th><th>Generated</th><th>Executed</th><th>Passed</th><th>Failed</th><th>Open gaps</th><th>Human</th><th>Weight</th><th>Coverage</th></tr></thead>
        <tbody>
          {categories.map(c => (
            <tr key={c.category}>
              <td>{categoryLabel(c.category)}</td>
              <td className="text-xs">{c.status}</td>
              <td>{c.generated}</td><td>{c.executed}</td><td>{c.passed}</td>
              <td className={c.failed > 0 ? 'text-bad font-semibold' : ''}>{c.failed}</td>
              <td>{c.openGaps}</td><td>{c.humanTasks}</td><td>{c.weight}</td>
              <td>{c.coveragePercent === null ? 'N/A' : `${c.coveragePercent}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
