import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, apiRequest } from '../api/client';
import { formatBytes, formatDateTime, formatDuration } from '../lib/format';
import { Card, EmptyState, ErrorNotice, Metric, PageHeader, Spinner } from '../components/ui';

/**
 * The Verification Center: what the golden suite found, last time it ran.
 *
 * Every number on this page is read from verification/reports/golden-test-report.json —
 * the file the suite writes. The console computes nothing, so it cannot flatter the
 * result. Two rules are load-bearing here:
 *
 *   1. A missing report is not a passing report. If no run has happened, the page says so.
 *   2. Overall status is green only when every gate passes AND no critical test failed.
 *      The gates are re-checked in the browser rather than trusting the file's own
 *      `overall` flag, so a report that claimed green while a gate was red would still
 *      render red here.
 */

type Verdict = 'PASS' | 'FAIL' | 'NOT_VERIFIED';

interface Gate {
  name: string;
  passed: boolean;
  total: number;
  executed: number;
  failures: string[];
  notVerified: string[];
}

interface GoldenReport {
  runId: string;
  generatedAt: string;
  build: { commit?: string; branch?: string; dirty?: boolean } | null;
  totals: { total: number; passed: number; failed: number; notVerified: number; criticalFailures: number };
  bySeverity: { severity: string; total: number; failed: number }[];
  bySuite: { suite: string; total: number; passed: number; failed: number; notVerified: number }[];
  metrics: {
    discovery: Record<string, number | null>;
    generation: Record<string, number | null>;
    healing: Record<string, number | null>;
    failureAnalysis: Record<string, number | null>;
    reliability: Record<string, number | null>;
    integrity: Record<string, number>;
  };
  gates: Gate[];
  overall: boolean;
  evidence: { artifacts: number; bytes: number; missing: number; changed: number };
  tests: {
    id: string; suite: string; objective: string; severity: string;
    result: Verdict; detail: string; durationMs: number; evidence: string[];
  }[];
}

interface Certification {
  runId: string;
  status: string;
  generatedAt: string;
  answers: { question: string; answer: string; passed: string[]; failed: string[]; notVerified: string[]; missing: string[] }[];
  headline: Record<string, number | null>;
}

interface VerificationStatus {
  directory: string;
  reportAvailable: boolean;
  certificationAvailable: boolean;
  command: string;
}

