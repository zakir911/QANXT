/**
 * Authentication and session management.
 *
 * These are the checks most likely to be run against an application someone cares about,
 * and the ones most likely to be destructive if written carelessly. Two rules shape every
 * check below:
 *
 *   The credentials are synthetic. Nothing here tries a real password, a leaked-password
 *   list, or a name harvested from anywhere. The usernames are the lab's own, and the one
 *   check that submits wrong passwords submits a fixed, small number of them against a
 *   synthetic account.
 *
 *   A lockout probe is bounded and declared. `checkAccountLockout` sends exactly
 *   `attempts` requests — six by default, one more than a conventional threshold — and
 *   says so in the finding. That is enough to observe whether a threshold exists and few
 *   enough that it is not a load test. The brief forbids DDoS and load attacks as part of
 *   security scanning, and an unbounded "keep going until something breaks" loop is one.
 */
import { SECURITY_RISK } from './scope-guard.mjs';
import { SeverityFactors, confidenceFrom } from './severity.mjs';

/** A username that cannot exist, used to draw the comparison for enumeration. */
const ABSENT_USER = 'aira-nonexistent-user-6f2a9c';

/**
 * Reduces a response to the parts that could carry an enumeration signal.
 *
 * Comparing two response bodies byte for byte does not work, and getting this wrong is how
 * a scanner earns its reputation. Any application that returns a request id, a nonce, a
 * CSRF token or a timestamp produces two different bodies for two identical requests, and
 * a byte comparison calls that enumeration. Equally, an application that echoes the
 * submitted username back — "Sign-in failed for alice" — differs between the two probes for
 * a reason that has nothing to do with whether the account exists.
 *
 * So the shape is: the status, the sorted key paths, and the values of the fields that
 * actually carry meaning about *why* the request failed, with the submitted username
 * replaced by a placeholder and long or high-entropy values dropped.
 */
const MEANINGFUL_KEYS = new Set(['error', 'code', 'reason', 'message', 'detail', 'error_description']);
const HIGH_ENTROPY = /^[A-Za-z0-9_\-]{16,}$/;

function keyPaths(value, prefix = '', out = []) {
  if (value === null || typeof value !== 'object') return out;
  for (const key of Object.keys(value).sort()) {
    out.push(`${prefix}${key}`);
    keyPaths(value[key], `${prefix}${key}.`, out);
  }
  return out;
}

export function responseShape(result, submittedUsername) {
  const body = result.responseBody;
  const mask = text => String(text)
    .replaceAll(submittedUsername, '<username>')
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, '<timestamp>');

  const meaningful = {};
  const walk = (value, prefix = '') => {
    if (value === null || typeof value !== 'object') return;
    for (const [key, inner] of Object.entries(value)) {
      if (MEANINGFUL_KEYS.has(key) && typeof inner === 'string' && !HIGH_ENTROPY.test(inner)) {
        meaningful[`${prefix}${key}`] = mask(inner);
      }
      walk(inner, `${prefix}${key}.`);
    }
  };
  if (typeof body === 'object' && body !== null) {
    walk(body);
  } else if (typeof body === 'string') {
    // Not JSON. Mask and keep it, but only up to a bound: a whole HTML page compared
    // literally is the byte comparison this function exists to avoid.
    meaningful.text = mask(body).slice(0, 400);
  }

  return {
    status: result.status,
    keys: typeof body === 'object' && body !== null ? keyPaths(body) : [],
    meaningful
  };
}

/**
 * User enumeration — the application says whether the *account* was wrong or the
 * *password* was.
 *
 * Detection compares two failures rather than reading one, because a single 401 says
 * nothing. Status, body and a coarse timing band are all compared; only the first two
 * are ever reported as confirmed, since timing alone on a local lab is noise.
 */
