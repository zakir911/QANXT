/**
 * Worker configuration. Everything is read once at startup and validated, so a
 * misconfigured worker fails immediately and loudly rather than halfway through a run.
 */
export interface WorkerConfig {
  workerId: string;
  redisUrl: string;
  controlPlaneUrl: string;
  /** Shared secret used to identify this worker to the control plane. */
  workerToken: string;
  concurrency: number;
  headless: boolean;
  defaultBrowser: 'chromium' | 'firefox' | 'webkit';
  actionTimeoutMs: number;
  navigationTimeoutMs: number;
  /** Where evidence is written before it is uploaded. */
  artifactTempDir: string;
  /** How long a job may be held before another worker may reclaim it. */
  jobVisibilityMs: number;
  pollIntervalMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error(`${name} must be set for the browser worker to start.`);
  }
  return value.trim();
}

function int(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}; got "${value}".`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const browser = (env.WORKER_DEFAULT_BROWSER ?? 'chromium').toLowerCase();
  if (browser !== 'chromium' && browser !== 'firefox' && browser !== 'webkit') {
    throw new Error(`WORKER_DEFAULT_BROWSER must be chromium, firefox or webkit; got "${browser}".`);
  }

  const logLevel = (env.LOG_LEVEL ?? 'info').toLowerCase();
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new Error(`LOG_LEVEL must be debug, info, warn or error; got "${logLevel}".`);
  }

  return {
    workerId: env.WORKER_ID ?? `worker-${process.pid}`,
    redisUrl: env.REDIS_URL ?? 'localhost:6379',
    controlPlaneUrl: (env.API_URL ?? 'http://localhost:5080').replace(/\/+$/, ''),
    workerToken: required('WORKER_TOKEN', env.WORKER_TOKEN),
    concurrency: int('WORKER_CONCURRENCY', env.WORKER_CONCURRENCY, 2, 1, 32),
    headless: (env.WORKER_HEADLESS ?? 'true') !== 'false',
    defaultBrowser: browser,
    actionTimeoutMs: int('WORKER_ACTION_TIMEOUT_MS', env.WORKER_ACTION_TIMEOUT_MS, 15_000, 1_000, 300_000),
    navigationTimeoutMs: int('WORKER_NAVIGATION_TIMEOUT_MS', env.WORKER_NAVIGATION_TIMEOUT_MS, 30_000, 1_000, 300_000),
    artifactTempDir: env.WORKER_ARTIFACT_DIR ?? '/tmp/aira-artifacts',
    jobVisibilityMs: int('WORKER_JOB_VISIBILITY_MS', env.WORKER_JOB_VISIBILITY_MS, 15 * 60_000, 60_000, 4 * 60 * 60_000),
    pollIntervalMs: int('WORKER_POLL_INTERVAL_MS', env.WORKER_POLL_INTERVAL_MS, 2_000, 250, 60_000),
    logLevel: logLevel as WorkerConfig['logLevel']
  };
}
