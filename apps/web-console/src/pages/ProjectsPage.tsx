import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../api/client';
import { Permissions, useAuth } from '../lib/auth';
import { useProject, type ProjectSummary } from '../lib/project';
import { Card, EmptyState, ErrorNotice, PageHeader, Spinner } from '../components/ui';
import { formatDateTime, humanize } from '../lib/format';

interface ProjectDetail {
  id: string; name: string; key: string; description: string;
  defaultBrowser: string; defaultRetries: number; maxParallelExecutions: number;
  defaultActionTimeoutMs: number; captureVideo: boolean; captureTrace: boolean; captureHar: boolean;
  healingPolicy: string; healingConfidenceThreshold: number;
  aiProvider: string; aiModel: string | null; aiEnabled: boolean; allowScriptExecution: boolean;
}

export default function ProjectsPage() {
  const { can } = useAuth();
  const { projects, setProjectId, isLoading } = useProject();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (body: { name: string; key: string; description: string }) =>
      apiRequest<ProjectSummary>('/api/v1/projects', { method: 'POST', body }),
    onSuccess: async project => {
      setCreating(false);
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      setProjectId(project.id);
    },
    onError: setError
  });

  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    create.mutate({
      name: String(form.get('name') ?? ''),
      key: String(form.get('key') ?? ''),
      description: String(form.get('description') ?? '')
    });
  };

  if (isLoading) return <Spinner label="Loading projects" />;

  return (
    <>
      <PageHeader
        title="Projects"
        description="A project groups the applications, tests and quality rules for one product."
        actions={can(Permissions.projectWrite) && !creating && (
          <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
            New project
          </button>
        )}
      />

      {creating && (
        <Card title="New project" className="mb-4">
          <form onSubmit={handleCreate} className="grid gap-3.5 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="name">Name</label>
              <input id="name" name="name" required className="input" placeholder="Retail Banking" />
            </div>
            <div>
              <label className="label" htmlFor="key">Key</label>
              <input id="key" name="key" required className="input" placeholder="BANK"
                     pattern="[A-Za-z0-9_-]+" title="Letters, digits, hyphens and underscores only" />
              <p className="mt-1 text-xs text-ink-muted">Used by the CLI and in test references.</p>
            </div>
            <div className="sm:col-span-2">
              <label className="label" htmlFor="description">Description</label>
              <input id="description" name="description" className="input"
                     placeholder="Retail banking web regression suite" />
            </div>
            {error !== null && <div className="sm:col-span-2"><ErrorNotice error={error} /></div>}
            <div className="sm:col-span-2 flex gap-2">
              <button type="submit" className="btn-primary" disabled={create.isPending}>
                {create.isPending ? 'Creating…' : 'Create project'}
              </button>
              <button type="button" className="btn-secondary"
                      onClick={() => { setCreating(false); setError(null); }}>
                Cancel
              </button>
            </div>
          </form>
        </Card>
      )}

      {projects.length === 0 && !creating ? (
        <Card>
          <EmptyState
            title="No projects yet"
            description="Create a project, add the application you want to test, and run discovery against it."
            action={can(Permissions.projectWrite) && (
              <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
                Create your first project
              </button>
            )}
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.map(project => (
            <Card
              key={project.id}
              title={project.name}
              description={project.description || 'No description'}
              actions={<span className="badge bg-surface-sunken text-ink-muted font-mono">{project.key}</span>}
            >
              <dl className="grid grid-cols-3 gap-3 mb-4">
                <div className="kv"><dt>Applications</dt><dd className="font-semibold">{project.applicationCount}</dd></div>
                <div className="kv"><dt>Test cases</dt><dd className="font-semibold">{project.testCaseCount}</dd></div>
                <div className="kv"><dt>Open defects</dt><dd className="font-semibold">{project.openDefectCount}</dd></div>
              </dl>
              <div className="flex items-center gap-2">
                <button type="button" className="btn-secondary btn-sm" onClick={() => setProjectId(project.id)}>
                  Select
                </button>
                {can(Permissions.projectWrite) && (
                  <button type="button" className="btn-secondary btn-sm"
                          onClick={() => setEditing(editing === project.id ? null : project.id)}>
                    {editing === project.id ? 'Close settings' : 'Settings'}
                  </button>
                )}
                <span className="ml-auto text-xs text-ink-subtle">{formatDateTime(project.createdAt)}</span>
              </div>
              {editing === project.id && <ProjectSettings projectId={project.id} />}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

/** Execution, healing and AI configuration for one project. */
function ProjectSettings({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiRequest<ProjectDetail>(`/api/v1/projects/${projectId}`)
  });

  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiRequest<ProjectDetail>(`/api/v1/projects/${projectId}`, { method: 'PATCH', body }),
    onSuccess: async () => {
      setError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] });
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: setError
  });

  if (isLoading || !data) return <div className="mt-4"><Spinner label="Loading settings" /></div>;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    update.mutate({
      defaultBrowser: form.get('defaultBrowser'),
      healingPolicy: form.get('healingPolicy'),
      healingConfidenceThreshold: Number(form.get('healingConfidenceThreshold')),
      maxParallelExecutions: Number(form.get('maxParallelExecutions')),
      defaultRetries: Number(form.get('defaultRetries')),
      aiProvider: form.get('aiProvider'),
      aiEnabled: form.get('aiEnabled') === 'on',
      captureVideo: form.get('captureVideo') === 'on',
      captureTrace: form.get('captureTrace') === 'on',
      allowScriptExecution: form.get('allowScriptExecution') === 'on'
    });
  };

  return (
    <form onSubmit={handleSubmit} className="mt-4 pt-4 border-t border-line grid gap-3 sm:grid-cols-2">
      <div>
        <label className="label" htmlFor={`browser-${projectId}`}>Default browser</label>
        <select id={`browser-${projectId}`} name="defaultBrowser" defaultValue={data.defaultBrowser} className="input">
          {['chromium', 'firefox', 'webkit'].map(b => <option key={b} value={b}>{humanize(b)}</option>)}
        </select>
      </div>

      <div>
        <label className="label" htmlFor={`parallel-${projectId}`}>Parallel executions</label>
        <input id={`parallel-${projectId}`} name="maxParallelExecutions" type="number" min={1} max={50}
               defaultValue={data.maxParallelExecutions} className="input" />
      </div>

      <div>
        <label className="label" htmlFor={`policy-${projectId}`}>Self-healing policy</label>
        <select id={`policy-${projectId}`} name="healingPolicy" defaultValue={data.healingPolicy} className="input">
          <option value="never">Never — report the failure, change nothing</option>
          <option value="suggest">Suggest — record a proposal for review</option>
          <option value="auto">Auto — use it for the run, still needs approval to keep</option>
        </select>
      </div>

      <div>
        <label className="label" htmlFor={`threshold-${projectId}`}>Healing confidence threshold</label>
        <input id={`threshold-${projectId}`} name="healingConfidenceThreshold" type="number" min={0} max={100}
               defaultValue={data.healingConfidenceThreshold} className="input" />
        <p className="mt-1 text-xs text-ink-muted">Candidates below this are never used, whatever the policy.</p>
      </div>

      <div>
        <label className="label" htmlFor={`retries-${projectId}`}>Retries per test</label>
        <input id={`retries-${projectId}`} name="defaultRetries" type="number" min={0} max={5}
               defaultValue={data.defaultRetries} className="input" />
      </div>

      <div>
        <label className="label" htmlFor={`ai-${projectId}`}>AI provider</label>
        <select id={`ai-${projectId}`} name="aiProvider" defaultValue={data.aiProvider} className="input">
          <option value="local">Built-in rules (no external calls)</option>
          <option value="openAi">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="gemini">Gemini</option>
        </select>
        <p className="mt-1 text-xs text-ink-muted">
          A provider without an API key falls back to the built-in rules, and results are labelled accordingly.
        </p>
      </div>

      <fieldset className="sm:col-span-2 grid gap-2 sm:grid-cols-2">
        <legend className="label">Capture and safety</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="captureVideo" defaultChecked={data.captureVideo} /> Record video
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="captureTrace" defaultChecked={data.captureTrace} /> Record Playwright trace
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="aiEnabled" defaultChecked={data.aiEnabled} /> AI features enabled
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="allowScriptExecution" defaultChecked={data.allowScriptExecution} />
          Allow executeScript steps
        </label>
      </fieldset>

      {error !== null && <div className="sm:col-span-2"><ErrorNotice error={error} /></div>}

      <div className="sm:col-span-2 flex items-center gap-3">
        <button type="submit" className="btn-primary btn-sm" disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save settings'}
        </button>
        {saved && <span className="text-sm text-good">Saved.</span>}
      </div>
    </form>
  );
}
