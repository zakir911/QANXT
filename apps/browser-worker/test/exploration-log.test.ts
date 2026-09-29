import { describe, expect, test } from 'vitest';
import { tidyForLog } from '../src/discovery/crawler.js';

/**
 * The exploration log is rendered one entry per line in the console, and people read it to
 * see which pages were reached. Playwright writes its errors for a terminal, so they arrive
 * carrying ANSI colour codes and a multi-line "Call log:" trailer full of driver internals.
 * Passed through verbatim they showed up as literal escape sequences in the middle of a list
 * of pages.
 *
 * This is also a function whose correctness is easy to lose in a refactor without anything
 * failing: an earlier version of the fix read `.split(/\r?\n/)[0] ?? ''.replace(...)`, which
 * type-checks, returns the right thing for the common case, and silently stops collapsing
 * whitespace. Hence a test per property rather than one on a realistic sample.
 */
describe('tidyForLog', () => {
  test('strips ANSI colour codes', () => {
    expect(tidyForLog('\u001b[2mnavigating\u001b[22m')).toBe('navigating');
  });

  test('strips the same codes when the escape byte has already been lost', () => {
    expect(tidyForLog('[2m  - navigating to "http://localhost:4200/"[22m'))
      .toBe('- navigating to "http://localhost:4200/"');
  });

  test('keeps the message and drops the call-log trailer', () => {
    const playwright = [
      'page.goto: Download is starting',
      'Call log:',
      '[2m  - navigating to "http://localhost:4200/statement?format=csv"[22m',
      ''
    ].join('\n');
    expect(tidyForLog(playwright)).toBe('page.goto: Download is starting');
  });

  test('collapses runs of whitespace so one entry stays one line', () => {
    expect(tidyForLog('  Mapped    /dashboard \t— 19 elements  ')).toBe('Mapped /dashboard — 19 elements');
  });

  test('leaves an ordinary message alone', () => {
    expect(tidyForLog('Signed in successfully.')).toBe('Signed in successfully.');
  });

  test('survives a message that is only a call-log trailer', () => {
    expect(tidyForLog('\n[2m  - waiting[22m')).toBe('');
  });
});
