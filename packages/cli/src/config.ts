import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError, ExitCode } from './exit-codes.js';

/**
 * Where the CLI keeps its session, and how a pipeline supplies one instead.
 *
 * A CI runner must never need an interactive login, so every value can come from the
 * environment; the stored file is a convenience for a person at a terminal. The file holds a
 * refreshable session, so it is created 0600 and never logged — a token printed into a build
 * log is a credential leak that outlives the build.
 */

export interface StoredSession {
  apiUrl: string;
  consoleUrl?: string;
  organizationSlug?: string;
  email?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  projectId?: string;
}

export const DEFAULT_API_URL = 'http://127.0.0.1:5080';

export function configPath(): string {
  return process.env.QANXT_CONFIG ?? join(homedir(), '.qanxt', 'config.json');
}

export async function readSession(): Promise<StoredSession | undefined> {
  try {
    const raw = await readFile(configPath(), 'utf8');
    return JSON.parse(raw) as StoredSession;
  } catch {
    return undefined;
  }
}

export async function writeSession(session: StoredSession): Promise<string> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  // writeFile's mode only applies when it creates the file, so an existing one is corrected.
  await chmod(path, 0o600);
  return path;
}

export interface ResolvedContext {
  apiUrl: string;
  consoleUrl?: string | undefined;
  token: string;
  projectId?: string | undefined;
}

/**
 * Resolves the session a command should use. The environment wins over the stored file so a
 * pipeline is never surprised by a developer's leftover login on a shared runner.
 */
export async function resolveContext(overrides: {
  apiUrl?: string | undefined;
  token?: string | undefined;
  projectId?: string | undefined;
} = {}): Promise<ResolvedContext> {
  const stored = await readSession();

  const apiUrl = overrides.apiUrl ?? process.env.QANXT_API_URL ?? stored?.apiUrl ?? DEFAULT_API_URL;
  const token = overrides.token ?? process.env.QANXT_TOKEN ?? stored?.accessToken;
  const projectId = overrides.projectId ?? process.env.QANXT_PROJECT_ID ?? stored?.projectId;
  const consoleUrl = process.env.QANXT_CONSOLE_URL ?? stored?.consoleUrl;

  if (!token) {
    throw new CliError(
      'No session. Sign in first, or supply a token.',
      ExitCode.AuthenticationError,
      'Run "qanxt login", or set QANXT_TOKEN (and QANXT_API_URL) in your pipeline.');
  }

  return { apiUrl: apiUrl.replace(/\/+$/, ''), consoleUrl, token, projectId };
}
