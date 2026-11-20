/**
 * Authorization: the brief's highest-priority capability.
 *
 * Every check here works the same way and the shape is the point:
 *
 *   establish that the owner CAN                 (the control)
 *   establish that the non-owner CANNOT          (the claim)
 *
 * Without the control a refusal proves nothing — an endpoint that answers 404 to everybody
 * is broken, not secure, and a scanner that cannot tell those apart will report a healthy
 * application as hardened and a broken one as fine. Every finding below carries both
 * exchanges for exactly that reason.
 *
 * The identities are synthetic and belong to the lab. Nothing here uses a real account.
 */
import { SECURITY_RISK } from './scope-guard.mjs';
import { SeverityFactors, confidenceFrom } from './severity.mjs';
import { authHeaders } from './credentials.mjs';
import { at } from './target-url.mjs';

/** Statuses that count as a refusal. 404 is included: not telling a stranger a resource
 *  exists is a legitimate answer, and the brief names both. */
const REFUSED_STATUS = new Set([401, 403, 404]);

/**
 * Whether a response refused to hand over the resource.
 *
 * A status set of 401, 403 and 404 misses how most web applications actually protect a
 * page: they redirect to the sign-in form. Meridian Freight answers 302 with an empty body
 * for every protected route, and because 302 was not in the set, every one of those routes
 * was reported as "protected data is served to an unauthenticated caller" — 67 Critical
 * findings, all false, on an application that served nothing at all. That is worse than
 * finding none: 67 phantom criticals bury whatever is real and teach a team to ignore the
 * scanner.
 *
 * Three ways a response can refuse:
 *
 * A redirect serves no body, so nothing protected can have been disclosed by it. The one
 * exception is a redirect to the same path, which is canonicalisation rather than a
 * refusal, and that is reported as undecided rather than guessed at.
 *
 * A body that is a sign-in form is the application asking for credentials, whatever status
 * it carries — plenty answer 200 and render the login page.
 *
 * And the statuses that say no in words.
 */
export function refusal(response, requestedPath = '') {
  const status = Number(response?.status ?? 0);

  if (REFUSED_STATUS.has(status)) return { refused: true, how: `answered ${status}` };

  if (status >= 300 && status < 400) {
    const location = headerOf(response, 'location') ?? '';
    if (location !== '' && samePath(location, requestedPath)) {
      return { refused: false, undecided: true, how: `redirected to itself (${location})` };
    }
    return {
      refused: true,
      how: /sign-?in|log-?in|auth|session/i.test(location)
        ? `redirected to ${location}, which asks for credentials`
        : `answered ${status} with no body, so nothing was served`
    };
  }

  if (looksLikeSignInPage(response?.responseBody)) {
    return { refused: true, how: `answered ${status} with a sign-in form rather than the resource` };
  }

  return { refused: false, how: `answered ${status}` };
}

