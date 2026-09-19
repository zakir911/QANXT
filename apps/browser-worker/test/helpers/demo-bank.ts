import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const demoBankEntry = resolve(here, '../../../../samples/demo-bank/src/server.js');

export interface DemoBank {
  baseUrl: string;
  setScenario(patch: Record<string, boolean>): Promise<void>;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Starts a real Demo Bank process for a test to drive. Tests run against the actual
 * application — the platform's claim is that it works against real software, so
 * verifying it against a stub would prove nothing.
 */
export async function startDemoBank(port: number): Promise<DemoBank> {
  const child: ChildProcess = spawn(process.execPath, [demoBankEntry], {
    env: { ...process.env, DEMO_BANK_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child);

  const post = async (path: string, body?: unknown): Promise<void> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  };

  return {
    baseUrl,
    setScenario: patch => post('/__control/scenario', patch),
    reset: () => post('/__control/reset'),
    stop: () => new Promise<void>(resolvePromise => {
      if (child.exitCode !== null || child.signalCode !== null) return resolvePromise();
      child.once('exit', () => resolvePromise());
      child.kill('SIGTERM');
      setTimeout(() => { child.kill('SIGKILL'); resolvePromise(); }, 3000).unref();
    })
  };
}

async function waitForHealth(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastError = 'no attempt made';

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Demo Bank exited early with code ${child.exitCode}.`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      lastError = `health returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  child.kill('SIGKILL');
  throw new Error(`Demo Bank did not become healthy within 20s (${lastError}).`);
}
