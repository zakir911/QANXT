import { describe, expect, test } from 'vitest';
import { EXIT_CODE_TABLE, ExitCode } from '../src/exit-codes.js';

/**
 * The exit codes are a contract with every pipeline that branches on them, so they get
 * tests of their own rather than being checked incidentally by whatever happens to throw.
 */
describe('exit codes', () => {
  test('every code in the table is distinct and matches its constant', () => {
    const codes = EXIT_CODE_TABLE.map(entry => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('the table documents every code the CLI can return', () => {
    const declared = new Set(Object.values(ExitCode));
    const documented = new Set(EXIT_CODE_TABLE.map(entry => entry.code));
    expect(documented).toEqual(declared);
  });

  test('a test failure and a quality gate failure are different codes', () => {
    // They go to different people. Collapsing them was the old behaviour and the reason a
    // pipeline could not tell "the application broke" from "the rule was too strict".
    expect(ExitCode.TestFailure).not.toBe(ExitCode.QualityGateFailure);
  });

  test('review is not success and not failure', () => {
    expect(ExitCode.HumanReviewRequired).not.toBe(ExitCode.Success);
    expect(ExitCode.HumanReviewRequired).not.toBe(ExitCode.QualityGateFailure);
    expect(ExitCode.HumanReviewRequired).not.toBe(ExitCode.TestFailure);
  });

  test('every name is the screaming-snake form a pipeline would grep for', () => {
    for (const entry of EXIT_CODE_TABLE) {
      expect(entry.name).toMatch(/^[A-Z_]+$/);
      expect(entry.meaning.length).toBeGreaterThan(10);
    }
  });
});