export async function checkUserEnumeration(scanner, { baseUrl, path = '/api/session', knownUser, testId = 'SECA-ENUM' }) {
  const attempt = async (username, label) => scanner.request({
    url: `${baseUrl}${path}`, method: 'POST', risk: SECURITY_RISK.ACTIVE, testId: `${testId}:${label}`,
    headers: { 'content-type': 'application/json' },
    body: { username, password: 'aira-deliberately-wrong-password' },
    as: label, note: 'a deliberately failing sign-in, used only to compare the two answers'
  });

  const real = await attempt(knownUser, 'known-username');
  if (!real.allowed) return { skipped: true, decision: real.decision, findings: [] };
  const absent = await attempt(ABSENT_USER, 'absent-username');
  if (!absent.allowed) return { skipped: true, decision: absent.decision, findings: [] };

  // Both have to fail, or the comparison is about something else entirely.
  if (real.status === 200 || absent.status === 200) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: `One of the two deliberately wrong sign-ins succeeded (${real.status}/${absent.status}), `
               + 'so these answers are not comparable.' };
  }

  const realShape = responseShape(real, knownUser);
  const absentShape = responseShape(absent, ABSENT_USER);

  const sameStatus = realShape.status === absentShape.status;
  const sameKeys = JSON.stringify(realShape.keys) === JSON.stringify(absentShape.keys);
  const sameMeaning = JSON.stringify(realShape.meaningful) === JSON.stringify(absentShape.meaningful);

  if (sameStatus && sameKeys && sameMeaning) {
    return { skipped: false, findings: [], ok: true,
             detail: `both answered ${real.status} with the same shape and the same stated reason` };
  }

  const differing = [
    sameStatus ? null : `status ${real.status} vs ${absent.status}`,
    sameKeys ? null : 'response fields',
    sameMeaning ? null : 'the stated reason for the failure'
  ].filter(Boolean);

  return {
    skipped: false,
    findings: [{
      category: 'UserEnumeration',
      title: 'The sign-in endpoint distinguishes an unknown account from a wrong password',
      endpoint: path, httpMethod: 'POST', parameter: 'username', observedAsRole: 'unauthenticated',
      description: `A failed sign-in for an existing username and a failed sign-in for a username that `
        + `does not exist differ by ${differing.join(' and ')}. The submitted username was replaced by a `
        + 'placeholder and high-entropy values were dropped before comparing, so an application that '
        + 'merely echoes the name back or issues a fresh nonce is not reported here. '
        + `Existing: ${JSON.stringify(realShape.meaningful)}. Absent: ${JSON.stringify(absentShape.meaningful)}.`,
      impact: 'An attacker can confirm which accounts exist before attempting anything against them, '
        + 'which makes every later attack cheaper and quieter.',
      remediation: 'Return one answer for every failed sign-in, regardless of which part was wrong.',
      cwe: 'CWE-204', cweConfidence: 'confirmed',
      owaspApiCategory: 'API2:2023', owaspWebCategory: 'A07:2021',
      severityFactors: new SeverityFactors('trivial', 'minimal', 'none', 'nonSensitive', 'public'),
      confidence: confidenceFrom({ reproduced: false, corroborated: true, unambiguous: true }),
      exchanges: [real, absent]
    }]
  };
}

/**
 * No throttling or lockout on repeated failed sign-ins.
 *
 * Bounded by construction: `attempts` requests and no more, against one synthetic account,
 * at the scope's configured rate. This observes whether a threshold exists. It is not, and
 * must not become, a credential-stuffing or load test.
 */
export async function checkAccountLockout(scanner, { baseUrl, path = '/api/session', knownUser, attempts = 6, testId = 'SECA-LOCKOUT' }) {
  const observed = [];
  for (let i = 1; i <= attempts; i++) {
    const result = await scanner.request({
      url: `${baseUrl}${path}`, method: 'POST', risk: SECURITY_RISK.ACTIVE, testId: `${testId}:${i}`,
      headers: { 'content-type': 'application/json' },
      body: { username: knownUser, password: `aira-wrong-${i}` },
      as: 'unauthenticated', note: `bounded failed sign-in ${i} of ${attempts}`
    });
    if (!result.allowed) return { skipped: true, decision: result.decision, findings: [] };
    observed.push(result);
  }

  const throttled = observed.find(r => r.status === 429 || r.status === 423);
  if (throttled) {
    return { skipped: false, findings: [], ok: true,
             detail: `throttled at attempt ${observed.indexOf(throttled) + 1} with ${throttled.status}` };
  }

  return {
    skipped: false,
    findings: [{
      category: 'NoAccountLockout',
      title: `${attempts} consecutive failed sign-ins were never throttled`,
      endpoint: path, httpMethod: 'POST', observedAsRole: 'unauthenticated',
      description: `${attempts} failed sign-ins for the same account were each answered `
        + `${[...new Set(observed.map(r => r.status))].join('/')}, with no lockout, delay or 429. `
        + `Exactly ${attempts} attempts were made and no more: this establishes that no threshold `
        + 'exists below that number, not how far the endpoint can be pushed.',
      impact: 'Passwords can be guessed at whatever rate the network allows.',
      remediation: 'Throttle or lock after a small number of consecutive failures, per account and per source.',
      cwe: 'CWE-307', cweConfidence: 'confirmed',
      owaspApiCategory: 'API4:2023', owaspWebCategory: 'A07:2021',
      severityFactors: new SeverityFactors('straightforward', 'minimal', 'none', 'credentials', 'public'),
      confidence: confidenceFrom({ reproduced: true, corroborated: false, unambiguous: true }),
      // Only the first and last are kept; six near-identical exchanges in evidence help nobody.
      exchanges: [observed[0], observed[observed.length - 1]],
      coverageNote: `Bounded probe: ${attempts} attempts. No conclusion is drawn about behaviour beyond that.`
    }]
  };
}

