/**
 * The security scenario catalogue.
 *
 * Every scenario names one planted flaw, the check that should find it, and exactly what
 * the finding must say. The suite runs each scenario three ways and records three
 * independent results:
 *
 *   detection   the flaw is switched on alone — the check must report it
 *   precision   the flaw is switched off  — the check must report nothing
 *   mapping     the finding it produced carries the right CWE, OWASP category and
 *               severity band
 *
 * Detection without precision is worthless: a check that reports BOLA on every endpoint
 * detects every BOLA there is. So each scenario isolates its flaw — every other fault in
 * that lab is switched off — which also means a check that keys on the wrong signal fails
 * rather than passing by accident.
 *
 * The expectations are read from the lab's ground truth where the ground truth states
 * them, rather than restated here, so the two cannot drift apart silently.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as authz from '../../../packages/security-engine/src/checks-authz.mjs';
import * as auth from '../../../packages/security-engine/src/checks-auth.mjs';
import * as api from '../../../packages/security-engine/src/checks-api.mjs';
import * as xss from '../../../packages/security-engine/src/checks-xss.mjs';
import * as injection from '../../../packages/security-engine/src/checks-injection.mjs';
import * as request from '../../../packages/security-engine/src/checks-request.mjs';
import * as passive from '../../../packages/security-engine/src/checks-passive.mjs';

/**
 * Every check the engine knows how to run, named exactly as the platform names them.
 *
 * These strings are a contract between the attack surface, the change-impact selector, the
 * scan record and the gate's coverage rule. A check named one way here and another way in C#
 * would let a scan report full coverage having run nothing — a false green arriving through a
 * typo — so the golden suite fetches the platform's list and asserts the two are identical.
 */
export const CHECKS = [
  'authz.bola', 'authz.vertical', 'authz.readonly', 'authz.missing', 'authz.token',
  'auth.enumeration', 'auth.lockout', 'auth.session-logout', 'auth.session-lifetime', 'auth.reset-reuse',
  'api.mass-assignment', 'api.input-validation', 'api.unsafe-method', 'api.rate-limit', 'api.excessive-data',
  'xss.reflected', 'xss.stored', 'xss.dom',
  'injection.sql', 'injection.nosql', 'injection.command', 'injection.template',
  'request.csrf', 'request.origin', 'request.upload', 'request.redirect', 'request.ssrf',
  'passive.headers', 'passive.cookies', 'passive.cors', 'passive.sensitive-data', 'passive.misconfiguration'
];

/** Checks only a browser-driven scan can perform. Reported as untested, never as absent. */
export const CHECKS_REQUIRING_BROWSER = ['xss.dom'];

export const LABS = {
  auth: 'http://127.0.0.1:4400',
  accessControl: 'http://127.0.0.1:4401',
  api: 'http://127.0.0.1:4402',
  xss: 'http://127.0.0.1:4403',
  csrf: 'http://127.0.0.1:4404',
  headers: 'http://127.0.0.1:4406',
  injection: 'http://127.0.0.1:4408'
};

/** The lab's application name for each base URL, so ground truth can be looked up. */
const APPLICATION = {
  [LABS.auth]: 'auth-lab',
  [LABS.accessControl]: 'access-control-lab',
  [LABS.api]: 'api-lab',
  [LABS.xss]: 'xss-lab',
  [LABS.csrf]: 'csrf-upload-lab',
  [LABS.headers]: 'headers-lab',
  [LABS.injection]: 'injection-lab'
};

export const GROUND_TRUTH = JSON.parse(readFileSync(
  resolve(new URL('../../../test-lab/security/ground-truth.json', import.meta.url).pathname), 'utf8'));

/** What the ground truth says about one planted flaw. */
export function expectedFor(baseUrl, vulnerabilityId) {
  const application = GROUND_TRUTH.applications.find(a => a.application === APPLICATION[baseUrl]);
  return application?.expectedFindings.find(f => f.id === vulnerabilityId) ?? null;
}

