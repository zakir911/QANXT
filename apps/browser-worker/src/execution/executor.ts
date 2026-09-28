import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import type {
  AccessibilityResult, VisualComparison,
  ActionResultReport, ExecutionCompletionReport, ExecutionJob, ExecutionStatus,
  ExecutionStepPlan, HealingEventReport, LocatorDescriptor
} from '@qa-nxt/shared-types';
import { describeLocator } from '@qa-nxt/shared-types';
import { performLogin } from '../browser/authenticator.js';
import type { BrowserPool } from '../browser/browser-pool.js';
import { LocatorHealer } from '../healing/healer.js';
import { SecretMasker } from '../security/masker.js';
import type { Logger } from '../util/logger.js';
import { ActionError, evaluateAssertion, runAction, type ActionContext } from './action-runner.js';
import type { BaselineStore } from './visual-runner.js';
import {
  ApiRequestSession, ApiStatusError, ApiTransportError, evaluateResponseAssertion,
  isResponseAssertion, performApiRequest,
  type ApiRequestContextOptions, type ApiRequestOutcome
} from './api-runner.js';
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
  /**
   * Where visual baselines live.
   *
   * Passed in rather than built here because it talks to the control plane, and an
   * executor that knew how to do that would be an executor that could not be run against
   * a local directory in a test.
   */
  visualStore?: BaselineStore;
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
    // One HTTP client for the whole test, so a sequence of API calls behaves like a
    // sequence of calls from one client rather than from a dozen strangers.
    const apiSession = new ApiRequestSession();
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

      // A test that only calls APIs still runs in a browser context, because that is
      // where the session, the allowlist and the evidence collector live. The page is
      // what it can do without: opening one costs a second and a process, and an API
      // test that never inherits a UI session has no use for it.
      if (needsPage(job)) {
        page = await context.newPage();
        collector.attach(page);
      } else {
        this.logger.info('No page opened: every step in this test calls an API directly.', { executionId: job.executionId });
      }

      // A test that signs in for itself must not be signed in for.
      //
      // The recorder captures the sign-in a person performed — that is why it substitutes
      // ${secret:...} for the password field — so an imported journey usually begins at the
      // login page. Signing in first and then replaying those steps breaks on every
      // application that redirects an authenticated visitor away from its login screen,
      // which is most of them (BUG-0009). When the test starts by navigating to the
      // configured login URL, it means to do this itself.
      const testSignsInItself = auth.strategy === 'formLogin'
        && auth.loginUrl !== undefined
        && startsAtLoginPage(job.steps, auth.loginUrl);

      if (testSignsInItself) {
        this.logger.info('Skipping the configured sign-in: this test starts at the login page and signs in itself.', { executionId: job.executionId });
      }

      if (auth.strategy === 'formLogin' && !testSignsInItself && page) {
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
        resolveValue: raw => resolveReference(raw, job),
        resolveTemplate: raw => interpolateReferences(raw, job),
        visualStore: options.visualStore,
        browserName: job.browser
      };

      const apiOptions: ApiRequestContextOptions = {
        apiBaseUrl: job.apiBaseUrl ?? job.baseUrl,
        allowMutatingRequests: job.allowMutatingApiRequests !== false,
        masker,
        page
      };

      for (const [index, step] of job.steps.entries()) {
        if (signal?.aborted) { status = 'cancelled'; break; }

        collector.setCurrentAction(step.order);
        await options.onProgress?.(step.action.description, index + 1, job.steps.length);

        const result = await this.runStep(page, step, actionContext, apiOptions, apiSession, job, collector, healer, masker);
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
      await apiSession.dispose();

      if (context && job.capture.trace) {
        try {
          tracePath = join(executionDir, 'trace.zip');
          await context.tracing.stop({ path: tracePath });
          await collector.registerExternal('trace', 'trace.zip', tracePath, 'application/zip');
        } catch (error) {
          this.logger.warn('Trace capture failed', { error: String(error) });
        }
      }

      let video: ReturnType<Page['video']> | null = null;
      if (page && !page.isClosed()) {
        await collector.screenshot(page, 'final').catch(() => undefined);
        if (job.capture.video) video = page.video();
        await page.close().catch(() => undefined);
      }

      await collector.writeLogs('execution').catch(() => undefined);

      // The context must close before the video file is finalised on disk; registering it
      // any earlier records a zero-byte artifact.
      await context?.close().catch(() => undefined);

      if (video) {
        try {
          const path = await video.path();
          await collector.registerExternal('video', 'execution.webm', path, 'video/webm');
        } catch (error) {
          this.logger.warn('Video capture failed', { error: String(error) });
        }
      }
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

  /**
   * Runs one step and attaches anything the step produced on the side.
   *
   * A wrapper rather than an attachment at each return site: `runStepInner` returns from a
   * dozen places, and one of them forgetting to carry the finding would mean an
   * accessibility result that exists in the log and not in the report — the kind of gap
   * nobody notices until they go looking for evidence that is not there.
   */
  private async runStep(
    page: Page | undefined,
    step: ExecutionStepPlan,
    context: ActionContext,
    apiOptions: ApiRequestContextOptions,
    apiSession: ApiRequestSession,
    job: ExecutionJob,
    collector: EvidenceCollector,
    healer: LocatorHealer,
    masker: SecretMasker
  ): Promise<{ report: ActionResultReport; healingEvent?: HealingEventReport }> {
    const found: { accessibility?: AccessibilityResult; visual?: VisualComparison } = {};
    const outcome = await this.runStepInner(
      page, step, {
        ...context,
        onAccessibilityResult: result => { found.accessibility = result; },
        onVisualResult: comparison => { found.visual = comparison; }
      },
      apiOptions, apiSession, job, collector, healer, masker);

    if (found.accessibility === undefined && found.visual === undefined) return outcome;

    return {
      ...outcome,
      report: {
        ...outcome.report,
        ...(found.accessibility === undefined ? {} : { accessibility: found.accessibility }),
        ...(found.visual === undefined ? {} : { visual: found.visual })
      }
    };
  }

  /** Runs one step: action, healing if the locator broke, then its assertions. */
  private async runStepInner(
    page: Page | undefined,
    step: ExecutionStepPlan,
    context: ActionContext,
    apiOptions: ApiRequestContextOptions,
    apiSession: ApiRequestSession,
    job: ExecutionJob,
    collector: EvidenceCollector,
    healer: LocatorHealer,
    masker: SecretMasker
  ): Promise<{ report: ActionResultReport; healingEvent?: HealingEventReport }> {
    const startedAt = new Date();
    const started = Date.now();

    const before = job.capture.screenshotOnEveryAction && page
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
      url: page ? safeUrl(page) : step.action.apiRequest?.path,
      locatorUsed: step.action.target,
      maskedValue: masker.maskStepValue(step.action.value, isSensitiveStep(step)),
      wasHealed: false
    };

    let healingEvent: HealingEventReport | undefined;
    let locatorUsed: LocatorDescriptor | undefined = step.action.target;
    let healed = false;
    let healingConfidence: number | undefined;
    let alternatives = base.locatorAlternatives;

    // An API step has no locator, nothing to heal and a different kind of evidence, so it
    // is handled whole rather than threaded through the browser path with null checks.
    if (step.action.action === 'apiRequest') {
      return {
        report: await this.runApiStep(step, context, apiOptions, apiSession, job, collector, masker, base, started)
      };
    }

    if (!page) {
      return {
        report: {
          ...base,
          status: 'error',
          durationMs: Date.now() - started,
          errorMessage: `The step "${step.action.action}" needs a browser page, but this test opened none.`
        }
      };
    }

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
      let outcome = await evaluateAssertion(page, assertion, context);

      // An assertion whose own locator broke is healable in the same way an action's is.
      if (outcome.failure && outcome.isLocatorFailure && assertion.target) {
        const assertionHeal = await healer.attempt(page, {
          brokenLocator: assertion.target,
          fingerprint: step.fingerprint,
          testStepId: step.testStepId,
          timeoutMs: job.defaultTimeoutMs
        }, async candidate => {
          const retry = await evaluateAssertion(page, assertion, context, candidate);
          return retry.failure === null;
        });

        if (assertionHeal.kind === 'healed') {
          outcome = await evaluateAssertion(page, assertion, context, assertionHeal.locator);
          if (outcome.failure === null) {
            healed = true;
            healingConfidence = assertionHeal.confidence;
            healingEvent = assertionHeal.event;
            locatorUsed = assertionHeal.locator;
            alternatives = assertionHeal.alternatives;
          }
        } else if (assertionHeal.kind === 'proposed') {
          healingEvent ??= assertionHeal.event;
          healingConfidence ??= assertionHeal.confidence;
          alternatives = assertionHeal.alternatives;
        }
      }

      const failure = outcome.failure;
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
        // base.url — the page the action was performed on — is deliberately kept. Reading
        // the URL again here would record where the click landed instead of where it
        // happened, so "Click Sign in" would be filed against the dashboard, and the field
        // would mean one thing on a passing step and another on a failing one.
        wasHealed: healed,
        healingConfidence,
        locatorUsed,
        locatorAlternatives: alternatives,
        screenshotKeys: { before: before?.storageKey, after: after?.storageKey }
      },
      healingEvent
    };
  }

  /**
   * Runs one `apiRequest` step: perform the call, record the exchange, evaluate the
   * response assertions.
   *
   * The exchange is written as evidence on every path, including the failing ones. That is
   * the whole point of an API test being a test case: when it fails, the report can show
   * the request that was sent and the response that came back, rather than a message
   * saying an assertion did not hold.
   */
  private async runApiStep(
    step: ExecutionStepPlan,
    context: ActionContext,
    apiOptions: ApiRequestContextOptions,
    apiSession: ApiRequestSession,
    job: ExecutionJob,
    collector: EvidenceCollector,
    masker: SecretMasker,
    base: ActionResultReport,
    started: number
  ): Promise<ActionResultReport> {
    const descriptor = step.action.apiRequest;
    if (!descriptor) {
      return {
        ...base,
        status: 'error',
        durationMs: Date.now() - started,
        errorMessage: 'This step is an API request but carries no request description.'
      };
    }

    const fail = async (outcome: ApiRequestOutcome | undefined, message: string): Promise<ActionResultReport> => {
      if (outcome) {
        collector.recordApiExchange(outcome.record);
        await collector.writeApiExchange(`step-${step.order}-request`, outcome.record);
      }
      return {
        ...base,
        status: 'failed',
        durationMs: Date.now() - started,
        url: outcome?.record.requestUrl ?? base.url,
        errorMessage: masker.maskText(message)
      };
    };

    let outcome: ApiRequestOutcome;
    try {
      outcome = await performApiRequest(descriptor, context, apiOptions, apiSession);
    } catch (error) {
      // A status the test did not expect, and a request that never completed, both carry
      // the exchange with them so the failure is explainable.
      if (error instanceof ApiStatusError || error instanceof ApiTransportError) {
        return fail(error.outcome, error.message);
      }
      const message = error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error);
      return {
        ...base,
        status: 'failed',
        durationMs: Date.now() - started,
        errorMessage: masker.maskText(message)
      };
    }

    // Captured values become test data for later steps, which is how a chain of calls —
    // create, then read back what was created — is expressed without scripting.
    for (const [name, value] of Object.entries(outcome.captured)) {
      job.data[name] = value;
    }

    collector.recordApiExchange(outcome.record);
    await collector.writeApiExchange(`step-${step.order}-request`, outcome.record);

    for (const assertion of step.assertions) {
      if (!isResponseAssertion(assertion.type)) {
        // Not evaluated as if it had passed. An assertion about the page attached to a
        // step that never touched the page is a defect in the test, and saying so is the
        // only answer that does not hide it.
        return {
          ...base,
          status: 'failed',
          durationMs: Date.now() - started,
          url: outcome.record.requestUrl,
          errorMessage: `The assertion "${assertion.description || assertion.type}" is a page assertion `
            + 'attached to an API request step, so there was nothing to evaluate it against.'
        };
      }

      const result = evaluateResponseAssertion(assertion, outcome, context);
      if (result.failure && !assertion.isSoft) {
        return {
          ...base,
          status: 'failed',
          durationMs: Date.now() - started,
          url: outcome.record.requestUrl,
          errorMessage: masker.maskText(`${assertion.description || 'Assertion failed'}: ${result.failure}`)
        };
      }
      if (result.failure) {
        this.logger.warn('A soft response assertion failed', { testStepId: step.testStepId, failure: result.failure });
      }
    }

    return {
      ...base,
      status: 'passed',
      durationMs: Date.now() - started,
      url: outcome.record.requestUrl,
      // The status and timing belong in the report line, because for an API test they are
      // the result rather than a detail.
      description: `${base.description} — ${outcome.record.statusCode} in ${outcome.record.durationMs}ms`
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

/**
 * Whether this job needs a browser page at all.
 *
 * Only a test whose every step is an API request can do without one, and only when none of
 * those requests reuses the UI session — which is the case that needs a page to have signed
 * in. A missing auth mode is treated as session-reuse, because that is the default the
 * runner applies, and guessing the cheaper answer here would break the test instead.
 */
export function needsPage(job: ExecutionJob): boolean {
  if (job.steps.length === 0) return true;
  return job.steps.some(step =>
    step.action.action !== 'apiRequest'
    || (step.action.apiRequest?.auth?.mode ?? 'inheritSession') === 'inheritSession');
}

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

/**
 * Substitutes every reference inside a string.
 *
 * An unknown name throws rather than being left in place, for the same reason
 * resolveReference throws: a request sent to `/api/accounts/${data:accountId}/transactions`
 * with the placeholder intact produces a 404 that reads as an application defect, and the
 * team spends the morning looking for a route that was never missing.
 */
export function interpolateReferences(raw: string | undefined, job: ExecutionJob): string | undefined {
  if (raw === undefined) return undefined;
  if (!raw.includes('${')) return raw;

  return raw.replace(/\$\{(secret|data):([A-Za-z0-9_.-]+)\}/g, (_match, kind: string, name: string) => {
    const source = kind === 'secret' ? job.secrets : job.data;
    const value = source[name];
    if (value === undefined) {
      throw new ActionError(
        kind === 'secret'
          ? `The step references the secret "${name}", which is not configured for this environment.`
          : `The step references the test data field "${name}", which is not present in the selected data set.`,
        false);
    }
    return value;
  });
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

/**
 * True when the test's own first navigation goes to the application's login page.
 *
 * Compared by origin and path so that a query string or a trailing slash does not change
 * the answer, and only the first step counts: a journey that visits the login page halfway
 * through (to sign out and back in, say) still wants the session it started with.
 */
function startsAtLoginPage(steps: ExecutionJob['steps'], loginUrl: string): boolean {
  const first = steps.find(step => step.action.action === 'navigate');
  if (!first) return false;

  const target = first.action.url ?? first.action.value;
  if (!target) return false;

  try {
    const a = new URL(target);
    const b = new URL(loginUrl);
    return a.origin === b.origin && a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '');
  } catch {
    return false;
  }
}
