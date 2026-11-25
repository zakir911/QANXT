import type { SecurityIdentity, SecurityScanJob, SecurityTarget } from '@qa-nxt/shared-types';
import {
  SEVERITY_ORDER, CONFIDENCE_ORDER, SecurityScanner, at, authHeaders, isSignedIn,
  api, auth, authz, injection, passive, request, xss
} from '@qa-nxt/security-engine';
import type { CheckResult, SecurityFinding, SecurityScanner as Scanner } from '@qa-nxt/security-engine';
import { ControlPlaneClient } from '../api/control-plane-client.js';
import type { WorkerConfig } from '../config.js';
import type { BrowserContext } from 'playwright';
import type { BrowserPool } from '../browser/browser-pool.js';
import { checkDomXssInBrowser } from './dom-xss.js';
import { issuableAddress } from './issuable-address.js';
import { probeOrder } from './probe-order.js';
import { identifierFromSample } from './discovered-resource.js';
import { stateChangingScanner } from './state-changing-floor.js';
import type { Logger } from '../util/logger.js';

/**
 * Running a security scan.
 *
 * The engine is shared with the golden suites — same files, one copy — so what runs here is
 * the program the verification measured. A worker with its own copy of the checks would make
 * the whole verification suite a statement about a different piece of software.
 *
 * Three things this handler does that are worth knowing before reading it:
 *
 *   It never decides what it is allowed to do. The scope arrives in the job, already written
 *   by a person and already checked by the control plane. The worker cannot widen it, cannot
 *   look one up, and the guard inside `SecurityScanner.request` refuses anything outside it.
 *
 *   It reports what it did not run. A check that was refused, threw, or found nothing to
 *   point at is recorded and does not appear in `checksExecuted` — so the gate divides a
 *   truthful numerator by a truthful denominator and a partial scan cannot come back green.
 *
 *   A check that throws does not fail the scan. It is recorded as not executed and the rest
 *   continue. One broken check aborting a scan would turn a small defect into no coverage at
 *   all, and the report would show a scan that "ran" and found nothing.
 */

type CheckRunner = (scanner: Scanner, target: SecurityTarget, context: ScanContext) => Promise<CheckResult>;

export interface ScanContext {
  baseUrl: string;
  identities: Map<string, SignedInIdentity>;
  logger: Logger;
  /**
   * A browser, for the one check that needs one.
   *
   * Null when the worker could not start one. A check needing it then reports inconclusive
   * rather than clean, so a browser that failed to launch costs coverage and never looks like
   * a page that was examined and found safe.
   */
  browser: BrowserContext | null;
}

export interface SignedInIdentity extends SecurityIdentity {
  /**
   * The headers that make a request act as this identity.
   *
   * A cookie is one case of that, not the shape of the idea. The engine learned this and
   * the worker did not: it discarded any session that came back without a Set-Cookie and
   * passed only `{ cookie }` to every check, so an application authenticating with HTTP
   * Basic or a bearer token produced no identity at all. A scan of a Basic-protected permit
   * register reported every authorization check "an owning identity is needed" with the
   * credentials sitting in its own configuration.
   */
  headers: Record<string, string>;
  cookie: string | null;
  csrf: string | null;
}

/**
 * What a check needs to act as somebody: the headers, and who it is.
 *
 * Exported, with `signInIdentities`, because this pair is where the identity model is
 * actually applied and nothing could reach it from a test. The engine's own identity rules
 * were covered; the two lines here that discarded every non-cookie session were not, so a
 * whole class of application — HTTP Basic, bearer tokens — produced no identity and every
 * authorization check reported inconclusive.
 */
export const asActor = (identity: SignedInIdentity) =>
  ({ headers: identity.headers, cookie: identity.cookie, label: identity.label });

/** What one check did, whether or not it found anything. */
interface CheckOutcome {
  check: string;
  target: string;
  executed: boolean;
  findings: SecurityFinding[];
  note: string;
}