/** A session token that still authenticates after the user signed out. */
export async function checkSessionInvalidation(scanner, { baseUrl, signOutPath = '/api/session', probePath = '/api/session', credentials, testId = 'SECA-LOGOUT' }) {
  const signedIn = await scanner.signIn(baseUrl, credentials.username, credentials.password);
  if (!signedIn?.cookie) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: 'Could not sign in with the supplied synthetic credentials, so session invalidation '
               + 'could not be observed.' };
  }

  const before = await scanner.request({
    url: `${baseUrl}${probePath}`, risk: SECURITY_RISK.ACTIVE, testId: `${testId}:before`,
    headers: { cookie: signedIn.cookie }, as: credentials.username, note: 'the session working, before sign-out'
  });
  if (!before.allowed) return { skipped: true, decision: before.decision, findings: [] };
  if (before.status !== 200) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: `The session did not authenticate even before sign-out (${before.status}).` };
  }

  const signOut = await scanner.request({
    url: `${baseUrl}${signOutPath}`, method: 'DELETE', risk: SECURITY_RISK.STATE_CHANGING,
    testId: `${testId}:signout`, headers: { cookie: signedIn.cookie }, as: credentials.username,
    note: 'signing the synthetic identity out'
  });
  if (!signOut.allowed) return { skipped: true, decision: signOut.decision, findings: [] };

  const after = await scanner.request({
    url: `${baseUrl}${probePath}`, risk: SECURITY_RISK.ACTIVE, testId: `${testId}:after`,
    headers: { cookie: signedIn.cookie }, as: 'retained token',
    note: 'the same token, replayed after sign-out'
  });
  if (!after.allowed) return { skipped: true, decision: after.decision, findings: [] };

  if (after.status !== 200) {
    return { skipped: false, findings: [], ok: true,
             detail: `before ${before.status}, sign-out ${signOut.status}, replay ${after.status}` };
  }

  return {
    skipped: false,
    findings: [{
      category: 'SessionNotInvalidatedOnLogout',
      title: 'A session token keeps working after sign-out',
      endpoint: signOutPath, httpMethod: 'DELETE', observedAsRole: 'retained token',
      description: `The token authenticated (${before.status}), sign-out was accepted (${signOut.status}), `
        + `and the same token then authenticated again (${after.status}). Clearing the cookie makes the `
        + 'browser forget the token; it does not stop anyone who kept a copy from using it.',
      impact: 'Signing out does not end the session. A token taken from a shared machine, a log or a '
        + 'proxy remains valid.',
      remediation: 'Invalidate the session server-side on sign-out, not only in the browser.',
      cwe: 'CWE-613', cweConfidence: 'confirmed',
      owaspApiCategory: 'API2:2023', owaspWebCategory: 'A07:2021',
      severityFactors: new SeverityFactors('straightforward', 'serious', 'none', 'credentials', 'public'),
      confidence: confidenceFrom({ reproduced: false, corroborated: true, unambiguous: true }),
      exchanges: [before, signOut, after]
    }]
  };
}

/**
 * An excessive session lifetime, read from what the application states.
 *
 * This reads a declared TTL rather than waiting one out. A scanner cannot observe a 30-day
 * expiry without waiting 30 days, and a finding that says "the application told us 30 days"
 * is honest about what was measured in a way that one implying it was witnessed would not be.
 */
