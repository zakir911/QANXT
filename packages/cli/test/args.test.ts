import { describe, expect, test } from 'vitest';
import { boolFlag, flag, flagAll, intFlag, parseArgs, rejectUnknownFlags } from '../src/args';
import { ExitCode } from '../src/exit-codes';

describe('argument parsing', () => {
  test('reads a command, its positionals and its flags', () => {
    const args = parseArgs(['report', 'run-123', '--report-dir', './out']);
    expect(args.command).toBe('report');
    expect(args.positionals).toEqual(['run-123']);
    expect(flag(args, 'report-dir')).toBe('./out');
  });

  test('accepts --key=value as well as --key value', () => {
    expect(flag(parseArgs(['run', '--junit=./a.xml']), 'junit')).toBe('./a.xml');
    expect(flag(parseArgs(['run', '--junit', './a.xml']), 'junit')).toBe('./a.xml');
  });

  test('treats a flag followed by another flag as a boolean', () => {
    const args = parseArgs(['run', '--headed', '--json', './r.json']);
    expect(boolFlag(args, 'headed')).toBe(true);
    expect(flag(args, 'json')).toBe('./r.json');
  });

  test('collects a repeated flag rather than keeping only the last', () => {
    const args = parseArgs(['run', '--test', 'a', '--test', 'b']);
    expect(flagAll(args, 'test')).toEqual(['a', 'b']);
  });

  test('rejects a mistyped option instead of ignoring it', () => {
    // A silently ignored --junit is a green build with no report, which is the worst
    // outcome available: it looks like everything worked.
    const args = parseArgs(['run', '--juint', './a.xml']);
    expect(() => rejectUnknownFlags(args, ['junit'])).toThrowError(/Unknown option/);
    try {
      rejectUnknownFlags(args, ['junit']);
    } catch (error) {
      expect((error as { code: number }).code).toBe(ExitCode.UsageError);
    }
  });

  test('always allows the global options', () => {
    const args = parseArgs(['run', '--api-url', 'http://x', '--token', 't', '--quiet']);
    expect(() => rejectUnknownFlags(args, ['junit'])).not.toThrow();
  });

  test('refuses a non-numeric value where a number is required', () => {
    expect(() => intFlag(parseArgs(['run', '--retries', 'lots']), 'retries')).toThrowError(/expects a number/);
  });

  test('stops interpreting flags after --', () => {
    const args = parseArgs(['run', '--', '--not-a-flag']);
    expect(args.positionals).toEqual(['--not-a-flag']);
  });

  test('rejects an unknown short option rather than guessing', () => {
    expect(() => parseArgs(['run', '-x'])).toThrowError(/Unknown option/);
  });
});
