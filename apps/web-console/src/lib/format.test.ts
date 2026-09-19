import { describe, expect, test } from 'vitest';
import { formatBytes, formatDuration, formatPercent, humanize } from './format';

describe('formatDuration', () => {
  test('renders sub-second values in milliseconds', () => {
    expect(formatDuration(450)).toBe('450ms');
  });

  test('renders seconds with one decimal', () => {
    expect(formatDuration(1500)).toBe('1.5s');
  });

  test('renders minutes and seconds for long runs', () => {
    expect(formatDuration(125_000)).toBe('2m 5s');
  });

  test('renders an em dash rather than "0ms" when there is no value', () => {
    // A missing duration and a zero duration mean different things; conflating them
    // makes a queued execution look instantaneous.
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
  });
});

describe('formatBytes', () => {
  test.each([
    [512, '512 B'],
    [2048, '2.0 KB'],
    [5_242_880, '5.0 MB']
  ])('formats %i as %s', (input, expected) => {
    expect(formatBytes(input)).toBe(expected);
  });

  test('renders an em dash for absent sizes', () => {
    expect(formatBytes(undefined)).toBe('—');
  });
});

describe('formatPercent', () => {
  test('drops a trailing .0', () => {
    expect(formatPercent(100)).toBe('100%');
  });

  test('keeps one decimal when it carries information', () => {
    expect(formatPercent(57.14)).toBe('57.1%');
  });
});

describe('humanize', () => {
  test.each([
    ['applicationDefect', 'Application defect'],
    ['locatorChange', 'Locator change'],
    ['passed', 'Passed']
  ])('renders %s as %s', (input, expected) => {
    expect(humanize(input)).toBe(expected);
  });

  test('handles absent values', () => {
    expect(humanize(null)).toBe('—');
  });
});
