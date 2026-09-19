import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import type {
  ActionResultReport, ExecutionCompletionReport, ExecutionJob, ExecutionStatus,
  ExecutionStepPlan, HealingEventReport, LocatorDescriptor
} from '@aira/shared-types';
import { describeLocator } from '@aira/shared-types';
import { performLogin } from '../browser/authenticator.js';
import type { BrowserPool } from '../browser/browser-pool.js';
import { LocatorHealer } from '../healing/healer.js';
import { SecretMasker } from '../security/masker.js';
import type { Logger } from '../util/logger.js';
import { ActionError, evaluateAssertion, runAction, type ActionContext } from './action-runner.js';
import { EvidenceCollector } from './evidence-collector.js';

/**
 * Runs one test case end to end in an isolated browser context.
 *
 * The shape of this file is the product's central claim: a plan arrives already validated,
 * the engine executes it deterministically, every step produces evidence, a broken locator
 * is a first-class recoverable event rather than a crash, and the verdict is whatever
 * actually happened. Nothing here decides that a failing test "really" passed.
 */

export interface ExecutorOptions {
  workerId: string;
  artifactRoot: string;
  onActionCompleted?: (result: ActionResultReport) => void | Promise<void>;
  onProgress?: (message: string, stepIndex: number, stepCount: number) => void | Promise<void>;
}

export class TestExecutor {
  constructor(
    private readonly pool: BrowserPool,
    private readonly logger: Logger
  ) {}

  async execute(job: ExecutionJob, options: ExecutorOptions, signal?: AbortSignal): Promise<ExecutionCompletionReport> {
    const startedAt = new Date();
    const executionDir = join(options.artifactRoot, job.executionId);
    await mkdir(executionDir, { recursive: true });

    const masker = new SecretMasker()
      .withLiterals(Object.values(job.secrets))
      .withLiteral(job.auth.password)
      .withLiteral(job.auth.bearerToken);

    const collector = new EvidenceCollector(executionDir, masker, this.logger);
    const healer = new LocatorHealer(job.healing, this.logger);
    const actions: ActionResultReport[] = [];
    const healingEvents: HealingEventReport[] = [];

    let context: BrowserContext | undefined;
    let page: Page | undefined;
    let status: ExecutionStatus = 'running';
    let errorMessage: string | undefined;
    let errorStack: string | undefined;
    let stepsPassed = 0;
    let stepsFailed = 0;
    let stepsHealed = 0;
    let browserVersion = '';
    let tracePath: string | undefined;

    try {
      browserVersion = await this.pool.version(job.browser);

      // Credentials may arrive as ${secret:...} references, exactly like step values.
      // They are resolved once, here, and never written to the job record or to evidence.
      const auth = {
        ...job.auth,
        username: resolveReference(job.auth.username, job),
        password: resolveReference(job.auth.password, job),
        bearerToken: resolveReference(job.auth.bearerToken, job)
      };
      masker.withLiterals([auth.password, auth.bearerToken]);

      context = await this.pool.createContext(job.browser, {
        defaultTimeoutMs: job.defaultTimeoutMs,
        navigationTimeoutMs: Math.max(job.defaultTimeoutMs, 30_000),
        videoDir: job.capture.video ? join(executionDir, 'video') : undefined,
        extraHeaders: auth.strategy === 'bearerToken' && auth.bearerToken
          ? { authorization: `Bearer ${auth.bearerToken}` }
          : undefined,
        httpCredentials: auth.strategy === 'basicAuth' && auth.username && auth.password
          ? { username: auth.username, password: auth.password }
          : undefined,
        storageState: auth.strategy === 'storageState' && auth.storageStateJson
          ? JSON.parse(auth.storageStateJson)
          : undefined
      });

      if (job.capture.trace) {
        await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      }

      page = await context.newPage();
      collector.attach(page);

      if (auth.strategy === 'formLogin') {
        const login = await performLogin(page, auth, {
          navigationTimeoutMs: Math.max(job.defaultTimeoutMs, 30_000),
          actionTimeoutMs: job.defaultTimeoutMs
        });
        if (!login.succeeded) {
          // Not a test failure: the test never got a chance to run. Reporting it as one
          // would attribute an environment problem to the application under test.
          status = 'blocked';
          errorMessage = `Preconditions were not met — ${login.message}`;
          await collector.screenshot(page, 'login-failure', true);
          throw new PreconditionError(errorMessage);
        }
      }

      const actionContext: ActionContext = {
        defaultTimeoutMs: job.defaultTimeoutMs,
        allowScriptExecution: job.allowScriptExecution,
        allowedHosts: job.allowedHosts,
        allowPrivateNetworks: job.allowPrivateNetworks,
        baseUrl: job.baseUrl,
        resolveValue: raw => resolveReference(raw, job)
      };

      for (const [index, step] of job.steps.entries()) {
        if (signal?.aborted) { status = 'cancelled'; break; }

        collector.setCurrentAction(step.order);
        await options.onProgress?.(step.action.description, index + 1, job.steps.length);

        const result = await this.runStep(page, step, actionContext, job, collector, healer, masker);
        actions.push(result.report);
        if (result.healingEvent) healingEvents.push(result.healingEvent);
        await options.onActionCompleted?.(result.report);

        if (result.report.status === 'passed') stepsPassed++;
        else if (result.report.status === 'healed') { stepsPassed++; stepsHealed++; }
        else {
          stepsFailed++;
          if (step.action.critical !== false && !step.continueOnFailure) {
            status = 'failed';
            errorMessage = result.report.errorMessage;
            break;
          }
        }
      }

      if (status === 'running') {
        status = stepsFailed > 0 ? 'failed' : stepsHealed > 0 ? 'healed' : 'passed';
        if (stepsFailed > 0) {
          errorMessage ??= actions.find(a => a.status === 'failed')?.errorMessage;
        }
      }
    } catch (error) {
      if (error instanceof PreconditionError) {
        status = 'blocked';
      } else {
        status = 'error';
        errorMessage = masker.maskText(error instanceof Error ? error.message : String(error));
        errorStack = masker.maskText(error instanceof Error ? (error.stack ?? '') : '');
        this.logger.error('The execution failed outside of a test step', error, { executionId: job.executionId });
      }
    } finally {
      collector.setCurrentAction(undefined);

      if (context && job.capture.trace) {
        try {
          tracePath = join(executionDir, 'trace.zip');
          await context.tracing.stop({ path: tracePath });
          await collector.registerExternal('trace', 'trace.zip', tracePath, 'application/zip');
        } catch (error) {
          this.logger.warn('Trace capture failed', { error: String(error) });
        }
      }

      if (page && !page.isClosed()) {
        await collector.screenshot(page, 'final').catch(() => undefined);
        if (job.capture.video) {
          const video = page.video();
          await page.close().catch(() => undefined);
          if (video) {
            try {
              const path = await video.path();
              await collector.registerExternal('video', 'execution.webm', path, 'video/webm');
            } catch (error) {
              this.logger.warn('Video capture failed', { error: String(error) });
            }
          }
        }
      }

      await collector.writeLogs('execution').catch(() => undefined);
      await context?.close().catch(() => undefined);
    }

    const completedAt = new Date();
    return {
      executionId: job.executionId,
      status,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      browserVersion,
      workerId: options.workerId,
      stepsTotal: job.steps.length,
      stepsPassed,
      stepsFailed,
      stepsHealed,
      consoleErrorCount: collector.countConsoleErrors(),
      networkErrorCount: collector.countNetworkErrors(),
      errorMessage,
      errorStack,
      artifacts: collector.getArtifacts(),
      consoleEvents: collector.getConsoleEvents(),
      networkEvents: collector.getNetworkEvents(),
      healingEvents
    };
  }