function headerOf(response, name) {
  const headers = response?.headers;
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

function samePath(location, requestedPath) {
  try {
    return new URL(location, 'http://placeholder.invalid').pathname === requestedPath.split('?')[0];
  } catch {
    return false;
  }
}

/** A body that is asking for credentials rather than answering the request. */
function looksLikeSignInPage(body) {
  if (typeof body !== 'string' || body === '') return false;
  return /<input[^>]+type=["\']?password/i.test(body);
}

/**
 * Broken object level authorization — one user reading another's object by identifier.
 *
 * @param owner     { cookie, label, resourceId }  who legitimately owns it
 * @param intruder  { cookie, label }              who should not see it
 */
export async function checkBola(scanner, { baseUrl, path, owner, intruder, testId = 'SECA-BOLA' }) {
  // The check compares what the owner can read against what a stranger can read, so it
  // needs to know which resource is the owner's. Without one it used to interpolate
  // `undefined` into the URL and then report that the stranger's response "did not contain
  // undefined" — a verdict assembled from a missing input, in a sentence no reader could
  // act on. A check that cannot do its job says so.
  const resourceId = owner?.resourceId;
  if (path.includes('{id}') && (resourceId === undefined || resourceId === null || resourceId === '')) {
    return {
      skipped: false, findings: [], inconclusive: true,
      reason: 'No resource belonging to the owning identity was supplied, so there is nothing '
        + 'for another identity to try to read. Give the identity a resourceId it owns.'
    };
  }

  const url = at(baseUrl, `${path.replace('{id}', resourceId ?? '')}`);

  const control = await scanner.request({
    url, risk: SECURITY_RISK.ACTIVE, testId: `${testId}:control`,
    headers: authHeaders(owner), as: owner.label,
    note: 'the owner reading their own resource'
  });
  if (!control.allowed) return { skipped: true, decision: control.decision, findings: [] };

  const attempt = await scanner.request({
    url, risk: SECURITY_RISK.ACTIVE, testId: `${testId}:attempt`,
    headers: authHeaders(intruder), as: intruder.label,
    note: 'another user reading the same resource'
  });
  if (!attempt.allowed) return { skipped: true, decision: attempt.decision, findings: [] };

  // The control has to work, or the whole comparison is meaningless.
  if (control.status !== 200) {
    return {
      skipped: false, findings: [], inconclusive: true,
      reason: `The owner could not read their own resource (${control.status}), so nothing can be `
        + 'concluded about whether another user can. This is reported as inconclusive rather '
        + 'than as a pass, because an endpoint that refuses everybody is not evidence of access control.'
    };
  }

  if (refusal(attempt, path).refused) {
    return { skipped: false, findings: [], ok: true,
             detail: `owner ${control.status}, ${intruder.label} ${attempt.status}` };
  }

  // The response has to actually contain the owner's data. A 200 carrying an empty list is
  // not a leak, and calling it one is how a scanner loses its reader.
  const leaked = JSON.stringify(attempt.responseBody ?? '').includes(owner.resourceId);

  if (!leaked) {
    return { skipped: false, findings: [], ok: true,
             detail: `${intruder.label} received ${attempt.status} but the body did not contain ${owner.resourceId}` };
  }

  return {
    skipped: false,
    findings: [{
      category: 'BOLA',
      title: `${intruder.label} can read a resource owned by ${owner.label}`,
      endpoint: path, httpMethod: 'GET', parameter: 'id', observedAsRole: intruder.label,
      description: `${owner.label} reads ${owner.resourceId} and receives ${control.status}, which is correct. `
        + `${intruder.label}, who does not own it, requests the same identifier and receives `
        + `${attempt.status} with ${owner.resourceId} in the body.`,
      impact: 'Any authenticated user can read another user\'s data by changing an identifier in the URL.',
      remediation: 'Check ownership on every object lookup, not only on the collection that lists them.',
      cwe: 'CWE-639', cweConfidence: 'confirmed',
      owaspApiCategory: 'API1:2023', owaspWebCategory: 'A01:2021',
      severityFactors: new SeverityFactors('trivial', 'serious', 'authenticatedUser', 'personalData', 'authenticatedUsers'),
      confidence: confidenceFrom({ reproduced: false, corroborated: true, unambiguous: true }),
      exchanges: [control, attempt]
    }]
  };
}

/** Broken function level authorization — a lesser role reaching a privileged route. */
export async function checkVerticalEscalation(scanner, { baseUrl, path, privileged, lesser, testId = 'SECA-VERT' }) {
  const url = at(baseUrl, `${path}`);

  const control = await scanner.request({
    url, risk: SECURITY_RISK.ACTIVE, testId: `${testId}:control`,
    headers: authHeaders(privileged), as: privileged.label,
    note: 'the privileged role reaching a privileged route'
  });
  if (!control.allowed) return { skipped: true, decision: control.decision, findings: [] };

  const attempt = await scanner.request({
    url, risk: SECURITY_RISK.ACTIVE, testId: `${testId}:attempt`,
    headers: authHeaders(lesser), as: lesser.label,
    note: 'a lesser role reaching the same route'
  });
  if (!attempt.allowed) return { skipped: true, decision: attempt.decision, findings: [] };

  if (control.status !== 200) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: `${privileged.label} could not reach ${path} either (${control.status}), so the route `
               + 'may simply be unavailable rather than protected.' };
  }
  if (refusal(attempt, path).refused) {
    return { skipped: false, findings: [], ok: true,
             detail: `${privileged.label} ${control.status}, ${lesser.label} ${attempt.status}` };
  }

  return {
    skipped: false,
    findings: [{
      category: 'BrokenFunctionLevelAuthorization',
      title: `${lesser.label} can reach a route intended for ${privileged.label}`,
      endpoint: path, httpMethod: 'GET', observedAsRole: lesser.label,
      description: `${privileged.label} receives ${control.status} from ${path}, which is expected. `
        + `${lesser.label} receives ${attempt.status} from the same route.`,
      impact: 'A lower-privileged account can perform or observe privileged functions.',
      remediation: 'Check the caller\'s role on the route, not only in the interface that links to it.',
      cwe: 'CWE-285', cweConfidence: 'confirmed',
      owaspApiCategory: 'API5:2023', owaspWebCategory: 'A01:2021',
      severityFactors: new SeverityFactors('trivial', 'serious', 'authenticatedUser', 'personalData', 'authenticatedUsers'),
      confidence: confidenceFrom({ reproduced: false, corroborated: true, unambiguous: true }),
      exchanges: [control, attempt]
    }]
  };
}

