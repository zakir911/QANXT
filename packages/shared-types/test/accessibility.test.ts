import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  ACCESSIBILITY_IMPACTS, DEFAULT_ACCESSIBILITY_FAIL_ON, DEFAULT_ACCESSIBILITY_STANDARDS,
  describeAccessibility, meetsThreshold, type AccessibilityResult
} from '../src/accessibility.js';

/**
 * The two rules that decide what an accessibility check means.
 *
 * The threshold, because it decides what fails a build. And the wording of a clean result,
 * because a tool that reports "no violations" as "accessible" does real harm: a team reads
 * it as a clearance and stops looking, and automated checks find roughly a third of WCAG
 * issues.
 */

const result = (overrides: Partial<AccessibilityResult> = {}): AccessibilityResult => ({
  url: 'http://app.test/',
  standards: ['wcag2a', 'wcag2aa', 'wcag21aa'],
  violations: [],
  passCount: 21,
  incompleteCount: 0,
  counts: { critical: 0, serious: 0, moderate: 0, minor: 0 },
  excluded: [],
  ignoredRules: [],
  engine: { name: 'axe-core', version: '4.13.0' },
  scannedAt: '2026-09-22T00:00:00Z',
  ...overrides
});

test('the impact order runs worst to least', () => {
  assert.deepEqual([...ACCESSIBILITY_IMPACTS], ['critical', 'serious', 'moderate', 'minor']);
});

test('a threshold includes everything at least as bad as itself', () => {
  assert.equal(meetsThreshold('critical', 'serious'), true);
  assert.equal(meetsThreshold('serious', 'serious'), true);
  assert.equal(meetsThreshold('moderate', 'serious'), false);
  assert.equal(meetsThreshold('minor', 'serious'), false);
});

test('a threshold of minor includes everything', () => {
  for (const impact of ACCESSIBILITY_IMPACTS) {
    assert.equal(meetsThreshold(impact, 'minor'), true, impact);
  }
});

test('a violation with no impact never crosses a threshold', () => {
  // axe leaves impact null on some rules. Treating null as critical would fail builds on
  // findings axe itself declined to rank.
  for (const threshold of ACCESSIBILITY_IMPACTS) {
    assert.equal(meetsThreshold(null, threshold), false, threshold);
  }
});

test('the default threshold is serious, not minor', () => {
  // A step that fails on every minor finding is a step a team disables in week two, and a
  // disabled check finds nothing at all.
  assert.equal(DEFAULT_ACCESSIBILITY_FAIL_ON, 'serious');
});

test('the default standards are conformance levels, not best practice', () => {
  // best-practice is axe's own advice rather than a WCAG requirement. Failing a build on
  // advice nobody agreed to is how a check gets switched off.
  assert.deepEqual(DEFAULT_ACCESSIBILITY_STANDARDS, ['wcag2a', 'wcag2aa', 'wcag21aa']);
  assert.equal(DEFAULT_ACCESSIBILITY_STANDARDS.includes('best-practice' as never), false);
});

test('a clean result never claims the page is accessible', () => {
  const described = describeAccessibility(result());

  assert.match(described, /No violations found by wcag2a, wcag2aa, wcag21aa/);
  assert.match(described, /21 rule\(s\) passed/);
  // The sentence that stops a clean result being read as a clearance.
  assert.match(described, /roughly a third of accessibility problems/);
  assert.doesNotMatch(described, /\bis accessible\b/);
});

test('a clean result says how many checks need a person', () => {
  // Dropping them would overstate how much was checked: "0 violations" and "0 violations,
  // 12 things a machine could not decide" are different reports.
  assert.match(describeAccessibility(result({ incompleteCount: 12 })), /12 need a person to check/);
});

test('a result with violations counts them by impact', () => {
  const described = describeAccessibility(result({
    violations: [
      { id: 'label', impact: 'critical', description: '', help: '', helpUrl: '', tags: [], nodes: [] },
      { id: 'color-contrast', impact: 'serious', description: '', help: '', helpUrl: '', tags: [], nodes: [] },
      { id: 'region', impact: 'moderate', description: '', help: '', helpUrl: '', tags: [], nodes: [] }
    ],
    counts: { critical: 1, serious: 1, moderate: 1, minor: 0 }
  }));

  assert.match(described, /3 violation\(s\)/);
  assert.match(described, /1 critical, 1 serious, 1 moderate/);
  // Bands with nothing in them are left out rather than printed as zero.
  assert.doesNotMatch(described, /0 minor/);
});