  /** Runs one step: action, healing if the locator broke, then its assertions. */
  private async runStep(
    page: Page,
    step: ExecutionStepPlan,
    context: ActionContext,
    job: ExecutionJob,
    collector: EvidenceCollector,
    healer: LocatorHealer,
    masker: SecretMasker
  ): Promise<{ report: ActionResultReport; healingEvent?: HealingEventReport }> {
    const startedAt = new Date();
    const started = Date.now();

    const before = job.capture.screenshotOnEveryAction
      ? await collector.screenshot(page, `step-${step.order}-before`)
      : undefined;

    const base: ActionResultReport = {
      order: step.order,
      testStepId: step.testStepId,
      action: step.action.action,
      description: step.action.description,
      status: 'running',
      startedAt: startedAt.toISOString(),
      durationMs: 0,
      url: safeUrl(page),
      locatorUsed: step.action.target,
      maskedValue: masker.maskStepValue(step.action.value, isSensitiveStep(step)),
      wasHealed: false
    };

    let healingEvent: HealingEventReport | undefined;
    let locatorUsed: LocatorDescriptor | undefined = step.action.target;
    let healed = false;
    let healingConfidence: number | undefined;
    let alternatives = base.locatorAlternatives;

    try {
      await runAction(page, step.action, context);
    } catch (error) {
      const actionError = error instanceof ActionError ? error : undefined;

      if (actionError?.isLocatorFailure && step.action.target) {
        const outcome = await healer.attempt(page, {
          brokenLocator: step.action.target,
          fingerprint: step.fingerprint,
          testStepId: step.testStepId,
          timeoutMs: job.defaultTimeoutMs
        }, async candidate => {
          // The verification the healing contract demands: the replacement is accepted
          // only if the action it was standing in for actually succeeded.
          try {
            await runAction(page, step.action, context, candidate);
            return true;
          } catch {
            return false;
          }
        });

        alternatives = outcome.alternatives;
        if (outcome.kind === 'healed') {
          healed = true;
          locatorUsed = outcome.locator;
          healingConfidence = outcome.confidence;
          healingEvent = outcome.event;
        } else {
          if (outcome.kind === 'proposed') {
            healingEvent = outcome.event;
            healingConfidence = outcome.confidence;
          }
          return {
            report: {
              ...base,
              status: 'failed',
              durationMs: Date.now() - started,
              errorMessage: masker.maskText(describeFailure(error, step.action.target)),
              locatorAlternatives: alternatives,
              healingConfidence,
              screenshotKeys: await this.failureEvidence(page, step, collector, job, before)
            },
            healingEvent
          };
        }
      } else {
        return {
          report: {
            ...base,
            status: 'failed',
            durationMs: Date.now() - started,
            errorMessage: masker.maskText(error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error)),
            screenshotKeys: await this.failureEvidence(page, step, collector, job, before)
          }
        };
      }
    }

