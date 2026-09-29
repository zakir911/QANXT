import { describe, expect, test } from 'vitest';
import { renderJUnit, escapeXml } from '../src/reports/junit';
import { buildJsonReport } from '../src/reports/json';
import { renderHtml } from '../src/reports/html';
import { renderMarkdown } from '../src/reports/markdown';
import { explain, qualification, verdictOf } from '../src/verdict';
import type { ExecutionSummary, RunReport } from '../src/types';

/**
 * A CI report is the only thing most people will ever see of a run, so these assert the two
 * ways it can lie: by mapping a verdict wrongly, and by producing a file the CI parser
 * cannot read.
 */

const execution = (over: Partial<ExecutionSummary>): ExecutionSummary => ({
  id: '11111111-1111-1111-1111-111111111111',
  testCaseId: '22222222-2222-2222-2222-222222222222',
  reference: 'TC-0001',
  name: 'Customer signs in',
  suite: 'Authentication',
  status: 'passed',
  durationMs: 1500,
  attempt: 1,
  stepsTotal: 4,
  stepsPassed: 4,
  stepsFailed: 0,
  stepsHealed: 0,
  consoleErrorCount: 0,
  networkErrorCount: 0,
  browser: 'chromium',
  priority: 'high',
  ...over
});

const report = (executions: ExecutionSummary[], gatePassed = true): RunReport => ({
  run: {
    id: 'run-1', projectId: 'p-1', name: 'Nightly regression', status: 'passed',
    trigger: 'ci', browser: 'chromium', createdAt: '2026-09-20T00:00:00Z',
    startedAt: '2026-09-20T00:00:01Z', completedAt: '2026-09-20T00:01:00Z',
    durationMs: 59_000,
    totalCount: executions.length,
    passedCount: executions.filter(e => verdictOf(e.status) === 'passed').length,
    failedCount: executions.filter(e => verdictOf(e.status) === 'failed').length,
    skippedCount: 0, blockedCount: executions.filter(e => e.status === 'blocked').length,
    healedCount: executions.filter(e => e.status === 'healed').length,
    flakyCount: executions.filter(e => e.status === 'flaky').length
  },
  executions,
  qualityGate: {
    passed: gatePassed,
    summary: gatePassed ? 'The quality gate passed: all 2 rule(s) were satisfied.' : 'The quality gate failed.',
    rules: [{
      ruleId: 'r-1', name: 'Pass rate', metric: 'passRatePercent', operator: 'greaterThanOrEqual',
      threshold: 95, actualValue: gatePassed ? 100 : 50, passed: gatePassed, isBlocking: true,
      explanation: 'The pass rate was 100, which satisfies being at least 95.'
    }]
  },
  project: { id: 'p-1', name: 'Retail Banking', key: 'BANK' },
  consoleUrl: 'http://localhost:5173',
  // No repair is waiting in the base fixture. The case where one is has its own test below,
  // because "nothing to approve" and "something to approve" must read differently.
  pendingHeals: [],
  generatedAt: '2026-09-20T00:02:00Z'
});

describe('verdict mapping', () => {
  test('a healed pass is a pass, and says so', () => {
    expect(verdictOf('healed')).toBe('passed');
    expect(qualification('healed')).toMatch(/locator was healed/i);
  });

  test('a flaky pass is a pass, and says so', () => {
    expect(verdictOf('flaky')).toBe('passed');
    expect(qualification('flaky')).toMatch(/weak evidence/i);
  });

  test('a blocked test is an error, never a pass', () => {
    expect(verdictOf('blocked')).toBe('error');
    expect(explain('blocked')).toMatch(/not a failure of the application/i);
  });

  test('an unfinished test is an error rather than a silent pass', () => {
    expect(verdictOf('running')).toBe('error');
    expect(explain('running')).toMatch(/unknown, not a pass/i);
  });

  test('an unrecognised status is an error, not assumed to be fine', () => {
    expect(verdictOf('something-new')).toBe('error');
  });
});

