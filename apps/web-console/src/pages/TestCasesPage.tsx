import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../api/client';
import { Permissions, useAuth } from '../lib/auth';
import { useProject } from '../lib/project';
import { Card, EmptyState, ErrorNotice, PageHeader, ProviderNote, Spinner, StatusBadge, useDisclosedPanel } from '../components/ui';
import { formatDuration, formatRelative } from '../lib/format';

interface TestCaseRow {
  id: string; reference: string; name: string; objective: string;
  priority: string; risk: string; tags: string; source: string;
  isEnabled: boolean; version: number; testSuiteId: string; suiteName: string;
  executionCount: number; passCount: number; failCount: number; healCount: number;
  flakinessScore: number; lastExecutedAt?: string; lastStatus?: string;
  averageDurationMs: number; stepCount: number; isAiGenerated: boolean;
}

interface ApplicationOption { id: string; name: string }

interface GenerationResult {
  testSuiteId: string; testSuiteName: string; casesCreated: number; stepsCreated: number;
  planSummary: string; provider: string; model: string; isLocalProvider: boolean;
  aiRequestId: string; promptTokens: number; completionTokens: number;
  estimatedCostUsd: number; warnings: string[];
}

export default function TestCasesPage() {
  const { can } = useAuth();
  const { projectId, project } = useProject();
  const queryClient = useQueryClient();
  const [generating, setGenerating] = useState(false);
  const panel = useDisclosedPanel('generate-tests', generating, () => { setGenerating(false); setError(null); });
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [runError, setRunError] = useState<unknown>(null);

  const { data: cases = [], isLoading } = useQuery({
    queryKey: ['testcases', projectId],
    queryFn: () => apiRequest<TestCaseRow[]>(`/api/v1/testcases?projectId=${projectId}`),
    enabled: Boolean(projectId)
  });

  const { data: applications = [] } = useQuery({
    queryKey: ['applications', projectId],
    queryFn: () => apiRequest<ApplicationOption[]>(`/api/v1/applications?projectId=${projectId}`),
    enabled: Boolean(projectId)
  });

  const generate = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest<GenerationResult>('/api/v1/testcases/generate', { method: 'POST', body }),
    onSuccess: async generated => {
      setResult(generated);
      setError(null);
      setGenerating(false);
      await queryClient.invalidateQueries({ queryKey: ['testcases'] });
    },
    onError: setError
  });

  const runAll = useMutation({
    mutationFn: () => apiRequest<{ id: string }>('/api/v1/testruns', {
      method: 'POST',
      body: { projectId, name: 'All enabled tests', parallelism: 2 }
    }),
    onSuccess: async () => {
      setRunError(null);
      await queryClient.invalidateQueries({ queryKey: ['testruns'] });
    },
    onError: setRunError
  });

  if (!projectId) {
    return (
      <Card>
        <EmptyState title="Select a project"
                    description="Test cases belong to a project. Choose one from the header."
                    action={<Link to="/projects" className="btn-primary">Go to projects</Link>} />
      </Card>
    );
  }

  const handleGenerate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    generate.mutate({
      applicationId: String(form.get('applicationId') ?? ''),
      suiteName: String(form.get('suiteName') ?? '') || null,
      requirement: String(form.get('requirement') ?? '') || null,
      maxScenarios: Number(form.get('maxScenarios') ?? 20)
    });
  };

  return (
    <>
      <PageHeader
        title="Test cases"
        description={`${cases.length} test case(s) in ${project?.name ?? 'this project'}.`}
        actions={
          <div className="flex gap-2">
            {can(Permissions.testGenerate) && (
              // Mounted while the panel is open so aria-expanded can say so (QA pass, ISSUE-003).
              <button type="button" className="btn-primary"
                      onClick={() => { setGenerating(!generating); setResult(null); setError(null); }} {...panel.triggerProps}>
                Generate tests
              </button>
            )}
            {can(Permissions.executionRun) && cases.length > 0 && (
              <button type="button" className="btn-secondary" disabled={runAll.isPending}
                      onClick={() => runAll.mutate()}>
                {runAll.isPending ? 'Starting…' : 'Run all'}
              </button>
            )}
          </div>
        }
      />

      {runError !== null && <div className="mb-4"><ErrorNotice error={runError} /></div>}
      {runAll.isSuccess && (
        <div className="mb-4 rounded-lg border border-good/25 bg-good-light px-4 py-3 text-sm text-good">
          Run started. <Link to={`/runs/${runAll.data.id}`} className="underline font-semibold">Watch it live</Link>.
        </div>
      )}

      {generating && (
        <Card title="Generate tests from the application model" {...panel.panelProps}
              description="Generation works only from pages and elements discovery actually observed, so the steps it produces reference real controls."
              className="mb-4">
          <form onSubmit={handleGenerate} className="grid gap-3.5 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="applicationId">Application</label>
              <select id="applicationId" name="applicationId" required className="input">
                <option value="">Choose an application…</option>
                {applications.map(app => <option key={app.id} value={app.id}>{app.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="suiteName">Suite name</label>
              <input id="suiteName" name="suiteName" className="input" placeholder="Regression" />
            </div>
            <div className="sm:col-span-2">
              <label className="label" htmlFor="requirement">Requirement or user story (optional)</label>
              <textarea id="requirement" name="requirement" rows={3} className="input"
                        placeholder="As a customer I can view my account statement and download it as a CSV file." />
              <p className="mt-1 text-xs text-ink-muted">
                Leave empty to cover the whole discovered application.
              </p>
            </div>
            <div>
              <label className="label" htmlFor="maxScenarios">Maximum scenarios</label>
              <input id="maxScenarios" name="maxScenarios" type="number" min={1} max={40}
                     defaultValue={20} className="input" />
            </div>

            {error !== null && <div className="sm:col-span-2"><ErrorNotice error={error} /></div>}

            <div className="sm:col-span-2 flex gap-2">
              <button type="submit" className="btn-primary" disabled={generate.isPending}>
                {generate.isPending ? 'Generating…' : 'Generate'}
              </button>
              <button type="button" className="btn-secondary" onClick={() => { setGenerating(false); setError(null); }}>
                Cancel
              </button>
            </div>
          </form>
        </Card>
      )}

      {result && (
        <Card title={`Generated ${result.casesCreated} test case(s)`} className="mb-4"
              actions={<button type="button" className="btn-secondary btn-sm" onClick={() => setResult(null)}>Dismiss</button>}>
          <p className="text-sm text-ink">{result.planSummary}</p>
          <p className="mt-1.5 text-sm text-ink-muted">
            {result.stepsCreated} step(s) in suite “{result.testSuiteName}”.
            {result.promptTokens > 0 && ` ${result.promptTokens + result.completionTokens} tokens, about $${result.estimatedCostUsd.toFixed(4)}.`}
          </p>
          <div className="mt-2"><ProviderNote provider={result.provider} model={result.model} isLocal={result.isLocalProvider} /></div>

          {result.warnings.length > 0 && (
            <div className="mt-3 rounded-lg border border-warn/25 bg-warn-light px-3 py-2">
              <p className="text-sm font-semibold text-warn">
                {result.warnings.length} scenario(s) were dropped because the engine could not run them:
              </p>
              <ul className="mt-1 space-y-0.5 text-xs text-warn/90 list-disc list-inside">
                {result.warnings.slice(0, 5).map(warning => <li key={warning}>{warning}</li>)}
              </ul>
            </div>
          )}
        </Card>
      )}

      {isLoading ? <Spinner label="Loading test cases" /> : cases.length === 0 ? (
        <Card>
          <EmptyState
            title="No test cases yet"
            description="Run discovery against an application, then generate tests from what it found. You can edit anything that is generated before running it."
            action={can(Permissions.testGenerate) && (
              <button type="button" className="btn-primary" onClick={() => setGenerating(true)} {...panel.triggerProps}>Generate tests</button>
            )}
          />
        </Card>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Reference</th><th>Name</th><th>Priority</th><th>Steps</th>
                <th>Last result</th><th>Pass / fail</th><th>Stability</th><th>Avg duration</th>
              </tr>
            </thead>
            <tbody>
              {cases.map(testCase => (
                <tr key={testCase.id}>
                  <td className="font-mono text-xs whitespace-nowrap">{testCase.reference}</td>
                  <td>
                    <Link to={`/tests/${testCase.id}`} className="font-medium text-brand hover:underline">
                      {testCase.name}
                    </Link>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {testCase.isAiGenerated && (
                        <span className="badge bg-info-light text-info">generated</span>
                      )}
                      {!testCase.isEnabled && <span className="badge bg-surface-sunken text-ink-muted">disabled</span>}
                      <span className="text-xs text-ink-subtle">{testCase.suiteName}</span>
                    </div>
                  </td>
                  <td><StatusBadge status={testCase.priority} /></td>
                  <td className="tabular-nums">{testCase.stepCount}</td>
                  <td>
                    {testCase.lastStatus
                      ? <><StatusBadge status={testCase.lastStatus} />
                          <div className="text-xs text-ink-subtle mt-0.5">{formatRelative(testCase.lastExecutedAt)}</div></>
                      : <span className="text-xs text-ink-subtle">never run</span>}
                  </td>
                  <td className="tabular-nums text-xs">
                    <span className="text-good">{testCase.passCount}</span>
                    {' / '}
                    <span className={testCase.failCount > 0 ? 'text-bad' : ''}>{testCase.failCount}</span>
                  </td>
                  <td>
                    {testCase.executionCount < 3
                      ? <span className="text-xs text-ink-subtle">too few runs</span>
                      : testCase.flakinessScore === 0
                        ? <span className="text-xs text-good">consistent</span>
                        : <span className="text-xs text-warn">{testCase.flakinessScore}/100 unstable</span>}
                  </td>
                  <td className="tabular-nums text-xs">{formatDuration(testCase.averageDurationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