const share = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`;
const count = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : String(value);

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const tone = verdict === 'PASS' ? 'bg-good-light text-good'
    : verdict === 'FAIL' ? 'bg-bad-light text-bad'
      : 'bg-warn-light text-warn';
  const label = verdict === 'NOT_VERIFIED' ? 'Not verified' : verdict === 'PASS' ? 'Pass' : 'Fail';
  return <span className={`badge ${tone}`}>{label}</span>;
}

function MetricTable({ rows }: { rows: [string, string][] }) {
  return (
    <table className="w-full text-sm">
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label} className="border-b border-line last:border-0">
            <td className="py-1.5 pr-4 text-ink-muted">{label}</td>
            <td className="py-1.5 text-right font-semibold tabular-nums text-ink">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function VerificationPage() {
  const [filter, setFilter] = useState<'all' | Verdict>('all');
  const [suiteFilter, setSuiteFilter] = useState<string>('all');

  const status = useQuery({
    queryKey: ['verification', 'status'],
    queryFn: () => apiRequest<VerificationStatus>('/api/v1/verification/status')
  });

  const report = useQuery({
    queryKey: ['verification', 'report'],
    queryFn: () => apiRequest<GoldenReport>('/api/v1/verification/report'),
    retry: false,
    enabled: status.data?.reportAvailable === true
  });

  const certification = useQuery({
    queryKey: ['verification', 'certification'],
    queryFn: () => apiRequest<Certification>('/api/v1/verification/certification'),
    retry: false,
    enabled: status.data?.certificationAvailable === true
  });

  if (status.isLoading) return <Spinner label="Looking for a golden run" />;
  if (status.isError) return <ErrorNotice error={status.error} onRetry={() => status.refetch()} />;

  if (!status.data?.reportAvailable) {
    return (
      <>
        <PageHeader title="Verification Center" description="What the golden test suite found, last time it ran." />
        <Card>
          <EmptyState
            title="No golden run has been recorded"
            description={`Nothing has been verified in this deployment yet. An unverified system is not a passing one — run the suite to populate this page. Reports are read from ${status.data?.directory ?? 'the configured report directory'}.`}
            action={<code className="rounded bg-surface-sunken px-2.5 py-1.5 text-sm font-mono text-ink">{status.data?.command ?? './scripts/run-golden-tests --all'}</code>}
          />
        </Card>
      </>
    );
  }

  if (report.isLoading) return <Spinner label="Reading the golden report" />;
  if (report.isError || !report.data) {
    return (
      <>
        <PageHeader title="Verification Center" />
        <ErrorNotice error={report.error ?? new ApiError('The report could not be read.', 500, 'unknown')}
                      onRetry={() => report.refetch()} />
      </>
    );
  }

  const data = report.data;
  const { metrics, totals } = data;

  // Recomputed rather than read: the page must not be able to show green over a red gate.
  const gatesPass = data.gates.length > 0 && data.gates.every(gate => gate.passed);
  const green = gatesPass && totals.criticalFailures === 0 && data.overall;
  const failingGates = data.gates.filter(gate => !gate.passed);

  const suites = ['all', ...data.bySuite.map(entry => entry.suite)];
  const visible = data.tests.filter(test =>
    (filter === 'all' || test.result === filter)
    && (suiteFilter === 'all' || test.suite === suiteFilter));

  const falseHealing = metrics.healing.falseHealingRate;

  return (
    <>
      <PageHeader
        title="Verification Center"
        description={`Run ${data.runId} · ${formatDateTime(data.generatedAt)}${data.build?.commit ? ` · build ${data.build.commit}${data.build.dirty ? ' (dirty)' : ''}` : ''}`}
      />

      <div
        role="status"
        className={`mb-6 rounded-lg border px-5 py-4 ${green
          ? 'border-good/25 bg-good-light'
          : 'border-bad/25 bg-bad-light'}`}
      >
        <p className={`text-base font-bold ${green ? 'text-good' : 'text-bad'}`}>
          {green ? 'All quality gates passed' : 'Quality gates did not pass'}
        </p>
        <p className={`mt-1 text-sm ${green ? 'text-good/90' : 'text-bad/90'}`}>
          {green
            ? `${totals.passed} of ${totals.total} golden tests passed. ${totals.notVerified} could not be executed in this environment and are recorded as not verified, not as passes.`
            : `${totals.failed} test(s) failed, ${totals.criticalFailures} of them critical.${failingGates.length ? ` Failing gate(s): ${failingGates.map(gate => gate.name).join(', ')}.` : ''}`}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <Metric label="Tests executed" value={totals.total - totals.notVerified}
                hint={`${totals.total} declared, ${totals.notVerified} not verified`} />
        <Metric label="Passed" value={totals.passed} tone={totals.passed > 0 ? 'good' : 'neutral'} />
        <Metric label="Failed" value={totals.failed} tone={totals.failed > 0 ? 'bad' : 'good'}
                hint={`${totals.criticalFailures} critical`} />
        <Metric
          label="False-healing rate"
          value={share(falseHealing)}
          tone={falseHealing === 0 ? 'good' : falseHealing === null ? 'neutral' : 'bad'}
          hint={`${count(metrics.healing.incorrectHeals)} incorrect heal(s) — target 0`}
        />
      </div>

      <Card title="Quality gates" description="A gate passes only when every executed test behind it passed."
            className="mb-6">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-subtle border-b border-line">
                <th className="pb-2 pr-4 font-semibold">Gate</th>
                <th className="pb-2 pr-4 font-semibold">Status</th>
                <th className="pb-2 pr-4 font-semibold">Executed</th>
                <th className="pb-2 pr-4 font-semibold">Failures</th>
                <th className="pb-2 font-semibold">Not verified</th>
              </tr>
            </thead>
            <tbody>
              {data.gates.map(gate => (
                <tr key={gate.name} className="border-b border-line last:border-0">
                  <td className="py-2 pr-4 font-medium text-ink">{gate.name}</td>
                  <td className="py-2 pr-4">
                    <span className={`badge ${gate.passed ? 'bg-good-light text-good' : 'bg-bad-light text-bad'}`}>
                      {gate.passed ? 'Pass' : 'Fail'}
                    </span>
                  </td>
                  <td className="py-2 pr-4 tabular-nums text-ink-muted">{gate.executed}/{gate.total}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-bad">{gate.failures.join(', ') || '—'}</td>
                  <td className="py-2 font-mono text-xs text-warn">{gate.notVerified.join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2 mb-6">
        <Card title="Discovery" description="Measured against hand-written ground truth.">
          <MetricTable rows={[
            ['Page recall', share(metrics.discovery.pageRecall)],
            ['Page precision', share(metrics.discovery.pagePrecision)],
            ['API endpoint recall', share(metrics.discovery.apiRecall)],
            ['Elements with a stable locator', share(metrics.discovery.stableLocatorShare)],
            ['Pages / elements', `${count(metrics.discovery.pagesDiscovered)} / ${count(metrics.discovery.elementsDiscovered)}`],
            ['Crawl duration', formatDuration(metrics.discovery.discoveryMs)]
          ]} />
        </Card>

        <Card title="Test generation" description="Structure and reach, not prose quality.">
          <MetricTable rows={[
            ['Discovered pages reached', share(metrics.generation.coverageOfDiscoveredPages)],
            ['Steps using a stable locator', share(metrics.generation.stableLocatorShare)],
            ['Generated tests executed', count(metrics.generation.generatedTestsExecuted)],
            ['…of which passed when healthy', count(metrics.generation.generatedTestsPassed)],
            ['…of which failed once broken', count(metrics.generation.generatedTestsFailedUnderFault)]
          ]} />
        </Card>

        <Card title="Self-healing" description="The rejection numbers matter more than the repair numbers.">
          <MetricTable rows={[
            ['Healing opportunities', count(metrics.healing.opportunities)],
            ['Correct heals', count(metrics.healing.correctHeals)],
            ['Correct rejections', count(metrics.healing.correctRejections)],
            ['Incorrect heals', count(metrics.healing.incorrectHeals)],
            ['Missed heals', count(metrics.healing.missedHeals)],
            ['Healing success rate', share(metrics.healing.healingSuccessRate)],
            ['False-healing rate', share(metrics.healing.falseHealingRate)],
            ['Confidence margin', metrics.healing.confidenceMargin === null
              ? '—'
              : `${metrics.healing.confidenceMargin} pts (${count(metrics.healing.lowestHealable)}% vs ${count(metrics.healing.highestWrongTarget)}%)`]
          ]} />
        </Card>

        <Card title="Failure analysis and reliability">
          <MetricTable rows={[
            ['Classification accuracy', `${share(metrics.failureAnalysis.classificationAccuracy)} (${count(metrics.failureAnalysis.classesCorrect)}/${count(metrics.failureAnalysis.classesTotal)})`],
            ['Classified unknown', count(metrics.failureAnalysis.classifiedUnknown)],
            ['Repeatability', `${count(metrics.reliability.repeatabilityRuns)} runs, ${count(metrics.reliability.repeatabilityDistinctVerdicts)} distinct verdict(s)`],
            ['Unstable application', `${count(metrics.reliability.flakyPassed)} passed / ${count(metrics.reliability.flakyFailed)} failed of ${count(metrics.reliability.flakyRuns)}`],
            ['Concurrency', `${count(metrics.reliability.concurrentReachedVerdict)}/${count(metrics.reliability.concurrentRuns)} reached a verdict`]
          ]} />
        </Card>
      </div>

      <Card title="Result integrity" description="Whether a verdict can be trusted at all."
            className="mb-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="False passes observed" value={metrics.integrity.falsePasses}
                  tone={metrics.integrity.falsePasses === 0 ? 'good' : 'bad'}
                  hint={`across ${metrics.integrity.falsePassChecks} check(s)`} />
          <Metric label="False failures observed" value={metrics.integrity.falseNegatives}
                  tone={metrics.integrity.falseNegatives === 0 ? 'good' : 'bad'}
                  hint={`across ${metrics.integrity.falseNegativeChecks} check(s)`} />
          <Metric label="Evidence artifacts" value={data.evidence.artifacts}
                  hint={formatBytes(data.evidence.bytes)} />
          <Metric label="Artifacts missing or altered"
                  value={data.evidence.missing + data.evidence.changed}
                  tone={data.evidence.missing + data.evidence.changed === 0 ? 'good' : 'bad'}
                  hint="checked against the SHA-256 recorded at capture" />
        </div>
      </Card>

      {certification.data && (
        <Card
          title="Certification"
          description={`Ten questions, each answered by tests that ran — status: ${certification.data.status}`}
          className="mb-6"
        >
          <ul className="space-y-2">
            {certification.data.answers.map(answer => (
              <li key={answer.question} className="flex items-start gap-3 border-b border-line pb-2 last:border-0">
                <span className={`badge shrink-0 ${answer.answer === 'YES' ? 'bg-good-light text-good'
                  : answer.answer === 'NO' ? 'bg-bad-light text-bad' : 'bg-warn-light text-warn'}`}>
                  {answer.answer}
                </span>
                <div className="min-w-0">
                  <p className="text-sm text-ink">{answer.question}</p>
                  <p className="mt-0.5 text-xs text-ink-muted font-mono">
                    {answer.passed.length} passed
                    {answer.failed.length > 0 && ` · failed: ${answer.failed.join(', ')}`}
                    {answer.notVerified.length > 0 && ` · not verified: ${answer.notVerified.join(', ')}`}
                    {answer.missing.length > 0 && ` · not run: ${answer.missing.join(', ')}`}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card
        title="Every golden test"
        description={`${visible.length} of ${data.tests.length} shown`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select className="input py-1 text-sm" value={suiteFilter}
                    onChange={event => setSuiteFilter(event.target.value)} aria-label="Filter by suite">
              {suites.map(suite => (
                <option key={suite} value={suite}>{suite === 'all' ? 'All suites' : suite}</option>
              ))}
            </select>
            {(['all', 'PASS', 'FAIL', 'NOT_VERIFIED'] as const).map(option => (
              <button key={option} type="button"
                      className={filter === option ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}
                      onClick={() => setFilter(option)}>
                {option === 'all' ? 'All' : option === 'NOT_VERIFIED' ? 'Not verified' : option === 'PASS' ? 'Passed' : 'Failed'}
              </button>
            ))}
          </div>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-subtle border-b border-line">
                <th className="pb-2 pr-4 font-semibold">ID</th>
                <th className="pb-2 pr-4 font-semibold">Objective</th>
                <th className="pb-2 pr-4 font-semibold">Result</th>
                <th className="pb-2 pr-4 font-semibold">Detail</th>
                <th className="pb-2 pr-4 font-semibold">Evidence</th>
                <th className="pb-2 font-semibold text-right">Duration</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(test => (
                <tr key={test.id} className="border-b border-line last:border-0 align-top">
                  <td className="py-2 pr-4 font-mono text-xs whitespace-nowrap text-ink">{test.id}</td>
                  <td className="py-2 pr-4 text-ink max-w-xs">{test.objective}</td>
                  <td className="py-2 pr-4"><VerdictBadge verdict={test.result} /></td>
                  <td className="py-2 pr-4 text-xs text-ink-muted max-w-md">{test.detail}</td>
                  <td className="py-2 pr-4 text-xs text-ink-muted tabular-nums">{test.evidence.length}</td>
                  <td className="py-2 text-right text-xs text-ink-muted tabular-nums whitespace-nowrap">
                    {formatDuration(test.durationMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {visible.length === 0 && (
            <p className="py-6 text-center text-sm text-ink-muted">No test matches that filter.</p>
          )}
        </div>
      </Card>
    </>
  );
}
