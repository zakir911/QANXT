import { createInterface } from 'node:readline/promises';
import { login } from '../api.js';
import { DEFAULT_API_URL, configPath, readSession, writeSession } from '../config.js';
import { boolFlag, flag, rejectUnknownFlags, type ParsedArgs } from '../args.js';
import { CliError, ExitCode } from '../exit-codes.js';
import { bold, note, out } from '../output.js';

export const LOGIN_FLAGS = ['email', 'password', 'org', 'project', 'console-url', 'show-token'] as const;

export const LOGIN_HELP = `
${bold('qanxt login')} — store a session for later commands

  --api-url <url>        The control plane (default ${DEFAULT_API_URL}, or QANXT_API_URL)
  --org <slug>           Organization slug
  --email <address>      Account email
  --password <secret>    Password. Prefer QANXT_PASSWORD or the interactive prompt:
                         a password in argv is visible to every process on the machine.
  --project <id>         Remember a default project for later commands
  --console-url <url>    Web console base URL, used for links inside reports
  --show-token           Print the access token instead of storing it (for a pipeline secret)

A pipeline does not need this command: set QANXT_TOKEN and QANXT_API_URL instead.
`;

export async function loginCommand(args: ParsedArgs): Promise<number> {
  rejectUnknownFlags(args, LOGIN_FLAGS);

  const apiUrl = flag(args, 'api-url') ?? process.env.QANXT_API_URL ?? DEFAULT_API_URL;
  const email = flag(args, 'email') ?? process.env.QANXT_EMAIL ?? await ask('Email: ');
  const organizationSlug = flag(args, 'org') ?? process.env.QANXT_ORG ?? await ask('Organization slug: ');

  // A password on the command line lands in shell history and in every `ps` listing, so it
  // is accepted but not encouraged, and the prompt is the path of least resistance.
  const password = flag(args, 'password') ?? process.env.QANXT_PASSWORD ?? await askSecret('Password: ');

  if (!email || !password) {
    throw new CliError('An email and a password are required.', ExitCode.ConfigurationError);
  }

  const session = await login(apiUrl, { email, password, organizationSlug: organizationSlug || undefined });

  if (boolFlag(args, 'show-token')) {
    out(session.accessToken);
    note('\nStore this as a secret in your pipeline and pass it as QANXT_TOKEN.');
    return ExitCode.Success;
  }

  const existing = await readSession();
  const path = await writeSession({
    apiUrl: apiUrl.replace(/\/+$/, ''),
    consoleUrl: flag(args, 'console-url') ?? existing?.consoleUrl,
    organizationSlug: organizationSlug || undefined,
    email,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: session.expiresAt,
    projectId: flag(args, 'project') ?? existing?.projectId
  });

  note(`Signed in as ${email}. Session stored in ${path} (readable only by you).`);
  return ExitCode.Success;
}

async function ask(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new CliError(`${prompt.trim()} is required and there is no terminal to ask on.`,
      ExitCode.ConfigurationError, 'Pass it as a flag or an environment variable.');
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

/** Reads without echoing, so a shoulder-surfer and a screen recording both see nothing. */
async function askSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new CliError('A password is required and there is no terminal to ask on.',
      ExitCode.ConfigurationError, 'Set QANXT_PASSWORD, or use QANXT_TOKEN instead of logging in.');
  }

  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise<string>((resolvePromise, rejectPromise) => {
    let value = '';
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      for (const character of text) {
        if (character === '\r' || character === '\n') {
          cleanup();
          process.stderr.write('\n');
          resolvePromise(value);
          return;
        }
        if (character === '\u0003') {           // Ctrl-C
          cleanup();
          process.stderr.write('\n');
          rejectPromise(new CliError('Cancelled.', ExitCode.ConfigurationError));
          return;
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else value += character;
      }
    };
    const cleanup = (): void => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.on('data', onData);
  });
}

export { configPath };
