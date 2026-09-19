import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../api/client';
import { Card, ErrorNotice, PageHeader, Spinner, StatusBadge } from '../components/ui';
import { humanize } from '../lib/format';

interface GraphPage {
  id: string; route: string; title: string; normalizedUrl: string; kind: string;
  depth: number; requiresAuthentication: boolean; elementCount: number;
  httpStatus?: number; loadTimeMs: number; consoleErrorCount: number;
  parentPageId?: string; hasScreenshot: boolean; lastSeenAt: string;
}

interface GraphView {
  pages: GraphPage[];
  transitions: { from: string; to: string; action: string; timesObserved: number }[];
  apiEndpoints: {
    id: string; method: string; urlTemplate: string; timesObserved: number;
    lastStatusCode?: number; averageDurationMs: number; requiresAuthentication: boolean;
    triggeredByPageId?: string;
  }[];
}

interface ElementView {
  page: { id: string; route: string; title: string; url: string };
  elements: {
    id: string; kind: string; tagName: string; ariaRole?: string; accessibleName?: string;
    label?: string; placeholder?: string; testId?: string; type?: string;
    isVisible: boolean; isEnabled: boolean; isRequired: boolean; stabilityScore: number;
    preferredLocator?: string;
  }[];
}

/**
 * The application knowledge graph: what the platform learned about the application.
 *
 * Rendered as a depth-ordered tree rather than a force-directed diagram, because the
 * question a QA engineer actually has is "what can I reach from here, and what is on it" —
 * which a tree answers and a hairball does not.
 */
export default function ApplicationGraphPage() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['graph', applicationId],
    queryFn: () => apiRequest<GraphView>(`/api/v1/applications/${applicationId}/graph`),
    enabled: Boolean(applicationId)
  });

  const { data: elements } = useQuery({
    queryKey: ['page-elements', applicationId, selectedPageId],
    queryFn: () => apiRequest<ElementView>(
      `/api/v1/applications/${applicationId}/pages/${selectedPageId}/elements`),
    enabled: Boolean(selectedPageId)
  });

  if (isLoading) return <Spinner label="Loading the application map" />;
  if (error) return <ErrorNotice error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  const outgoing = (pageId: string) => data.transitions.filter(t => t.from === pageId);
  const byDepth = [...data.pages].sort((a, b) => a.depth - b.depth || a.route.localeCompare(b.route));

  return (
    <>
      <PageHeader
        title="Application map"
        description={`${data.pages.length} page(s), ${data.transitions.length} transition(s), ${data.apiEndpoints.length} API call(s) observed.`}
        actions={<Link to="/applications" className="btn-secondary">Back to applications</Link>}
      />

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3 space-y-4">
          <Card title="Pages" description="Grouped by how many clicks from the entry point">
            <ul className="space-y-1.5">
              {byDepth.map(page => (
                <li key={page.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedPageId(page.id === selectedPageId ? null : page.id)}
                    aria-expanded={page.id === selectedPageId}
                    className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors ${
                      page.id === selectedPageId
                        ? 'border-brand bg-brand-light'
                        : 'border-line hover:bg-surface-sunken'
                    }`}
                    style={{ marginLeft: `${Math.min(page.depth, 4) * 16}px` }}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-sm text-ink">{page.route || '/'}</span>
                      <StatusBadge status={page.kind} />
                      {page.requiresAuthentication && (
                        <span className="badge bg-surface-sunken text-ink-muted">authenticated</span>
                      )}
                      {page.consoleErrorCount > 0 && (
                        <span className="badge bg-bad-light text-bad">{page.consoleErrorCount} console error(s)</span>
                      )}
                      <span className="ml-auto text-xs text-ink-subtle">{page.elementCount} elements</span>
                    </div>
                    <div className="mt-0.5 text-xs text-ink-muted truncate">{page.title}</div>
                    {outgoing(page.id).length > 0 && (
                      <div className="mt-1 text-xs text-ink-subtle">
                        Leads to {outgoing(page.id).length} page(s)
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </Card>

          {data.apiEndpoints.length > 0 && (
            <Card title="API calls observed"
                  description="Captured while driving the UI, and correlated to the page that made them">
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr><th>Method</th><th>Endpoint</th><th>Seen</th><th>Status</th><th>Auth</th></tr>
                  </thead>
                  <tbody>
                    {data.apiEndpoints.map(endpoint => (
                      <tr key={endpoint.id}>
                        <td><span className="font-mono text-xs font-semibold">{endpoint.method}</span></td>
                        <td className="font-mono text-xs break-all">{endpoint.urlTemplate}</td>
                        <td className="tabular-nums">{endpoint.timesObserved}</td>
                        <td>{endpoint.lastStatusCode ?? '—'}</td>
                        <td>{endpoint.requiresAuthentication ? 'yes' : 'no'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>

        <div className="lg:col-span-2">
          {selectedPageId && elements ? (
            <Card
              title={elements.page.route || '/'}
              description={`${elements.elements.length} element(s) — the signals self-healing scores against`}
            >
              <ul className="space-y-2 max-h-[34rem] overflow-y-auto pr-1">
                {elements.elements.map(element => (
                  <li key={element.id} className="rounded-lg border border-line px-3 py-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="badge bg-surface-sunken text-ink-muted">{humanize(element.kind)}</span>
                      {element.testId && (
                        <span className="badge bg-good-light text-good font-mono">testId={element.testId}</span>
                      )}
                      <span className="ml-auto text-xs text-ink-subtle" title="How resistant the preferred locator is to UI change">
                        stability {element.stabilityScore}
                      </span>
                    </div>
                    <div className="mt-1 text-sm text-ink">
                      {element.accessibleName || element.label || element.placeholder || <em className="text-ink-subtle">no accessible name</em>}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-muted font-mono">
                      &lt;{element.tagName}&gt;{element.ariaRole ? ` role=${element.ariaRole}` : ''}
                      {element.isRequired ? ' required' : ''}
                      {!element.isVisible ? ' hidden' : ''}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ) : (
            <Card title="Page details">
              <p className="text-sm text-ink-muted py-8 text-center">
                Select a page to see the elements the platform captured on it.
              </p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
