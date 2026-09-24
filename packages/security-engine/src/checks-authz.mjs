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

/** Statuses that count as a refusal. 404 is included: not telling a stranger a resource
 *  exists is a legitimate answer, and the brief names both. */
const REFUSED = new Set([401, 403, 404]);

/**
 * Broken object level authorization — one user reading another's object by identifier.
 *
 * @param owner     { cookie, label, resourceId }  who legitimately owns it
 * @param intruder  { cookie, label }              who should not see it
 */
export async function checkBola(scanner, { baseUrl, path, owner, intruder, testId = 'SECA-BOLA' }) {
  const url = `${baseUrl}${path.replace('{id}', owner.resourceId)}`;

  const control = await scanner.request({
    url, risk: SECURITY_RISK.ACTIVE, testId: `${testId}:control`,
    headers: owner.cookie ? { cookie: owner.cookie } : {}, as: owner.label,
    note: 'the owner reading their own resource'
  });
  if (!control.allowed) return { skipped: true, decision: control.decision, findings: [] };

  const attempt = await scanner.request({
    url, risk: SECURITY_RISK.ACTIVE, testId: `${testId}:attempt`,
    headers: intruder.cookie ? { cookie: intruder.cookie } : {}, as: intruder.label,
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

  if (REFUSED.has(attempt.status)) {
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
  const url = `${baseUrl}${path}`;

  const control = await scanner.request({
    url, risk: SECURITY_RISK.ACTIVE, testId: `${testId}:control`,
    headers: privileged.cookie ? { cookie: privileged.cookie } : {}, as: privileged.label,
    note: 'the privileged role reaching a privileged route'
  });
  if (!control.allowed) return { skipped: true, decision: control.decision, findings: [] };

  const attempt = await scanner.request({
    url, risk: SECURITY_RISK.ACTIVE, testId: `${testId}:attempt`,
    headers: lesser.cookie ? { cookie: lesser.cookie } : {}, as: lesser.label,
    note: 'a lesser role reaching the same route'
  });
  if (!attempt.allowed) return { skipped: true, decision: attempt.decision, findings: [] };

  if (control.status !== 200) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: `${privileged.label} could not reach ${path} either (${control.status}), so the route `
               + 'may simply be unavailable rather than protected.' };
  }
  if (REFUSED.has(attempt.status)) {
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
  const url = `${baseUrl}${path}`;

  const control = await scanner.request({
    url, method: 'POST', risk: SECURITY_RISK.STATE_CHANGING, testId: `${testId}:control`,
    headers: { 'content-type': 'application/json', ...(writer.cookie ? { cookie: writer.cookie } : {}) },
    body, as: writer.label, note: 'an account that should be able to write'
  });
  if (!control.allowed) return { skipped: true, decision: control.decision, findings: [] };

  const attempt = await scanner.request({
    url, method: 'POST', risk: SECURITY_RISK.STATE_CHANGING, testId: `${testId}:attempt`,
    headers: { 'content-type': 'application/json', ...(readonly.cookie ? { cookie: readonly.cookie } : {}) },
    body, as: readonly.label, note: 'a read-only account attempting the same write'
  });
  if (!attempt.allowed) return { skipped: true, decision: attempt.decision, findings: [] };

  if (control.status >= 400) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: `${writer.label} could not write either (${control.status}); the endpoint may reject `
               + 'this payload for unrelated reasons.' };
  }
  if (REFUSED.has(attempt.status)) {
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
  const url = `${baseUrl}${path.replace('{id}', owner.resourceId)}`;

  const control = await scanner.request({
    url, risk: SECURITY_RISK.ACTIVE, testId: `${testId}:control`,
    headers: owner.cookie ? { cookie: owner.cookie } : {}, as: owner.label,
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
  if (REFUSED.has(anonymous.status)) {
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
  const url = `${baseUrl}${path}`;

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
  if (!REFUSED.has(anonymous.status)) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: `The endpoint answers ${anonymous.status} with no credentials at all, so accepting `
               + 'a forged token says nothing about token verification. It is a missing-authorization '
               + 'finding instead, which is reported separately.' };
  }
  if (REFUSED.has(forged.status)) {
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