/** A read-only role performing a write. */
export async function checkReadOnlyWrite(scanner, { baseUrl, path, writer, readonly, body, testId = 'SECA-RO' }) {
  const url = at(baseUrl, `${path}`);

  const control = await scanner.request({
    url, method: 'POST', risk: SECURITY_RISK.STATE_CHANGING, testId: `${testId}:control`,
    headers: { 'content-type': 'application/json', ...authHeaders(writer) },
    body, as: writer.label, note: 'an account that should be able to write'
  });
  if (!control.allowed) return { skipped: true, decision: control.decision, findings: [] };

  const attempt = await scanner.request({
    url, method: 'POST', risk: SECURITY_RISK.STATE_CHANGING, testId: `${testId}:attempt`,
    headers: { 'content-type': 'application/json', ...authHeaders(readonly) },
    body, as: readonly.label, note: 'a read-only account attempting the same write'
  });
  if (!attempt.allowed) return { skipped: true, decision: attempt.decision, findings: [] };

  if (control.status >= 400) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: `${writer.label} could not write either (${control.status}); the endpoint may reject `
               + 'this payload for unrelated reasons.' };
  }
  if (refusal(attempt, path).refused) {
    return { skipped: false, findings: [], ok: true,
             detail: `${writer.label} ${control.status}, ${readonly.label} ${attempt.status}` };
  }

  return {
    skipped: false,
    findings: [{
      category: 'PrivilegeEscalation',
      title: `A read-only account can perform a write`,
      endpoint: path, httpMethod: 'POST', observedAsRole: readonly.label,
      description: `${readonly.label} holds a read-only role and received ${attempt.status} from `
        + `POST ${path}, the same answer ${writer.label} received.`,
      impact: 'An account granted read access can change data.',
      remediation: 'Enforce the role on the write path.',
      cwe: 'CWE-269', cweConfidence: 'confirmed',
      owaspApiCategory: 'API5:2023', owaspWebCategory: 'A01:2021',
      severityFactors: new SeverityFactors('trivial', 'serious', 'authenticatedUser', 'personalData', 'authenticatedUsers'),
      confidence: confidenceFrom({ reproduced: false, corroborated: true, unambiguous: true }),
      exchanges: [control, attempt]
    }]
  };
}

