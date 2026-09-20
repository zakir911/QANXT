import { usage } from './exit-codes.js';

/**
 * A small argument parser.
 *
 * A dependency would do this, but the CLI is what a pipeline installs, and every dependency
 * in it is something a security team has to vet and something that can break a build at a
 * bad moment. The grammar here is deliberately small: --flag, --key value, --key=value, and
 * positionals. Anything unrecognised is an error rather than a silent no-op, because a
 * mistyped --junit path that is quietly ignored produces a green build with no report.
 */

export interface ParsedArgs {
  command?: string;
  positionals: string[];
  flags: Map<string, string[]>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();

  const add = (key: string, value: string): void => {
    const existing = flags.get(key);
    if (existing) existing.push(value);
    else flags.set(key, [value]);
  };

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;

    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const equals = body.indexOf('=');
      if (equals >= 0) {
        add(body.slice(0, equals), body.slice(equals + 1));
        continue;
      }
      const next = argv[index + 1];
      // A flag followed by another flag, or by nothing, is a boolean.
      if (next === undefined || next.startsWith('--')) add(body, 'true');
      else { add(body, next); index++; }
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      const short = token.slice(1);
      if (short === 'h') { add('help', 'true'); continue; }
      if (short === 'v') { add('version', 'true'); continue; }
      throw usage(`Unknown option "${token}".`, 'Run "aira --help" to see the options.');
    }

    positionals.push(token);
  }

  const [command, ...rest] = positionals;
  return { command, positionals: rest, flags };
}

export function flag(args: ParsedArgs, name: string): string | undefined {
  return args.flags.get(name)?.at(-1);
}

export function flagAll(args: ParsedArgs, name: string): string[] {
  return args.flags.get(name) ?? [];
}

export function boolFlag(args: ParsedArgs, name: string): boolean {
  const value = flag(args, name);
  if (value === undefined) return false;
  return value !== 'false' && value !== '0' && value !== 'no';
}

export function intFlag(args: ParsedArgs, name: string): number | undefined {
  const value = flag(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw usage(`--${name} expects a number, got "${value}".`);
  }
  return parsed;
}

/** Fails on anything the command does not define, rather than ignoring it. */
export function rejectUnknownFlags(args: ParsedArgs, known: readonly string[]): void {
  const allowed = new Set([...known, 'help', 'api-url', 'token', 'quiet']);
  const unknown = [...args.flags.keys()].filter(key => !allowed.has(key));
  if (unknown.length > 0) {
    throw usage(
      `Unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.map(u => `--${u}`).join(', ')}.`,
      `Known options: ${[...allowed].sort().map(k => `--${k}`).join(', ')}.`);
  }
}