    // Assertions run after the action, including after a heal: a healed locator that
    // reaches the wrong element shows up here rather than silently passing.
    for (const assertion of step.assertions) {
      const failure = await evaluateAssertion(page, assertion, context);
      if (failure && !assertion.isSoft) {
        return {
          report: {
            ...base,
            status: 'failed',
            durationMs: Date.now() - started,
            wasHealed: healed,
            healingConfidence,
            locatorUsed,
            locatorAlternatives: alternatives,
            errorMessage: masker.maskText(`${assertion.description || 'Assertion failed'}: ${failure}`),
            screenshotKeys: await this.failureEvidence(page, step, collector, job, before)
          },
          healingEvent
        };
      }
      if (failure) {
        this.logger.warn('A soft assertion failed', { testStepId: step.testStepId, failure });
      }
    }

    const after = job.capture.screenshotOnEveryAction
      ? await collector.screenshot(page, `step-${step.order}-after`)
      : undefined;

    return {
      report: {
        ...base,
        status: healed ? 'healed' : 'passed',
        durationMs: Date.now() - started,
        url: safeUrl(page),
        wasHealed: healed,
        healingConfidence,
        locatorUsed,
        locatorAlternatives: alternatives,
        screenshotKeys: { before: before?.storageKey, after: after?.storageKey }
      },
      healingEvent
    };
  }

  private async failureEvidence(
    page: Page, step: ExecutionStepPlan, collector: EvidenceCollector,
    job: ExecutionJob, before?: { storageKey: string }
  ): Promise<{ before?: string; after?: string }> {
    // A failure is the one moment where evidence is never optional.
    const after = await collector.screenshot(page, `step-${step.order}-failure`, true);
    if (job.capture.domSnapshotOnFailure) {
      await collector.domSnapshot(page, `step-${step.order}-failure`);
      await collector.accessibilitySnapshot(page, `step-${step.order}-failure`);
    }
    return { before: before?.storageKey, after: after?.storageKey };
  }
}

class PreconditionError extends Error {}

/** Resolves ${secret:x} and ${data:x} references against the job's resolved values. */
export function resolveReference(raw: string | undefined, job: ExecutionJob): string | undefined {
  if (raw === undefined) return undefined;

  const secret = /^\$\{secret:([A-Za-z0-9_.-]+)\}$/.exec(raw);
  if (secret?.[1]) {
    const value = job.secrets[secret[1]];
    if (value === undefined) {
      throw new ActionError(`The step references the secret "${secret[1]}", which is not configured for this environment.`, false);
    }
    return value;
  }

  const data = /^\$\{data:([A-Za-z0-9_.-]+)\}$/.exec(raw);
  if (data?.[1]) {
    const value = job.data[data[1]];
    if (value === undefined) {
      throw new ActionError(`The step references the test data field "${data[1]}", which is not present in the selected data set.`, false);
    }
    return value;
  }

  return raw;
}

function isSensitiveStep(step: ExecutionStepPlan): boolean {
  const value = step.action.value ?? '';
  if (value.startsWith('${secret:')) return true;
  const target = step.action.target;
  return target?.strategy === 'css' && target.value.includes('password')
    || (target?.name ?? '').toLowerCase().includes('password')
    || (step.fingerprint?.type ?? '') === 'password';
}

function describeFailure(error: unknown, locator: LocatorDescriptor): string {
  const message = error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error);
  return `${describeLocator(locator)} could not be used: ${message}`;
}

function safeUrl(page: Page): string | undefined {
  try { return page.url(); } catch { return undefined; }
}

/** Removes an execution's temporary artifact directory once the files are uploaded. */
export async function cleanupExecutionArtifacts(artifactRoot: string, executionId: string): Promise<void> {
  await rm(join(artifactRoot, executionId), { recursive: true, force: true });
}