/** No authorization at all — an unauthenticated caller reaching protected data. */
export async function checkMissingAuthorization(scanner, { baseUrl, path, owner, testId = 'SECA-NOAUTHZ' }) {
  const url = at(baseUrl, `${path.replace('{id}', owner.resourceId)}`);

  const control = await scanner.request({
    url, risk: SECURITY_RISK.ACTIVE, testId: `${testId}:control`,
    headers: authHeaders(owner), as: owner.label,
    note: 'the owner, who should be able to read it'
  });
  if (!control.allowed) return { skipped: true, decision: control.decision, findings: [] };

  const anonymous = await scanner.request({
    url, risk: SECURITY_RISK.ACTIVE, testId: `${testId}:anonymous`,
    as: 'unauthenticated', note: 'no credentials at all'
  });
  if (!anonymous.allowed) return { skipped: true, decision: anonymous.decision, findings: [] };

  if (control.status !== 200) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: `The owner could not read it either (${control.status}).` };
  }
  if (refusal(anonymous, path).refused) {
    return { skipped: false, findings: [], ok: true,
             detail: `owner ${control.status}, unauthenticated ${anonymous.status}` };
  }

  return {
    skipped: false,
    findings: [{
      category: 'MissingAuthorization',
      title: 'Protected data is served to an unauthenticated caller',
      endpoint: path, httpMethod: 'GET', observedAsRole: 'unauthenticated',
      description: `A request with no credentials received ${anonymous.status} from ${path}, the same `
        + `answer the owner received.`,
      impact: 'Anyone who can reach the endpoint can read the data behind it.',
      remediation: 'Require authentication and check ownership on this route.',
      cwe: 'CWE-862', cweConfidence: 'confirmed',
      owaspApiCategory: 'API1:2023', owaspWebCategory: 'A01:2021',
      severityFactors: new SeverityFactors('trivial', 'severe', 'none', 'personalData', 'public'),
      confidence: confidenceFrom({ reproduced: false, corroborated: true, unambiguous: true }),
      exchanges: [control, anonymous]
    }]
  };
}

/** A forged bearer token accepted because it merely looks like one. */
export async function checkTokenVerification(scanner, { baseUrl, path, forgedToken, testId = 'SECA-TOKEN' }) {
  const url = at(baseUrl, `${path}`);

  const anonymous = await scanner.request({
    url, risk: SECURITY_RISK.ACTIVE, testId: `${testId}:anonymous`, as: 'unauthenticated'
  });
  if (!anonymous.allowed) return { skipped: true, decision: anonymous.decision, findings: [] };

  const forged = await scanner.request({
    url, risk: SECURITY_RISK.ACTIVE, testId: `${testId}:forged`,
    headers: { authorization: `Bearer ${forgedToken}` }, as: 'forged token',
    note: 'a bearer value that was never issued by this application'
  });
  if (!forged.allowed) return { skipped: true, decision: forged.decision, findings: [] };

  // The endpoint has to be protected for this to mean anything: if it answers 200 to nobody
  // in particular, the forged token proved nothing.
  if (!refusal(anonymous, path).refused) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: `The endpoint answers ${anonymous.status} with no credentials at all, so accepting `
               + 'a forged token says nothing about token verification. It is a missing-authorization '
               + 'finding instead, which is reported separately.' };
  }
  if (refusal(forged, path).refused) {
    return { skipped: false, findings: [], ok: true,
             detail: `anonymous ${anonymous.status}, forged token ${forged.status}` };
  }

  return {
    skipped: false,
    findings: [{
      category: 'UnverifiedToken',
      title: 'A forged bearer token is accepted',
      endpoint: path, httpMethod: 'GET', observedAsRole: 'forged token',
      description: `The endpoint refuses an anonymous request (${anonymous.status}) but accepts a bearer `
        + `value this application never issued (${forged.status}). The token's shape is being mistaken `
        + 'for its validity.',
      impact: 'Anyone can author a token naming any user and be accepted as them.',
      remediation: 'Verify the signature and the issuer on every token, not its format.',
      cwe: 'CWE-345', cweConfidence: 'confirmed',
      owaspApiCategory: 'API2:2023', owaspWebCategory: 'A07:2021',
      severityFactors: new SeverityFactors('trivial', 'severe', 'none', 'credentials', 'public'),
      confidence: confidenceFrom({ reproduced: false, corroborated: true, unambiguous: true }),
      exchanges: [anonymous, forged]
    }]
  };
}