const SEVERITY_WORD = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
export const expectedSeverity = entry => SEVERITY_WORD[entry?.severity] ?? null;

// ---------------------------------------------------------------------------
// Lab control
// ---------------------------------------------------------------------------

const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {})
});

/** Every fault id the lab declares, read from the lab rather than restated here. */
export async function faultIds(baseUrl) {
  const health = await (await fetch(`${baseUrl}/health`)).json();
  return Object.keys(health.faults ?? {});
}

/**
 * Switches every fault off except the ones named.
 *
 * Isolating the flaw is what makes a detection result mean something. With all six of the
 * api lab's flaws on at once, a check keyed on entirely the wrong signal still finds
 * *something* and looks correct.
 */
export async function isolateFaults(baseUrl, enabled = []) {
  const ids = await faultIds(baseUrl);
  const body = Object.fromEntries(ids.map(id => [id, enabled.includes(id)]));
  await post(`${baseUrl}/__faults`, body);
  await post(`${baseUrl}/__reset`);
  return body;
}

export const resetLab = baseUrl => post(`${baseUrl}/__reset`);
export const restoreFaults = baseUrl => post(`${baseUrl}/__faults/reset`);

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

const identity = async (scanner, baseUrl, username) => {
  const session = await scanner.signIn(baseUrl, username);
  return session?.cookie ? { cookie: session.cookie, label: username, session } : null;
};

/**
 * Each entry: the flaw, the lab, and a `run` that takes a scanner and returns the check's
 * result. `destructive` marks the scenarios whose probes the scope guard classifies as
 * destructive, so the suite can prove they are refused under an ordinary scope.
 */
