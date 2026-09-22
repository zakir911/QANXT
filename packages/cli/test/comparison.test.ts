import { describe, expect, test } from 'vitest';
import { renderComparison, type RunComparison, type TestComparison } from '../src/reports/comparison.js';

/**
 * The comparison comment.
 *
 * Two things are checked here and nowhere else. The wire values are camelCase, and reading
 * them as PascalCase produces `undefined` rather than an error — so a gate on regressions
 * silently stops gating and every headline reads "nothing changed". And the order is not
 * cosmetic: a comment that opens with thirty still-failing tests buries the one line the
 * reader needed.
 */

const side = (name: string, overrides = {}) => ({
  id: `run-${name}`, name, status: 'Failed', completedAt: null,
  total: 3, passed: 2, failed: 1, blocked: 0, healed: 0, flaky: 0,
  durationMs: 1000, commitSha: 'a1b2c3d4e5f6', branch: 'main',
  environmentKey: 'qa', qualityGatePassed: true, ...overrides
});

const test_ = (reference: string, movement: TestComparison['movement'],
  overrides: Partial<TestComparison> = {}): TestComparison => ({
  testCaseId: `id-${reference}`, reference, name: `${reference} does a thing`,
  suite: 'Checkout', movement, currentStatus: 'Failed', previousStatus: 'Passed',
  currentDurationMs: 100, previousDurationMs: 90, errorMessage: null,
  failureCategory: null, ...overrides
});

function comparison(tests: TestComparison[], summary = 'Something changed.'): RunComparison {
  const counts = {
    newlyFailing: 0, fixed: 0, stillFailing: 0, stillPassing: 0, added: 0, removed: 0
  };
  for (const test of tests) counts[test.movement]++;
  return {
    current: side('after'), previous: side('before'), tests, counts,
    unchanged: counts.newlyFailing === 0 && counts.fixed === 0
      && counts.added === 0 && counts.removed === 0,
    summary
  };
}

describe('the headline says what a release decision turns on', () => {
  test('a regression leads, whatever else is in the comparison', () => {
    const rendered = renderComparison(comparison([
      test_('TC-1', 'newlyFailing'),
      ...Array.from({ length: 30 }, (_, i) => test_(`TC-old-${i}`, 'stillFailing'))
    ]));

    expect(rendered.split('\n')[0]).toBe('#### ❌ 1 test(s) that used to pass now fail');
  });

  test('failures that were already there are not reported as news', () => {
    // Twelve failing tests are not a reason to stop a release if the same twelve failed
    // last week and somebody already knows why.
    const rendered = renderComparison(comparison([
      test_('TC-1', 'stillFailing'), test_('TC-2', 'stillFailing')
    ]));

    expect(rendered.split('\n')[0]).toBe('#### ⚠️ Nothing newly broken — 2 still failing');
  });

  test('a clean run of fixes says so', () => {
    const rendered = renderComparison(comparison([test_('TC-1', 'fixed')]));
    expect(rendered.split('\n')[0]).toBe('#### ✅ 1 test(s) fixed, nothing newly broken');
  });

  test('nothing at all says nothing at all', () => {
    const rendered = renderComparison(comparison([test_('TC-1', 'stillPassing')]));
    expect(rendered.split('\n')[0]).toBe('#### ✅ Nothing changed, and nothing is failing');
  });
});

describe('what is shown and what is folded away', () => {
  test('newly failing tests are never collapsed', () => {
    const rendered = renderComparison(comparison([test_('TC-1', 'newlyFailing')]));

    expect(rendered).toContain('**Newly failing**');
    expect(rendered).toMatch(/\*\*Newly failing\*\*[\s\S]*TC-1/);
    // The section a reader needs must not be behind a fold.
    expect(rendered).not.toMatch(/<details><summary>Newly failing/);
  });

  test('a newly failing test carries its message and its diagnosis', () => {
    const rendered = renderComparison(comparison([
      test_('TC-1', 'newlyFailing', {
        errorMessage: 'Expected 200, got 500\nat line 42',
        failureCategory: 'ApplicationError'
      })
    ]));

    expect(rendered).toContain('Application error');
    expect(rendered).toContain('Expected 200, got 500');
    // Only the first line of a stack: the rest is noise in a comment.
    expect(rendered).not.toContain('at line 42');
  });

  test('still-failing tests are folded away as context', () => {
    const rendered = renderComparison(comparison([
      test_('TC-1', 'stillFailing'), test_('TC-2', 'stillFailing')
    ]));

    expect(rendered).toContain('<details><summary>Still failing (2)</summary>');
  });

  test('a test that stopped running is shown, not folded', () => {
    // Coverage that quietly stopped being selected is coverage nobody decided to drop,
    // and it is invisible unless something says so.
    const rendered = renderComparison(comparison([test_('TC-9', 'removed')]));

    expect(rendered).toContain('**Ran before, not this time** — TC-9');
    expect(rendered).not.toMatch(/<details><summary>Ran before/);
  });

  test('a long list of regressions is capped with a count of the rest', () => {
    const rendered = renderComparison(comparison(
      Array.from({ length: 25 }, (_, i) => test_(`TC-${i}`, 'newlyFailing'))));

    expect(rendered).toContain('…and 5 more.');
  });

  test('both runs are named, with their commits', () => {
    const rendered = renderComparison(comparison([test_('TC-1', 'newlyFailing')]));
    expect(rendered).toContain('`before @ a1b2c3d4` → `after @ a1b2c3d4`');
  });
});

describe('the wire format', () => {
  test('counts are read under the keys the API actually sends', () => {
    // Reading `counts.NewlyFailing` from a camelCase payload gives undefined, which is not
    // an error and is greater than nothing — so the gate reports no regressions and the
    // headline reads "nothing changed". The only symptom is silence.
    const payload = JSON.parse(JSON.stringify(comparison([test_('TC-1', 'newlyFailing')])));

    expect(Object.keys(payload.counts)).toContain('newlyFailing');
    expect(renderComparison(payload).split('\n')[0]).toContain('now fail');
  });
});
