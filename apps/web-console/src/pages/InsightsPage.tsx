import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { apiRequest } from '../api/client';
import { useProject } from '../lib/project';
import { Card, ErrorNotice, PageHeader, ProviderNote } from '../components/ui';

interface InsightAnswer {
  answer: string;
  findings: { statement: string; evidenceRefs: string[]; confidence: number }[];
  insufficientEvidence: boolean;
  provider: string; model: string; isLocalProvider: boolean;
  aiRequestId: string; evidenceWindow: string;
}

interface ProviderStatus {
  kind: string; name: string; isConfigured: boolean; defaultModel: string; notes: string;
}

const SUGGESTIONS = [
  'Which tests are most unstable?',
  'Which failures are likely application defects?',
  'What should the QA team investigate first?',
  'Which tests were self-healed, and how confident were the repairs?',
  'How is quality trending overall?'
];

/**
 * Questions about quality, answered from the execution record.
 *
 * Every answer cites the records it came from, and says plainly when the evidence does not
 * support a conclusion. An AI feature that produces a confident paragraph from nothing is
 * worse than one that admits it cannot tell.
 */
export default function InsightsPage() {
  const { projectId, project } = useProject();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<InsightAnswer | null>(null);
  const [error, setError] = useState<unknown>(null);

  const { data: providers = [] } = useQuery({
    queryKey: ['ai-providers'],
    queryFn: () => apiRequest<ProviderStatus[]>('/api/v1/ai/providers'),
    staleTime: 300_000
  });

  const ask = useMutation({
    mutationFn: (body: { projectId?: string; question: string; windowDays: number }) =>
      apiRequest<InsightAnswer>('/api/v1/ai/insights', { method: 'POST', body }),
    onSuccess: result => { setAnswer(result); setError(null); },
    onError: caught => { setError(caught); setAnswer(null); }
  });

  const submit = (text: string) => {
    if (!text.trim()) return;
    setQuestion(text);
    ask.mutate({ projectId: projectId ?? undefined, question: text, windowDays: 30 });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit(question);
  };

  const configured = providers.filter(p => p.isConfigured && p.kind !== 'local');

  return (
    <>
      <PageHeader
        title="AI insights"
        description={`Ask about quality in ${project?.name ?? 'all projects'}. Answers are derived only from stored executions.`}
      />

      {configured.length === 0 && (
        <div className="mb-4 rounded-lg border border-line bg-surface-sunken px-4 py-3">
          <p className="text-sm text-ink">
            No model provider is configured, so answers come from AIRA's built-in rules.
            They are computed from the same records and are always labelled as such.
          </p>
          <p className="mt-1 text-xs text-ink-muted">
            Set <span className="font-mono">OPENAI_API_KEY</span>,{' '}
            <span className="font-mono">ANTHROPIC_API_KEY</span> or{' '}
            <span className="font-mono">GEMINI_API_KEY</span> to enable a model provider.
          </p>
        </div>
      )}

      <Card className="mb-4">
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="label" htmlFor="question">Your question</label>
            <textarea
              id="question"
              value={question}
              onChange={event => setQuestion(event.target.value)}
              rows={2}
              maxLength={1000}
              className="input"
              placeholder="Which tests are most unstable?"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className="btn-primary" disabled={ask.isPending || !question.trim()}>
              {ask.isPending ? 'Thinking…' : 'Ask'}
            </button>
            {SUGGESTIONS.map(suggestion => (
              <button key={suggestion} type="button" className="btn-secondary btn-sm"
                      onClick={() => submit(suggestion)} disabled={ask.isPending}>
                {suggestion}
              </button>
            ))}
          </div>
        </form>
      </Card>

      {error !== null && <ErrorNotice error={error} />}

      {answer && (
        <Card title="Answer" description={`Derived from ${answer.evidenceWindow}`}>
          {answer.insufficientEvidence && (
            <div className="mb-3 rounded-lg border border-warn/25 bg-warn-light px-3 py-2 text-sm text-warn">
              The available evidence does not support a confident answer.
            </div>
          )}

          <p className="text-sm text-ink whitespace-pre-wrap">{answer.answer}</p>

          {answer.findings.length > 0 && (
            <ul className="mt-4 space-y-2.5">
              {answer.findings.map((finding, index) => (
                <li key={index} className="rounded-lg border border-line px-3.5 py-3">
                  <p className="text-sm text-ink">{finding.statement}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-ink-subtle">Evidence:</span>
                    {finding.evidenceRefs.map(reference => (
                      <span key={reference} className="badge bg-surface-sunken text-ink-muted font-mono">
                        {reference}
                      </span>
                    ))}
                    <span className="ml-auto text-xs text-ink-muted tabular-nums">
                      {finding.confidence}% confidence
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 pt-3 border-t border-line">
            <ProviderNote provider={answer.provider} model={answer.model} isLocal={answer.isLocalProvider} />
          </div>
        </Card>
      )}
    </>
  );
}