describe('JUnit XML', () => {
  test('escapes what would otherwise break the parser', () => {
    expect(escapeXml('a & b < c > d "e" \'f\'')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;');
  });

  test('strips control characters XML 1.0 cannot represent', () => {
    // A browser error message can contain these; escaping them is not possible.
    expect(escapeXml('before\u0000\u0008after')).toBe('beforeafter');
  });

  test('a failing test produces a failure element carrying the message', () => {
    const xml = renderJUnit(report([
      execution({ status: 'failed', errorMessage: 'Expected "Welcome" but found "Error & <retry>"' })
    ]));
    expect(xml).toContain('<failure');
    expect(xml).toContain('Error &amp; &lt;retry&gt;');
    expect(xml).not.toContain('<error');
  });

  test('a blocked test produces an error element, not a failure and not a pass', () => {
    const xml = renderJUnit(report([execution({ status: 'blocked', errorMessage: 'No credentials' })]));
    expect(xml).toContain('<error');
    expect(xml).toContain('errors="1"');
    expect(xml).toContain('failures="0"');
  });

  test('a healed test passes but carries its qualification in the output', () => {
    const xml = renderJUnit(report([execution({ status: 'healed', stepsHealed: 1 })]));
    expect(xml).not.toContain('<failure');
    expect(xml).toContain('<system-out>');
    expect(xml).toContain('locator was healed');
  });

  test('counts in the header match the test cases below it', () => {
    const xml = renderJUnit(report([
      execution({ reference: 'TC-1', status: 'passed' }),
      execution({ reference: 'TC-2', status: 'failed' }),
      execution({ reference: 'TC-3', status: 'blocked' }),
      execution({ reference: 'TC-4', status: 'cancelled' })
    ]));
    expect(xml).toContain('tests="4"');
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('errors="1"');
    expect(xml).toContain('skipped="1"');
  });

  test('is well-formed XML with balanced elements', () => {
    const xml = renderJUnit(report([
      execution({ reference: 'TC-1', name: 'Has "quotes" & <angles>', status: 'failed', errorMessage: 'x' }),
      execution({ reference: 'TC-2', status: 'healed' })
    ]));
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(count(xml, '<testsuites')).toBe(count(xml, '</testsuites>'));
    expect(count(xml, '<testsuite ')).toBe(count(xml, '</testsuite>'));
    expect(count(xml, '<testcase ')).toBe(count(xml, '</testcase>'));
    // No raw angle brackets survived from the test name into an attribute.
    expect(xml).toContain('name="TC-1 Has &quot;quotes&quot; &amp; &lt;angles&gt;"');
  });

  test('groups tests by project and suite so a CI UI can nest them', () => {
    const xml = renderJUnit(report([
      execution({ reference: 'TC-1', suite: 'Authentication' }),
      execution({ reference: 'TC-2', suite: 'Payments' })
    ]));
    expect(xml).toContain('classname="BANK.Authentication"');
    expect(xml).toContain('classname="BANK.Payments"');
  });

  test('a run with no executions still produces a parseable file', () => {
    const xml = renderJUnit(report([]));
    expect(xml).toContain('tests="0"');
    expect(count(xml, '<testsuites')).toBe(1);
  });
});

describe('JSON report', () => {
  test('carries a schema version so a consumer can refuse a shape it does not know', () => {
    const json = buildJsonReport(report([execution({})])) as { schemaVersion: number };
    expect(json.schemaVersion).toBe(1);
  });

  test('states the verdict separately from the platform status', () => {
    const json = buildJsonReport(report([execution({ status: 'healed' })])) as {
      tests: Array<{ status: string; verdict: string; qualification: string | null }>;
    };
    expect(json.tests[0]!.status).toBe('healed');
    expect(json.tests[0]!.verdict).toBe('passed');
    expect(json.tests[0]!.qualification).toMatch(/healed/i);
  });

  test('an unqualified pass has no qualification, so its absence means something', () => {
    const json = buildJsonReport(report([execution({ status: 'passed' })])) as {
      tests: Array<{ qualification: string | null; message: string | null }>;
    };
    expect(json.tests[0]!.qualification).toBeNull();
    expect(json.tests[0]!.message).toBeNull();
  });
});

describe('HTML report', () => {
  test('escapes application-controlled text rather than rendering it', () => {
    const html = renderHtml(report([
      execution({ name: '<img src=x onerror=alert(1)>', status: 'failed', errorMessage: '<script>bad()</script>' })
    ]));
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>bad()');
    expect(html).toContain('&lt;img src=x');
  });

  test('states the verdict in words, not only in colour', () => {
    const html = renderHtml(report([execution({ status: 'blocked' })]));
    expect(html).toContain('Could not run');
  });

  test('is self-contained: no external stylesheet, font or script', () => {
    const html = renderHtml(report([execution({})]));
    expect(html).not.toMatch(/<link[^>]+href="https?:/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
  });

  test('says plainly when the gate failed', () => {
    const html = renderHtml(report([execution({ status: 'failed' })], false));
    expect(html).toContain('Quality gate: failed');
  });
});

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}


/**
 * A repair the platform has already worked out, held back for approval.
 *
 * Healing proposes instead of applying when its confidence is under the project's threshold,
 * which is right. But the reports only carried `healed: 0`, so a pipeline said "3 failed" and
 * stopped there while the platform knew what the new locator should be. The engineer who
 * reads that summary is the one who can approve it, and nothing told them there was anything
 * to approve.
 */
describe('a repair waiting for approval', () => {
  const waiting = {
    ...report([execution({ status: 'failed', reference: 'TC-0003' })]),
    pendingHeals: [{
      testCaseReference: 'TC-0003',
      testCaseName: 'An impossible filter range lists no records',
      stepDescription: 'Enter a start date after the end date',
      originalLocator: 'testId="filter-from"',
      healedLocator: 'testId="date-range-start"',
      confidence: 81
    }]
  };

  test('is counted separately from repairs that were applied', () => {
    const json = buildJsonReport(waiting) as {
      totals: { healed: number; healsAwaitingApproval: number };
      healsAwaitingApproval: Array<{ testCase: string; from: string; to: string; confidence: number }>;
    };

    // The distinction is the point: nothing was healed, and something is waiting to be.
    expect(json.totals.healed).toBe(0);
    expect(json.totals.healsAwaitingApproval).toBe(1);
    expect(json.healsAwaitingApproval[0]).toMatchObject({
      testCase: 'TC-0003',
      from: 'testId="filter-from"',
      to: 'testId="date-range-start"',
      confidence: 81
    });
  });

  test('tells the pull request what it is waiting for, and what would change', () => {
    const markdown = renderMarkdown(waiting);

    expect(markdown).toContain('waiting for approval');
    expect(markdown).toContain('testId="filter-from"');
    expect(markdown).toContain('testId="date-range-start"');
    expect(markdown).toContain('81%');
  });

  test('says nothing at all when no repair is waiting', () => {
    // Otherwise every green run carries a paragraph about healing that does not apply, and
    // the section stops being read on the run where it matters.
    const markdown = renderMarkdown(report([execution({})]));
    expect(markdown).not.toContain('waiting for approval');
  });
});