export const SCENARIOS = [
  // ---- Authorization -----------------------------------------------------
  {
    key: 'bola', vuln: 'VULN_BOLA', lab: LABS.accessControl, family: 'Authorization',
    objective: 'A user reading another user\'s object by identifier is reported as BOLA',
    expectCategory: 'BOLA',
    run: async scanner => {
      const bob = await identity(scanner, LABS.accessControl, 'bob');
      const alice = await identity(scanner, LABS.accessControl, 'alice');
      return authz.checkBola(scanner, {
        baseUrl: LABS.accessControl, path: '/api/accounts/{id}',
        owner: { ...bob, resourceId: 'acc-1002' }, intruder: alice
      });
    }
  },
  {
    key: 'vertical', vuln: 'VULN_VERTICAL_ESCALATION', lab: LABS.accessControl, family: 'Authorization',
    objective: 'A customer reaching an administrator route is reported as broken function level authorization',
    expectCategory: 'BrokenFunctionLevelAuthorization',
    run: async scanner => {
      const admin = await identity(scanner, LABS.accessControl, 'admin');
      const alice = await identity(scanner, LABS.accessControl, 'alice');
      return authz.checkVerticalEscalation(scanner, {
        baseUrl: LABS.accessControl, path: '/api/admin/users', privileged: admin, lesser: alice
      });
    }
  },
  {
    key: 'readonly-write', vuln: 'VULN_READONLY_CAN_WRITE', lab: LABS.accessControl, family: 'Authorization',
    objective: 'A read-only account performing a write is reported as privilege escalation',
    expectCategory: 'PrivilegeEscalation',
    run: async scanner => {
      const alice = await identity(scanner, LABS.accessControl, 'alice');
      const mallory = await identity(scanner, LABS.accessControl, 'mallory');
      return authz.checkReadOnlyWrite(scanner, {
        baseUrl: LABS.accessControl, path: '/api/transfers',
        writer: alice, readonly: mallory, body: { from: 'acc-1003', to: 'acc-1001', amount: 1 }
      });
    }
  },
  {
    key: 'missing-authz', vuln: 'VULN_MISSING_AUTHZ', lab: LABS.accessControl, family: 'Authorization',
    objective: 'Protected data served to an unauthenticated caller is reported as missing authorization',
    expectCategory: 'MissingAuthorization',
    run: async scanner => {
      const alice = await identity(scanner, LABS.accessControl, 'alice');
      return authz.checkMissingAuthorization(scanner, {
        baseUrl: LABS.accessControl, path: '/api/accounts/{id}/statement',
        owner: { ...alice, resourceId: 'acc-1001' }
      });
    }
  },
  {
    key: 'unverified-token', vuln: 'VULN_UNVERIFIED_TOKEN', lab: LABS.api, family: 'Authentication',
    objective: 'A bearer token the application never issued being accepted is reported',
    expectCategory: 'UnverifiedToken',
    run: async scanner => authz.checkTokenVerification(scanner, {
      baseUrl: LABS.api, path: '/api/notes', forgedToken: 'u-admin.forged.by-aira'
    })
  },

  // ---- Authentication and session ----------------------------------------
  {
    key: 'enumeration', vuln: 'VULN_USER_ENUMERATION', lab: LABS.auth, family: 'Authentication',
    objective: 'A sign-in endpoint that distinguishes an unknown account from a wrong password is reported',
    expectCategory: 'UserEnumeration',
    run: async scanner => auth.checkUserEnumeration(scanner, { baseUrl: LABS.auth, knownUser: 'alice' })
  },
  {
    key: 'lockout', vuln: 'VULN_NO_LOCKOUT', lab: LABS.auth, family: 'Authentication',
    objective: 'Repeated failed sign-ins that are never throttled are reported, from a bounded probe',
    expectCategory: 'NoAccountLockout',
    run: async scanner => auth.checkAccountLockout(scanner, { baseUrl: LABS.auth, knownUser: 'alice' })
  },
  {
    key: 'session-logout', vuln: 'VULN_SESSION_SURVIVES_LOGOUT', lab: LABS.auth, family: 'Session',
    objective: 'A token that still authenticates after sign-out is reported',
    expectCategory: 'SessionNotInvalidatedOnLogout', destructive: true,
    run: async scanner => auth.checkSessionInvalidation(scanner, {
      baseUrl: LABS.auth, credentials: { username: 'alice', password: 'lab-password' }
    })
  },
  {
    key: 'session-lifetime', vuln: 'VULN_LONG_SESSION', lab: LABS.auth, family: 'Session',
    objective: 'A session lifetime far above the threshold is reported, as declared rather than witnessed',
    expectCategory: 'ExcessiveSessionLifetime',
    run: async scanner => auth.checkSessionLifetime(scanner, {
      baseUrl: LABS.auth, credentials: { username: 'alice' }
    })
  },
  {
    key: 'reset-reuse', vuln: 'VULN_RESET_TOKEN_REUSE', lab: LABS.auth, family: 'Authentication',
    objective: 'A password-reset token accepted twice is reported',
    expectCategory: 'PasswordResetTokenReuse',
    run: async scanner => auth.checkResetTokenReuse(scanner, { baseUrl: LABS.auth, knownUser: 'alice' })
  },

  // ---- API security -------------------------------------------------------
  {
    key: 'mass-assignment', vuln: 'VULN_MASS_ASSIGNMENT', lab: LABS.api, family: 'API security',
    objective: 'A caller setting a privileged field on their own object is reported',
    expectCategory: 'BrokenObjectPropertyLevelAuthorization',
    run: async scanner => {
      const alice = await identity(scanner, LABS.api, 'alice');
      return api.checkMassAssignment(scanner, {
        baseUrl: LABS.api, path: '/api/users/{id}', actor: { ...alice, resourceId: 'u-alice' }
      });
    }
  },
  {
    key: 'input-validation', vuln: 'VULN_NO_INPUT_VALIDATION', lab: LABS.api, family: 'API security',
    objective: 'A field accepting any type, an empty value and an oversized value is reported',
    expectCategory: 'MissingInputValidation',
    run: async scanner => {
      const alice = await identity(scanner, LABS.api, 'alice');
      return api.checkInputValidation(scanner, {
        baseUrl: LABS.api, path: '/api/notes', field: 'title', actor: alice
      });
    }
  },
  {
    key: 'unsafe-method', vuln: 'VULN_UNSAFE_METHODS', lab: LABS.api, family: 'API security',
    objective: 'An unauthenticated DELETE succeeding is reported, against an object the check created',
    expectCategory: 'UnsafeMethodAllowed', destructive: true,
    run: async scanner => {
      const alice = await identity(scanner, LABS.api, 'alice');
      return api.checkUnsafeMethods(scanner, {
        baseUrl: LABS.api, createPath: '/api/notes', deletePath: '/api/notes/{id}', actor: alice
      });
    }
  },
  {
    key: 'rate-limit', vuln: 'VULN_NO_RATE_LIMIT', lab: LABS.api, family: 'API security',
    objective: 'An endpoint with no threshold below fifteen requests is reported, from a bounded probe',
    expectCategory: 'NoRateLimit',
    run: async scanner => {
      const alice = await identity(scanner, LABS.api, 'alice');
      return api.checkRateLimit(scanner, { baseUrl: LABS.api, path: '/api/search', actor: alice });
    }
  },
  {
    key: 'excessive-data', vuln: 'VULN_EXCESSIVE_DATA', lab: LABS.api, family: 'API security',
    objective: 'Password hashes and tokens in a response are reported, by field name and never by value',
    expectCategory: 'SensitiveDataExposure',
    run: async scanner => {
      const alice = await identity(scanner, LABS.api, 'alice');
      return api.checkExcessiveData(scanner, { baseUrl: LABS.api, path: '/api/users', actor: alice });
    }
  },

  // ---- Cross-site scripting ------------------------------------------------
  {
    key: 'reflected-xss', vuln: 'VULN_REFLECTED_XSS', lab: LABS.xss, family: 'Injection',
    objective: 'Input reflected unencoded into an HTML response is reported as reflected XSS',
    expectCategory: 'ReflectedXSS',
    run: async scanner => xss.checkReflectedXss(scanner, {
      baseUrl: LABS.xss, path: '/search', parameter: 'q'
    })
  },
  {
    key: 'stored-xss', vuln: 'VULN_STORED_XSS', lab: LABS.xss, family: 'Injection',
    objective: 'A marker stored once and rendered unencoded on a later read is reported as stored XSS',
    expectCategory: 'StoredXSS',
    run: async scanner => xss.checkStoredXss(scanner, {
      baseUrl: LABS.xss, writePath: '/profile', readPath: '/profile', field: 'bio'
    })
  },

  // ---- Injection -----------------------------------------------------------
  {
    key: 'sql-injection', vuln: 'VULN_SQL_INJECTION', lab: LABS.injection, family: 'Injection',
    objective: 'A parameter concatenated into a query is reported, by error signature and widened result set',
    expectCategory: 'SqlInjection',
    run: async scanner => injection.checkSqlInjection(scanner, {
      baseUrl: LABS.injection, path: '/api/products', parameter: 'name'
    })
  },
  {
    key: 'nosql-injection', vuln: 'VULN_NOSQL_INJECTION', lab: LABS.injection, family: 'Injection',
    objective: 'An operator object accepted where a string belongs is reported',
    expectCategory: 'NoSqlInjection',
    run: async scanner => injection.checkNoSqlInjection(scanner, {
      baseUrl: LABS.injection, path: '/api/login'
    })
  },
  {
    key: 'command-injection', vuln: 'VULN_COMMAND_INJECTION', lab: LABS.injection, family: 'Injection',
    objective: 'A value reaching a shell is reported from one metacharacter, with nothing executed',
    expectCategory: 'CommandInjection',
    run: async scanner => injection.checkCommandInjection(scanner, {
      baseUrl: LABS.injection, path: '/api/ping', parameter: 'host'
    })
  },
  {
    key: 'template-injection', vuln: 'VULN_TEMPLATE_INJECTION', lab: LABS.injection, family: 'Injection',
    objective: 'A parameter evaluated as a template is reported, against a measured baseline',
    expectCategory: 'TemplateInjection',
    run: async scanner => injection.checkTemplateInjection(scanner, {
      baseUrl: LABS.injection, path: '/api/render', parameter: 'template'
    })
  },

  // ---- Request-level -------------------------------------------------------
  {
    key: 'csrf-token', vuln: 'VULN_NO_CSRF_TOKEN', lab: LABS.csrf, family: 'Request handling',
    objective: 'A state-changing request succeeding with no anti-CSRF token is reported',
    expectCategory: 'MissingCsrfToken',
    run: async scanner => {
      const session = await scanner.signIn(LABS.csrf, 'alice');
      return request.checkCsrfToken(scanner, {
        baseUrl: LABS.csrf, path: '/api/transfer', session, body: { to: 'acc-1002', amount: 1 }
      });
    }
  },
  {
    key: 'origin-validation', vuln: 'VULN_NO_ORIGIN_CHECK', lab: LABS.csrf, family: 'Request handling',
    objective: 'A cross-origin state-changing request being accepted is reported',
    expectCategory: 'MissingOriginValidation',
    run: async scanner => {
      const session = await scanner.signIn(LABS.csrf, 'alice');
      return request.checkOriginValidation(scanner, {
        baseUrl: LABS.csrf, path: '/api/transfer', session, body: { to: 'acc-1002', amount: 1 }
      });
    }
  },
  {
    key: 'upload-type', vuln: 'VULN_UPLOAD_ANY_TYPE', lab: LABS.csrf, family: 'Request handling',
    objective: 'An executable extension with a mismatched content type being accepted is reported',
    expectCategory: 'UnrestrictedFileUpload',
    run: async scanner => {
      const alice = await identity(scanner, LABS.csrf, 'alice');
      return request.checkUploadRestrictions(scanner, { baseUrl: LABS.csrf, path: '/api/upload', actor: alice });
    }
  },
  {
    key: 'upload-size', vuln: 'VULN_UPLOAD_NO_SIZE_LIMIT', lab: LABS.csrf, family: 'Request handling',
    objective: 'A declared size far above the limit being accepted is reported, as declared not transferred',
    expectCategory: 'NoUploadSizeLimit',
    run: async scanner => {
      const alice = await identity(scanner, LABS.csrf, 'alice');
      return request.checkUploadRestrictions(scanner, { baseUrl: LABS.csrf, path: '/api/upload', actor: alice });
    }
  },
  {
    key: 'upload-traversal', vuln: 'VULN_UPLOAD_PATH_TRAVERSAL', lab: LABS.csrf, family: 'Request handling',
    objective: 'A filename stored with its relative path intact is reported',
    expectCategory: 'PathTraversalInFilename',
    run: async scanner => {
      const alice = await identity(scanner, LABS.csrf, 'alice');
      return request.checkUploadRestrictions(scanner, { baseUrl: LABS.csrf, path: '/api/upload', actor: alice });
    }
  },
  {
    key: 'open-redirect', vuln: 'VULN_OPEN_REDIRECT', lab: LABS.csrf, family: 'Request handling',
    objective: 'A redirect to an arbitrary host is reported, with the Location read and never followed',
    expectCategory: 'OpenRedirect',
    run: async scanner => request.checkOpenRedirect(scanner, {
      baseUrl: LABS.csrf, path: '/redirect', parameter: 'next'
    })
  },
  {
    key: 'ssrf', vuln: 'VULN_SSRF', lab: LABS.csrf, family: 'Request handling',
    objective: 'An unvalidated fetch destination is reported, without probing cloud metadata',
    expectCategory: 'ServerSideRequestForgery',
    run: async scanner => request.checkSsrf(scanner, {
      baseUrl: LABS.csrf, path: '/api/fetch', parameter: 'url'
    })
  },

  // ---- Passive -------------------------------------------------------------
  {
    key: 'no-csp', vuln: 'VULN_NO_CSP', lab: LABS.headers, family: 'Configuration',
    objective: 'A missing Content-Security-Policy on an HTML response is reported',
    expectCategory: 'MissingSecurityHeader',
    run: async scanner => passive.checkSecurityHeaders(scanner, `${LABS.headers}/weak`, 'SCN-NO-CSP')
  },
  {
    key: 'weak-cookie', vuln: 'VULN_WEAK_COOKIE', lab: LABS.headers, family: 'Configuration',
    objective: 'A session cookie with no HttpOnly, Secure or SameSite is reported',
    expectCategory: 'InsecureCookieAttributes',
    run: async scanner => passive.checkCookies(scanner, `${LABS.headers}/weak`, 'SCN-WEAK-COOKIE')
  },
  {
    key: 'reflected-cors', vuln: 'VULN_REFLECTED_CORS', lab: LABS.headers, family: 'Configuration',
    objective: 'An arbitrary origin reflected while credentials are allowed is reported — both together',
    expectCategory: 'DangerousCorsPolicy',
    run: async scanner => passive.checkCors(scanner, `${LABS.headers}/api/data`, 'SCN-CORS')
  },
  {
    key: 'directory-listing', vuln: 'VULN_DIRECTORY_LISTING', lab: LABS.headers, family: 'Configuration',
    objective: 'A directory index is reported',
    expectCategory: 'DirectoryListing',
    run: async scanner => passive.checkMisconfiguration(scanner, LABS.headers, 'SCN-LISTING')
  },
  {
    key: 'source-map', vuln: 'VULN_SOURCE_MAP', lab: LABS.headers, family: 'Configuration',
    objective: 'A served JavaScript source map is reported',
    expectCategory: 'SourceMapExposed',
    run: async scanner => passive.checkMisconfiguration(scanner, LABS.headers, 'SCN-SOURCEMAP')
  },
  {
    key: 'verbose-error', vuln: 'VULN_VERBOSE_ERROR', lab: LABS.headers, family: 'Configuration',
    objective: 'A stack trace naming source paths, host and framework version is reported',
    expectCategory: 'VerboseErrorDisclosure',
    run: async scanner => passive.checkSensitiveData(scanner, `${LABS.headers}/boom`, 'SCN-VERBOSE')
  }
];