export async function handleSecurityScanJob(
  job: SecurityScanJob,
  pool: BrowserPool,
  config: WorkerConfig,
  logger: Logger,
  signal: AbortSignal
): Promise<void> {
  const log = logger.child({ securityScanId: job.securityScanId, correlationId: job.correlationId });
  const client = new ControlPlaneClient({
    baseUrl: job.callbackBaseUrl || config.controlPlaneUrl,
    token: job.callbackToken,
    logger: log,
    job: { id: job.securityScanId, scope: 'security' },
    workerSecret: config.workerToken
  });

  log.info('Security scan starting', {
    profile: job.profile,
    targets: job.targets.length,
    checksToRun: job.checksToRun.length,
    checksConfigured: job.checksConfigured.length
  });

  const scanner = new SecurityScanner({
    scope: {
      enabled: job.scope.enabled,
      authorizationNote: job.scope.authorizationNote,
      allowedDomains: job.scope.allowedDomains,
      allowedApiDomains: job.scope.allowedApiDomains,
      allowedPaths: job.scope.allowedPaths,
      blockedPaths: job.scope.blockedPaths,
      environmentId: job.scope.environmentId,
      maxRequestsPerSecond: job.scope.maxRequestsPerSecond,
      maxConcurrentRequests: job.scope.maxConcurrentRequests,
      maxScanDurationMinutes: job.scope.maxScanDurationMinutes,
      allowActiveTesting: job.scope.allowActiveTesting,
      allowDestructiveTesting: job.scope.allowDestructiveTesting,
      allowProduction: job.scope.allowProduction
    },
    profile: job.profile as never,
    context: {
      environmentId: job.environmentId ?? undefined,
      isProductionEnvironment: job.isProductionEnvironment,
      productionTestingAuthorized: job.productionTestingAuthorized,
      callerMayRunActiveScans: true,
      callerMayRunDestructiveScans: job.callerMayRunDestructiveScans,
      // What the owner said about this application's sign-in. The authentication checks
      // need a failed sign-in to actually happen; without this the engine guessed an
      // address, and against an API whose sign-in is elsewhere every attempt was a 404.
      signIn: job.signIn
    }
  });

  const started = Date.now();

  // Opened only when something in this scan needs it, and closed however the scan ends.
  // A browser is by far the most expensive thing the worker holds, and most scans never
  // touch one: every check but xss.dom is decided from a response.
  const needsBrowser = job.targets.some(
    target => target.checks.some(check => BROWSER_CHECKS.has(check) && job.checksToRun.includes(check)));

  let browser: BrowserContext | null = null;
  if (needsBrowser) {
    try {
      browser = await pool.createContext(config.defaultBrowser, {
        defaultTimeoutMs: 10_000,
        navigationTimeoutMs: 20_000
      });
    } catch (error) {
      // Recorded, not fatal. The checks needing it report inconclusive, which costs their
      // coverage and never reads as a page examined and found safe.
      log.error('A browser could not be started; the checks that need one will be inconclusive', error);
    }
  }

  const context: ScanContext = {
    baseUrl: job.baseUrl,
    identities: await signInIdentities(scanner, job, log),
    logger: log,
    browser
  };

  const outcomes: CheckOutcome[] = [];
  const wanted = new Set(job.checksToRun);

  // Closed however this ends. A browser leaked by a scan that threw is held until the worker
  // restarts, and a worker that leaks one per failed scan runs out of memory rather than
  // reporting a problem anybody can see.
  try {
    for (const target of job.targets) {
      if (signal.aborted) {
        log.warn('The scan was aborted; the remaining targets were not reached');
        break;
      }

      // Order matters against an address that changes state: the first probe is the only one
      // that sees the application as it was. See probe-order.ts, which was written after a
      // check whose whole job is observing a change reported that it had seen none, of a
      // change five earlier probes against the same address had already spent.
      for (const check of probeOrder(target.checks, target.changesState)) {
        if (!wanted.has(check)) continue;

        const runner = RUNNERS[check];
        if (!runner) {
          // A check the surface implied and this worker cannot run. Recorded rather than
          // ignored: it is the difference between a gap somebody can see and one nobody can.
          outcomes.push({
            check, target: target.identifier, executed: false, findings: [],
            note: `This worker has no runner for ${check}, so it did not execute.`
          });
          continue;
        }

        // Every runner below is handed the address that can actually be issued, so none of
        // them has to know that the identifier is a template.
        const runnable = { ...target, identifier: issuableAddress(target) };

        // And against an address the surface established changes something, every probe is
        // declared state-changing however the check describes its own request. The scope
        // guard already holds that a verb may raise a declared risk and never lower it; the
        // same is true of the address, and only the surface knows that part.
        //
        // Without this, a check that declares its request merely active -- correct for a read
        // -- is describing a mutation, and the guard waves it through on an authorisation
        // nobody gave. That is the one rule this product is built around.
        const probeScanner = target.changesState ? stateChangingScanner(scanner) : scanner;
        const outcome = await runOne(check, runnable, runner, probeScanner, context);
        // Logged per check, because a scan that reports only its findings cannot be debugged
        // and cannot be trusted: "no finding" and "never ran" look identical from the
        // outside, which is the exact confusion this product exists to remove. The reason a
        // check did not conclude is the most useful line in a scan and it was going nowhere.
        context.logger.info('Security check finished', {
          check, target: target.identifier, executed: outcome.executed,
          findings: outcome.findings.length, note: outcome.note
        });
        outcomes.push(outcome);
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  const summary = scanner.summary();
  const executed = [...new Set(outcomes.filter(o => o.executed).map(o => o.check))];
  const findings = outcomes.flatMap(o => o.findings);

  log.info('Security scan finished', {
    requestsIssued: summary.requestsIssued,
    requestsBlocked: summary.requestsBlocked,
    checksExecuted: executed.length,
    checksConfigured: job.checksConfigured.length,
    findings: findings.length
  });

  await client.securityScanCompleted(job.securityScanId, {
    workerId: config.workerId,
    requestsIssued: summary.requestsIssued,
    testsExecuted: executed.length,
    testsSkipped: job.checksConfigured.length - executed.length,
    durationMs: Date.now() - started,
    checksConfigured: job.checksConfigured,
    checksExecuted: executed,
    untestedAreas: untestedAreas(job, outcomes),
    findings: findings.map(toReport),
    blockedRequests: summary.blocked.map(blocked => ({
      url: blocked.url,
      httpMethod: String(blocked.method ?? 'GET'),
      risk: blocked.risk,
      reason: blocked.reason,
      explanation: blocked.explanation,
      testId: blocked.testId ?? null
    }))
  });
}

/**
 * Runs one check and records what happened, whatever happened.
 *
 * A check that throws is recorded as not executed rather than allowed to abort the scan. One
 * broken check should cost its own coverage and nothing else — aborting would turn a small
 * defect into a scan that "ran" and found nothing, which reads like a clean result.
 */
async function runOne(
  check: string, target: SecurityTarget, runner: CheckRunner,
  scanner: Scanner, context: ScanContext
): Promise<CheckOutcome> {
  try {
    const result = await runner(scanner, target, context);

    if (result.skipped) {
      // The guard's own sentence first, then its code, and "unknown" only when it truly said
      // nothing. A refusal whose reason reads "unknown" is a refusal nobody can act on, and
      // one of those cost an investigation: a check had passed a bare sentence where the
      // guard's decision object was expected, so `.reason` was undefined and the sentence it
      // had written went nowhere. Reading both fields, and tolerating a decision that is
      // itself a string, means a reason written anywhere survives to the log.
      const decision: unknown = result.decision;
      const said = typeof decision === 'string'
        ? decision
        : (decision as { explanation?: string; reason?: string } | undefined)?.explanation
          ?? (decision as { reason?: string } | undefined)?.reason;
      return {
        check, target: target.identifier, executed: false, findings: [],
        note: `Refused by the scope guard: ${said ?? 'no reason was given, which is itself worth fixing'}.`
      };
    }
    if (result.notTestable) {
      return {
        check, target: target.identifier, executed: false, findings: [],
        note: result.reason ?? 'This check cannot decide the question from a response body.'
      };
    }
    if (result.inconclusive) {
      // Not a pass. The check ran and could not establish its control, so it has nothing to
      // say — which is different from having looked and found nothing.
      return {
        check, target: target.identifier, executed: false, findings: [],
        note: `Inconclusive: ${result.reason ?? 'the control could not be established.'}`
      };
    }

    return {
      check, target: target.identifier, executed: true,
      // Stamped here, because here is the only place that knows it.
      //
      // The engine's checks carry their own internal test ids ('SECP-HEADERS'), not the
      // canonical names the platform's check list, the attack surface and the gate all agree
      // on ('passive.headers'). No engine finding sets one at all, and the control plane uses
      // this field to decide whether a check that previously found something ran again and did
      // not reproduce it. Left empty, that comparison never matches and an old finding is never
      // moved to NeedsReview — the mechanism looks present and does nothing.
      findings: (result.findings ?? []).map(finding => ({ ...finding, testId: check })),
      note: result.detail ?? `${(result.findings ?? []).length} finding(s).`
    };
  } catch (error) {
    context.logger.error(`The ${check} check threw against ${target.identifier}`, error);
    return {
      check, target: target.identifier, executed: false, findings: [],
      note: `The check threw: ${error instanceof Error ? error.message : String(error)}. It is `
        + 'recorded as not executed, so this area is untested rather than clean.'
    };
  }
}

/**
 * Areas this scan could not decide, named for the report.
 *
 * Distinguishing tested coverage from untested areas is a requirement rather than a courtesy,
 * and the honest source for it is what actually happened rather than a fixed list.
 */
function untestedAreas(job: SecurityScanJob, outcomes: CheckOutcome[]): string[] {
  const areas = new Set<string>();

  for (const outcome of outcomes) {
    if (!outcome.executed) areas.add(`${outcome.check} on ${outcome.target}: ${outcome.note}`);
  }

  const attempted = new Set(outcomes.map(o => o.check));
  for (const check of job.checksConfigured) {
    if (!attempted.has(check)) {
      areas.add(`${check}: nothing in the discovered surface implied it, so it was not attempted.`);
    }
  }

  return [...areas];
}

function toReport(finding: SecurityFinding): Record<string, unknown> {
  return {
    category: finding.category,
    title: finding.title,
    // Always set by runOne above. Empty would silently disable the control plane's
    // "this check ran again and did not reproduce it" comparison, so it is refused rather
    // than defaulted — a finding that cannot be traced to a check is not reportable.
    testId: requireTestId(finding),
    endpoint: finding.endpoint ?? null,
    httpMethod: finding.httpMethod ?? null,
    parameter: finding.parameter ?? null,
    observedAsRole: finding.observedAsRole ?? null,
    severity: severityNumber(finding.severityFactors.severity),
    confidence: confidenceNumber(finding.confidence),
    severityFactorsJson: JSON.stringify(finding.severityFactors.toJSON()),
    cwe: finding.cwe ?? null,
    cweConfidence: finding.cweConfidence ?? null,
    owaspApiCategory: finding.owaspApiCategory ?? null,
    owaspWebCategory: finding.owaspWebCategory ?? null,
    owaspEdition: '2021',
    description: finding.description,
    impact: finding.impact,
    remediation: finding.remediation,
    reproductionSteps: reproduction(finding),
    evidencePath: null,
    // The gate and the control plane both refuse a finding with nothing behind it, and this
    // is where that number comes from. Never inflated: it is the count of real exchanges.
    exchangeCount: finding.exchanges?.length ?? 0
  };
}

function reproduction(finding: SecurityFinding): string {
  // A check that can say it better than a replay list says it. Only a few can, and they are
  // the ones where replaying the requests would not reproduce anything: a DOM sink fires in
  // the browser, and its exchange list is a GET that returned 200.
  if (finding.reproductionSteps) return finding.reproductionSteps;

  const lines = (finding.exchanges ?? []).map((exchange, index) =>
    `${index + 1}. ${exchange.method ?? 'GET'} ${exchange.url ?? '(no url)'}`
    + `${exchange.as ? ` as ${exchange.as}` : ''} → HTTP ${exchange.status ?? 0}`
    + `${exchange.note ? ` — ${exchange.note}` : ''}`);

  return lines.length > 0
    ? lines.join('\n')
    : 'No exchange was recorded, which is why this finding will be refused.';
}

/**
 * The engine's severity and confidence orderings are also the control plane's enum ordinals,
 * and they are read from the engine rather than copied here — a second copy would not fail
 * when one of the two changed, it would report a Critical as whatever its fallback was.
 * `SECPL-017` asserts the two vocabularies still line up.
 *
 * An unknown band throws rather than defaulting. Defaulting means picking a severity for a
 * finding whose severity is not understood, and every direction is wrong: downwards hides it,
 * upwards invents it.
 */
/** The check a finding came from, refused rather than defaulted when it is missing. */
function requireTestId(finding: SecurityFinding): string {
  const testId = (finding as SecurityFinding & { testId?: string }).testId;
  if (!testId) {
    throw new Error(
      `A ${finding.category} finding arrived with no check name. The control plane uses it to `
      + 'tell a check that ran and found nothing from one that did not run, and an empty value '
      + 'disables that comparison silently.');
  }
  return testId;
}

function severityNumber(band: string): number {
  const value = (SEVERITY_ORDER as Record<string, number>)[band];
  if (value === undefined) {
    throw new Error(
      `The severity band '${band}' is not one the engine defines (`
      + `${Object.keys(SEVERITY_ORDER).join(', ')}), so this finding cannot be reported at a `
      + 'severity anyone could stand behind.');
  }
  return value;
}

function confidenceNumber(level: string): number {
  const value = (CONFIDENCE_ORDER as Record<string, number>)[level];
  if (value === undefined) {
    throw new Error(
      `The confidence level '${level}' is not one the engine defines (`
      + `${Object.keys(CONFIDENCE_ORDER).join(', ')}).`);
  }
  return value;
}

/**
 * Signing in as the synthetic identities the job carries.
 *
 * A failure to sign in is logged and does not stop the scan: the checks needing that identity
 * will report inconclusive, which is the truthful outcome, rather than the scan aborting and
 * reporting nothing at all.
 */
export async function signInIdentities(
  scanner: Scanner, job: SecurityScanJob, logger: Logger
): Promise<Map<string, SignedInIdentity>> {
  const identities = new Map<string, SignedInIdentity>();

  for (const identity of job.identities) {
    try {
      const session = await scanner.signIn(job.baseUrl, identity.username, identity.password);
      // Whatever authenticates a request counts, not only a cookie.
      if (!session || !isSignedIn(session)) {
        logger.warn(`Could not sign in as ${identity.label}; checks needing it will be inconclusive`);
        continue;
      }
      identities.set(identity.label, {
        ...identity,
        headers: authHeaders(session),
        cookie: session.cookie ?? null,
        csrf: session.csrf ?? null
      });
    } catch (error) {
      logger.warn(`Signing in as ${identity.label} threw`, {
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return identities;
}

// ---------------------------------------------------------------------------
// Which engine function each check name runs
// ---------------------------------------------------------------------------

/**
 * Which identity plays which part in a comparison.
 *
 * Every one of these resolves by the role the caller declared, falling back to position. The
 * fallback is what the first two used to do *instead*: `owner` was whatever identity came
 * first and `intruder` whatever came second, whatever their roles. A launcher sending
 * privileged, owner, readonly in that order — the order its own documentation uses — got the
 * administrator as the "owner".
 *
 * The cost landed on authz.vertical, which takes the privileged identity and a lesser one.
 * Both resolved to the administrator, so the check compared an identity against itself and
 * reported "both reach this route" on five targets. It cannot find a privilege escalation
 * that way: the lesser identity holds every privilege. An honest-looking inconclusive is the
 * worst possible disguise for a check that could never have failed.
 */
export const byRole = (context: ScanContext, ...roles: string[]) =>
  [...context.identities.values()].find(i => i.role !== undefined && roles.includes(i.role));

export const owner = (context: ScanContext) =>
  byRole(context, 'owner', 'user', 'member', 'standard')
  ?? [...context.identities.values()][0];

/**
 * A second identity to compare against the first, and necessarily a different one.
 *
 * Position alone could return the same identity the owner resolved to, which is how a
 * comparison silently stops comparing.
 */
export const intruder = (context: ScanContext) => {
  const all = [...context.identities.values()];
  const first = owner(context);
  return byRole(context, 'intruder', 'attacker', 'other')
    ?? all.find(i => i !== first);
};
// Role names are whatever the caller sent, so both spellings of each are honoured. The
// launcher's own documentation says "privileged"; this looked only for "admin", so a scan
// configured exactly as documented had no privileged identity and the checks needing one
// reported inconclusive while the identity sat in the map.
export const privileged = (context: ScanContext) =>
  [...context.identities.values()].find(i =>
    i.role === 'privileged' || i.role === 'admin' || i.role === 'administrator');
export const readOnly = (context: ScanContext) =>
  [...context.identities.values()].find(i =>
    i.role === 'readonly' || i.role === 'read-only' || i.role === 'viewer');

const inconclusive = (reason: string): CheckResult => ({ findings: [], inconclusive: true, reason });

/**
 * Checks that cannot run without a browser.
 *
 * One entry, and deliberately a set rather than a flag on each runner: it is read before the
 * scan starts, to decide whether to pay for a browser at all.
 */
const BROWSER_CHECKS = new Set(['xss.dom']);

const RUNNERS: Record<string, CheckRunner> = {
  'authz.bola': async (scanner, target, context) => {
    const a = owner(context); const b = intruder(context);
    if (!a || !b) return inconclusive('Two signed-in identities are needed to compare access; fewer were available.');

    // A declared resource wins: a caller who knows which record belongs to whom is a better
    // authority than a crawl. Failing that, the identifier from an address discovery reached
    // while signed in — which is, by construction, a record that identity was shown.
    //
    // Nothing had ever supplied one. Every driver here declares identities as label,
    // username, password and role, because that is what signing in needs, so the check that
    // finds an IDOR reported "give the identity a resourceId it owns" on every target of
    // every run while a planted IDOR sat untested.
    const declared = a.resourceId;
    const resourceId = declared
      ?? identifierFromSample(target.identifier, target.sampleUrl)
      ?? '';

    return authz.checkBola(scanner, {
      baseUrl: context.baseUrl, path: target.identifier,
      owner: { ...asActor(a), resourceId },
      intruder: asActor(b),
      // A derived resource can show the endpoint refusing the second identity, which is a
      // pass worth having. It cannot show a leak, because nothing says the record was
      // private to the first identity.
      resourceOwnership: declared ? 'declared' : 'assumed'
    });
  },
  'authz.vertical': async (scanner, target, context) => {
    const admin = privileged(context);
    // Explicitly not the privileged identity. Resolving the lesser one by position returned
    // the administrator, and the check then compared him with himself.
    const lesser = [...context.identities.values()].find(i => i !== admin && i.role !== 'privileged'
      && i.role !== 'admin' && i.role !== 'administrator');
    if (!admin || !lesser) return inconclusive('A privileged and a lesser identity are needed; both were not available.');
    return authz.checkVerticalEscalation(scanner, {
      baseUrl: context.baseUrl, path: target.identifier,
      privileged: asActor(admin),
      lesser: asActor(lesser)
    });
  },
  'authz.readonly': async (scanner, target, context) => {
    const writer = owner(context); const reader = readOnly(context);
    if (!writer || !reader) return inconclusive('A writing and a read-only identity are needed; both were not available.');
    return authz.checkReadOnlyWrite(scanner, {
      baseUrl: context.baseUrl, path: target.identifier,
      writer: asActor(writer),
      readonly: asActor(reader),
      body: {}
    });
  },
  'authz.missing': async (scanner, target, context) => {
    const a = owner(context);
    if (!a) return inconclusive('An owning identity is needed to establish the control.');
    return authz.checkMissingAuthorization(scanner, {
      baseUrl: context.baseUrl, path: target.identifier,
      owner: { ...asActor(a), resourceId: a.resourceId ?? '' }
    });
  },
  'authz.token': async (scanner, target, context) => authz.checkTokenVerification(scanner, {
    baseUrl: context.baseUrl, path: target.identifier,
    forgedToken: 'qanxt-forged-value-this-application-never-issued'
  }),

  'auth.enumeration': async (scanner, target, context) => {
    const a = owner(context);
    if (!a) return inconclusive('A known username is needed to draw the comparison.');
    return auth.checkUserEnumeration(scanner, {
      baseUrl: context.baseUrl, path: target.identifier, knownUser: a.username
    });
  },
  'auth.lockout': async (scanner, target, context) => {
    const a = owner(context);
    if (!a) return inconclusive('A known username is needed for a bounded lockout probe.');
    return auth.checkAccountLockout(scanner, {
      baseUrl: context.baseUrl, path: target.identifier,
      // The password as well as the name: one correct sign-in is what establishes that the
      // endpoint evaluates credentials, and without it an application that answers a wrong
      // password and an empty submission alike reads as one that is not listening.
      knownUser: a.username, knownPassword: a.password
    });
  },
  'auth.session-logout': async (scanner, _target, context) => {
    const a = owner(context);
    if (!a) return inconclusive('Credentials are needed to observe what sign-out does.');
    return auth.checkSessionInvalidation(scanner, {
      baseUrl: context.baseUrl, credentials: { username: a.username, password: a.password }
    });
  },
  'auth.session-lifetime': async (scanner, _target, context) => {
    const a = owner(context);
    if (!a) return inconclusive('Credentials are needed to read the declared session lifetime.');
    return auth.checkSessionLifetime(scanner, {
      baseUrl: context.baseUrl, credentials: { username: a.username, password: a.password }
    });
  },
  'auth.reset-reuse': async (scanner, target, context) => {
    const a = owner(context);
    if (!a) return inconclusive('A known account is needed to request a reset.');
    return auth.checkResetTokenReuse(scanner, {
      baseUrl: context.baseUrl, confirmPath: target.identifier, knownUser: a.username
    });
  },

  'api.mass-assignment': async (scanner, target, context) => {
    const a = owner(context);
    if (!a) return inconclusive('A signed-in identity owning an object is needed.');
    return api.checkMassAssignment(scanner, {
      baseUrl: context.baseUrl, path: target.identifier,
      actor: { ...asActor(a), resourceId: a.resourceId ?? '' }
    });
  },
  'api.input-validation': async (scanner, target, context) => {
    const a = owner(context);
    const field = target.parameters[0];
    if (!field) return inconclusive('No parameter was discovered on this endpoint to probe.');
    return api.checkInputValidation(scanner, {
      baseUrl: context.baseUrl, path: target.identifier, field,
      actor: a ? asActor(a) : undefined
    });
  },
  'api.unsafe-method': async (scanner, target, context) => {
    const a = owner(context);
    return api.checkUnsafeMethods(scanner, {
      baseUrl: context.baseUrl,
      // The object deleted is one the check creates first, never one it found.
      createPath: target.identifier.replace(/\/\{[^}]+\}$/, ''),
      deletePath: target.identifier,
      actor: a ? asActor(a) : undefined
    });
  },
  'api.rate-limit': async (scanner, target, context) => {
    const a = owner(context);
    return api.checkRateLimit(scanner, {
      baseUrl: context.baseUrl, path: target.identifier,
      actor: a ? asActor(a) : undefined
    });
  },
  'api.error-disclosure': async (scanner, target, context) => {
    // With a session where one is available and without one where it is not: an endpoint
    // behind a login answers an anonymous probe with a redirect, and a redirect discloses
    // nothing. The check itself refuses a target with no identifier in it.
    const a = owner(context);
    return api.checkErrorDisclosure(scanner, {
      baseUrl: context.baseUrl, path: target.identifier,
      actor: a ? asActor(a) : undefined
    });
  },
  'api.excessive-data': async (scanner, target, context) => {
    const a = owner(context);
    return api.checkExcessiveData(scanner, {
      baseUrl: context.baseUrl, path: target.identifier,
      actor: a ? asActor(a) : undefined
    });
  },

  'xss.reflected': async (scanner, target, context) => {
    const parameter = target.parameters[0];
    if (!parameter) return inconclusive('No parameter was discovered on this page to reflect.');
    // With an identity where one is available: a search page behind a login answered the
    // anonymous probe with a redirect, and a redirect reflects nothing.
    return xss.checkReflectedXss(scanner, {
      baseUrl: context.baseUrl, path: target.identifier, parameter, identity: owner(context)
    });
  },
  'xss.stored': async (scanner, target, context) => {
    const field = target.parameters[0];
    const a = owner(context);
    if (!field) return inconclusive('No field was discovered on this page to store a marker in.');
    return xss.checkStoredXss(scanner, {
      baseUrl: context.baseUrl, writePath: target.identifier, readPath: target.identifier,
      field, actor: a ? asActor(a) : undefined
    });
  },
  /**
   * The one check that cannot be decided from a response.
   *
   * `location.hash` never reaches the server and the sink runs after load, so the vulnerable
   * and the corrected page can answer byte-identically. This drives a real browser and reports
   * only what executed — see `dom-xss.ts`.
   *
   * Without a browser it reports inconclusive. That is the whole point: a runner that answered
   * "nothing found" here would be reporting a clean result it has no basis for.
   */
  'xss.dom': async (scanner, target, context) => {
    if (!context.browser) {
      return inconclusive(
        'A browser is needed to decide DOM-based XSS and none was available. The sink runs in '
        + 'the page, so nothing about it can be read from a response.');
    }
    return checkDomXssInBrowser({
      scanner, context: context.browser,
      baseUrl: context.baseUrl, path: target.identifier, logger: context.logger
    });
  },

  'injection.sql': async (scanner, target, context) => {
    const parameter = target.parameters[0];
    if (!parameter) return inconclusive('No parameter was discovered on this endpoint to probe.');
    return injection.checkSqlInjection(scanner, {
      baseUrl: context.baseUrl, path: target.identifier, parameter
    });
  },
  'injection.nosql': async (scanner, target, context) => injection.checkNoSqlInjection(scanner, {
    baseUrl: context.baseUrl, path: target.identifier
  }),
  'injection.command': async (scanner, target, context) => {
    const parameter = target.parameters[0];
    if (!parameter) return inconclusive('No parameter was discovered on this endpoint to probe.');
    return injection.checkCommandInjection(scanner, {
      baseUrl: context.baseUrl, path: target.identifier, parameter
    });
  },
  'injection.template': async (scanner, target, context) => {
    const parameter = target.parameters[0];
    if (!parameter) return inconclusive('No parameter was discovered on this endpoint to probe.');
    return injection.checkTemplateInjection(scanner, {
      baseUrl: context.baseUrl, path: target.identifier, parameter
    });
  },

  'request.csrf': async (scanner, target, context) => {
    const a = owner(context);
    if (!a?.cookie) return inconclusive('An authenticated session is needed to send a cross-site request.');
    return request.checkCsrfToken(scanner, {
      baseUrl: context.baseUrl, path: target.identifier,
      session: { cookie: a.cookie, csrf: a.csrf }, body: {}
    });
  },
  'request.origin': async (scanner, target, context) => {
    const a = owner(context);
    if (!a?.cookie) return inconclusive('An authenticated session is needed to vary the origin.');
    return request.checkOriginValidation(scanner, {
      baseUrl: context.baseUrl, path: target.identifier,
      session: { cookie: a.cookie, csrf: a.csrf }, body: {}
    });
  },
  'request.upload': async (scanner, target, context) => {
    const a = owner(context);
    return request.checkUploadRestrictions(scanner, {
      baseUrl: context.baseUrl, path: target.identifier,
      actor: a ? asActor(a) : undefined
    });
  },
  'request.safe-verb-state-change': async (scanner, target, context) => {
    // The lowest-privilege signed-in identity available, because "a GET changes state" is a
    // worse finding when the caller holds no privilege at all. With only one identity the
    // check runs as that one and says so in the finding's observedAsRole.
    const a = readOnly(context) ?? intruder(context) ?? owner(context);
    if (!a) {
      return inconclusive('A signed-in identity is needed: an anonymous GET that is refused says '
        + 'nothing about whether a safe verb changes state for someone who is signed in.');
    }
    if (!target.witnessUrl) {
      return inconclusive('Not evaluated: this check establishes a state change by reading a page '
        + 'before and after the request, and discovery recorded no page this address was seen '
        + 'from. Without one the only thing to read is the request\'s own response, which says '
        + 'what the application chose to say rather than what it did.');
    }
    return request.checkStateChangeBySafeVerb(scanner, {
      baseUrl: context.baseUrl,
      path: target.identifier,
      witnessPath: target.witnessUrl,
      actor: asActor(a)
    });
  },
  'request.redirect': async (scanner, target, context) => {
    const parameter = target.parameters.find(p => REDIRECTISH.has(p.toLowerCase()))
      ?? target.parameters[0];
    if (!parameter) return inconclusive('No destination parameter was discovered on this endpoint.');
    return request.checkOpenRedirect(scanner, {
      baseUrl: context.baseUrl, path: target.identifier, parameter
    });
  },
  'request.ssrf': async (scanner, target, context) => {
    const parameter = target.parameters.find(p => REDIRECTISH.has(p.toLowerCase()))
      ?? target.parameters[0];
    if (!parameter) return inconclusive('No destination parameter was discovered on this endpoint.');
    return request.checkSsrf(scanner, {
      baseUrl: context.baseUrl, path: target.identifier, parameter
      // allowMetadataPayloads stays false. Cloud metadata is never probed by default, and a
      // worker is the last place to make that an implicit decision.
    });
  },

  'passive.headers': async (scanner, target, context) =>
    passive.checkSecurityHeaders(scanner, url(context.baseUrl, target.identifier), 'passive.headers'),
  // Given an identity, this check signs in and judges the cookies the authentication
  // response sets, once per way the form will authenticate. Without one it can only read the
  // page under test, which is close to the only request that issues no session cookie — so a
  // scan configured with no credentials reports the check inconclusive rather than clean.
  'passive.cookies': async (scanner, target, context) => {
    const identity = owner(context);
    return passive.checkCookies(
      scanner, url(context.baseUrl, target.identifier), 'passive.cookies',
      {
        baseUrl: context.baseUrl,
        credentials: identity?.username
          ? { username: identity.username, password: identity.password }
          : undefined
      });
  },
  'passive.cors': async (scanner, target, context) =>
    passive.checkCors(scanner, url(context.baseUrl, target.identifier), 'passive.cors'),
  // Read as a signed-in identity where the job carries one. Anonymously, this check
  // examined whatever an application shows a stranger — on anything behind a sign-in, the
  // sign-in page — and reported it clean. The data worth finding is the data a user sees.
  'passive.sensitive-data': async (scanner, target, context) => {
    const identity = owner(context);
    return passive.checkSensitiveData(
      scanner, url(context.baseUrl, target.identifier), 'passive.sensitive-data',
      { headers: authHeaders(identity) });
  },
  'passive.misconfiguration': async (scanner, _target, context) =>
    passive.checkMisconfiguration(scanner, context.baseUrl, 'passive.misconfiguration'),
  // Read as a signed-in identity, for the same reason sensitive-data is: the forms that
  // collect personal data are behind the sign-in, and a stranger is shown the login page.
  'passive.pii-in-url': async (scanner, target, context) => {
    const identity = owner(context);
    return passive.checkPersonalDataInUrl(
      scanner, url(context.baseUrl, target.identifier), 'passive.pii-in-url',
      { headers: authHeaders(identity) });
  }
};

const REDIRECTISH = new Set([
  'url', 'uri', 'next', 'redirect', 'redirecturl', 'returnurl', 'return_to', 'continue',
  'callback', 'dest', 'destination', 'target', 'link', 'fetch', 'image', 'src', 'path'
]);

/**
 * Where a check's probe goes, by the same rule every check in the engine uses.
 *
 * This concatenated the target's absolute path onto the base URL, which is right only
 * while the base URL has no path of its own. Registered against
 * `http://host/schedule` — an application whose landing screen is not `/` — it produced
 * `http://host/schedule/patients`, and the twelve missing-header findings a scan of that
 * target raised all named URLs that do not exist. The engine's own forty-three sites had
 * the same fault and were fixed; this one is the worker's copy of it.
 */
const url = (baseUrl: string, path: string): string =>
  path.startsWith('http') ? path : at(baseUrl, path.startsWith('/') ? path : `/${path}`);

/** The checks this worker can run, so the control plane never selects one it cannot. */
export const RUNNABLE_CHECKS: string[] = Object.keys(RUNNERS);