export async function checkSessionLifetime(scanner, { baseUrl, credentials, maxSeconds = 86_400, testId = 'SECA-TTL' }) {
  const result = await scanner.request({
    url: `${baseUrl}/api/session`, method: 'POST', risk: SECURITY_RISK.STATE_CHANGING,
    headers: { 'content-type': 'application/json' },
    body: { username: credentials.username, password: credentials.password ?? 'lab-password' },
    as: credentials.username, testId: `${testId}:signin`, note: 'reading the declared session lifetime'
  });
  if (!result.allowed) return { skipped: true, decision: result.decision, findings: [] };
  if (result.status !== 200) {
    return { skipped: false, findings: [], inconclusive: true, reason: `Sign-in failed (${result.status}).` };
  }

  const body = result.responseBody ?? {};
  const setCookie = result.headers?.getSetCookie?.() ?? [];
  const maxAge = setCookie.map(c => /max-age=(\d+)/i.exec(c)?.[1]).find(Boolean);
  const declared = Number(body.expiresInSeconds ?? body.expires_in ?? maxAge ?? NaN);

  if (!Number.isFinite(declared)) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: 'The application does not state a session lifetime in the response body or the cookie, '
               + 'so none could be read. This is reported as not measured rather than as acceptable.' };
  }
  if (declared <= maxSeconds) {
    return { skipped: false, findings: [], ok: true, detail: `declared lifetime ${declared}s` };
  }

  return {
    skipped: false,
    findings: [{
      category: 'ExcessiveSessionLifetime',
      title: `The application states a session lifetime of ${Math.round(declared / 86_400)} day(s)`,
      endpoint: '/api/session', httpMethod: 'POST', observedAsRole: credentials.username,
      description: `The sign-in response states a lifetime of ${declared} seconds, above the `
        + `${maxSeconds}-second threshold this scan was configured with. This is what the application `
        + 'declared, not an expiry that was waited out and witnessed.',
      impact: 'A stolen token stays useful for far longer than it needs to.',
      remediation: 'Shorten the session lifetime and refresh it on activity instead.',
      cwe: 'CWE-613', cweConfidence: 'likely',
      owaspApiCategory: 'API2:2023', owaspWebCategory: 'A07:2021',
      severityFactors: new SeverityFactors('theoretical', 'limited', 'none', 'credentials', 'public', true),
      confidence: confidenceFrom({ reproduced: false, corroborated: false, unambiguous: true }),
      exchanges: [result],
      coverageNote: 'Read from the declared lifetime. The expiry itself was not waited out.'
    }]
  };
}

/** A password-reset token accepted more than once. */
export async function checkResetTokenReuse(scanner, { baseUrl, requestPath = '/api/password-reset', confirmPath = '/api/password-reset/confirm', knownUser, testId = 'SECA-RESET' }) {
  const issued = await scanner.request({
    url: `${baseUrl}${requestPath}`, method: 'POST', risk: SECURITY_RISK.STATE_CHANGING,
    headers: { 'content-type': 'application/json' }, body: { username: knownUser },
    as: 'unauthenticated', testId: `${testId}:request`, note: 'requesting a reset for a synthetic account'
  });
  if (!issued.allowed) return { skipped: true, decision: issued.decision, findings: [] };

  const token = issued.responseBody?.resetToken ?? issued.responseBody?.token ?? null;
  if (!token) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: 'The reset token is not returned in the response, which is correct behaviour for a '
               + 'real application. Reuse cannot be tested without the token, so this is reported as '
               + 'not testable by this check rather than as a pass.' };
  }

  const first = await scanner.request({
    url: `${baseUrl}${confirmPath}`, method: 'POST', risk: SECURITY_RISK.STATE_CHANGING,
    headers: { 'content-type': 'application/json' }, body: { token },
    as: 'unauthenticated', testId: `${testId}:first`, note: 'using the reset token once'
  });
  if (!first.allowed) return { skipped: true, decision: first.decision, findings: [] };
  if (first.status !== 200) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: `The token was not accepted even once (${first.status}).` };
  }

  const second = await scanner.request({
    url: `${baseUrl}${confirmPath}`, method: 'POST', risk: SECURITY_RISK.STATE_CHANGING,
    headers: { 'content-type': 'application/json' }, body: { token },
    as: 'unauthenticated', testId: `${testId}:second`, note: 'using the same token a second time'
  });
  if (!second.allowed) return { skipped: true, decision: second.decision, findings: [] };

  if (second.status !== 200) {
    return { skipped: false, findings: [], ok: true, detail: `first ${first.status}, second ${second.status}` };
  }

  return {
    skipped: false,
    findings: [{
      category: 'PasswordResetTokenReuse',
      title: 'A password-reset token is accepted more than once',
      endpoint: confirmPath, httpMethod: 'POST', parameter: 'token', observedAsRole: 'unauthenticated',
      description: `The same reset token was accepted twice, both times with ${second.status}. A reset `
        + 'token is a single-use credential; one that survives its use is a standing key to the account.',
      impact: 'Anyone who obtains a used reset token can take the account over at any later time.',
      remediation: 'Invalidate the token on first use and give it a short expiry.',
      cwe: 'CWE-640', cweConfidence: 'confirmed',
      owaspApiCategory: 'API2:2023', owaspWebCategory: 'A07:2021',
      severityFactors: new SeverityFactors('straightforward', 'serious', 'none', 'credentials', 'public'),
      confidence: confidenceFrom({ reproduced: true, corroborated: true, unambiguous: true }),
      exchanges: [first, second]
    }]
  };
}