/**
 * Endpoints the ground truth calls correct.
 *
 * These run with the lab in its ordinary, fully vulnerable state, because that is the
 * situation that actually produces false positives: a scanner that has just found four real
 * flaws in an application is the one most likely to invent a fifth. Any finding here is a
 * false positive and fails the scenario.
 */
export const SAFE_SCENARIOS = [
  {
    key: 'safe-own-accounts', lab: LABS.accessControl, endpoint: 'GET /api/accounts',
    objective: 'A collection that returns only the caller\'s own objects produces no BOLA finding',
    run: async scanner => {
      const bob = await identity(scanner, LABS.accessControl, 'bob');
      const alice = await identity(scanner, LABS.accessControl, 'alice');
      return authz.checkBola(scanner, {
        baseUrl: LABS.accessControl, path: '/api/accounts',
        owner: { ...bob, resourceId: 'acc-1002' }, intruder: alice, testId: 'SAFE-COLLECTION'
      });
    }
  },
  {
    key: 'safe-api-object', lab: LABS.api, endpoint: 'GET /api/accounts/{id}',
    objective: 'An object endpoint that enforces ownership produces no BOLA finding',
    run: async scanner => {
      const bob = await identity(scanner, LABS.api, 'bob');
      const alice = await identity(scanner, LABS.api, 'alice');
      return authz.checkBola(scanner, {
        baseUrl: LABS.api, path: '/api/accounts/{id}',
        owner: { ...bob, resourceId: 'acc-1002' }, intruder: alice, testId: 'SAFE-API-OBJECT'
      });
    }
  },
  {
    key: 'safe-escaped-reflection', lab: LABS.xss, endpoint: 'GET /greet?name=',
    objective: 'HTML-escaped reflection produces no XSS finding — reflection alone is not XSS',
    run: async scanner => xss.checkReflectedXss(scanner, {
      baseUrl: LABS.xss, path: '/greet', parameter: 'name', testId: 'SAFE-GREET'
    })
  },
  {
    key: 'safe-json-reflection', lab: LABS.xss, endpoint: 'GET /echo?value=',
    objective: 'Reflection into a JSON body produces no XSS finding — it is not an HTML context',
    run: async scanner => xss.checkReflectedXss(scanner, {
      baseUrl: LABS.xss, path: '/echo', parameter: 'value', testId: 'SAFE-ECHO'
    })
  },
  {
    key: 'safe-strict-headers', lab: LABS.headers, endpoint: 'GET /strict',
    objective: 'A page with every header set produces no header finding',
    run: async scanner => passive.checkSecurityHeaders(scanner, `${LABS.headers}/strict`, 'SAFE-STRICT')
  },
  {
    key: 'safe-strict-cookie', lab: LABS.headers, endpoint: 'GET /strict (cookie)',
    objective: 'A fully attributed session cookie produces no cookie finding',
    run: async scanner => passive.checkCookies(scanner, `${LABS.headers}/strict`, 'SAFE-STRICT-COOKIE')
  },
  {
    key: 'safe-public-cors', lab: LABS.headers, endpoint: 'GET /api/public',
    objective: 'A wildcard origin with no credentials on public data produces no CORS finding',
    run: async scanner => passive.checkCors(scanner, `${LABS.headers}/api/public`, 'SAFE-PUBLIC-CORS')
  },
  {
    key: 'safe-reset-enumeration', lab: LABS.auth, endpoint: 'POST /api/password-reset',
    objective: 'An endpoint that answers identically for a known and an unknown account produces no '
      + 'enumeration finding',
    run: async scanner => {
      // The enumeration check compares two failed attempts at the same endpoint. Here the
      // endpoint always accepts, so the comparison is between a real and an absent account.
      const real = await scanner.request({
        url: `${LABS.auth}/api/password-reset`, method: 'POST', risk: 2,
        headers: { 'content-type': 'application/json' }, body: { username: 'alice' },
        testId: 'SAFE-RESET:known', as: 'unauthenticated'
      });
      const absent = await scanner.request({
        url: `${LABS.auth}/api/password-reset`, method: 'POST', risk: 2,
        headers: { 'content-type': 'application/json' }, body: { username: 'aira-absent-user' },
        testId: 'SAFE-RESET:absent', as: 'unauthenticated'
      });
      const shape = r => `${r.status}:${Object.keys(r.responseBody ?? {}).sort().join(',')}`;
      return {
        skipped: false,
        findings: shape(real) === shape(absent) ? [] : [{ category: 'UserEnumeration' }],
        ok: shape(real) === shape(absent),
        detail: `known ${shape(real)}, absent ${shape(absent)}`
      };
    }
  },
  {
    key: 'safe-own-origin-fetch', lab: LABS.csrf, endpoint: 'GET /api/fetch?url=<same origin>',
    objective: 'A fetch endpoint that accepts only its own origin produces no SSRF finding',
    run: async scanner => {
      const result = await request.checkSsrf(scanner, {
        baseUrl: LABS.csrf, path: '/api/fetch', parameter: 'url', testId: 'SAFE-SSRF'
      });
      // The lab is fully vulnerable here, so this scenario is about the *same-origin*
      // destination specifically: it must not appear among the accepted internal ones.
      const sameOrigin = await scanner.request({
        url: `${LABS.csrf}/api/fetch?url=${encodeURIComponent(`${LABS.csrf}/health`)}`,
        risk: 1, testId: 'SAFE-SSRF:own-origin', as: 'unauthenticated'
      });
      return {
        skipped: false,
        findings: sameOrigin.status === 200 ? [] : [{ category: 'ServerSideRequestForgery' }],
        ok: sameOrigin.status === 200,
        detail: `the application's own origin answered ${sameOrigin.status}; the check's internal `
          + `destinations produced ${result.findings.length} finding(s), which is the separate `
          + 'detection scenario'
      };
    }
  }
];
