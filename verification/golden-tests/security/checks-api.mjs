/**
 * API-specific security behaviour: what an API does with the request itself.
 *
 * Where `checks-authz` asks who may reach what, these ask whether the API believes the
 * request. A field a caller should not be able to set. A type it should not accept. A verb
 * it should not answer. A volume it should not serve. A field it should not return.
 *
 * Two of these could be destructive if written without care, and are not:
 *
 *   `checkUnsafeMethods` sends DELETE against a resource the scan created itself, in this
 *   request, for this purpose — never against one it found. A scanner that deletes
 *   discovered objects to see whether it can is not testing an application, it is damaging
 *   one. The DELETE is declared destructive so the scope guard governs it, which means the
 *   check is refused rather than run unless someone has explicitly permitted destructive
 *   testing.
 *
 *   `checkRateLimit` sends a small, fixed number of requests — `attempts`, 15 by default —
 *   at the scope's configured rate. It establishes whether a threshold exists below that
 *   number. It is not a load test and must never become one.
 */
import { SECURITY_RISK } from './scope-guard.mjs';
import { SeverityFactors, confidenceFrom } from './severity.mjs';

/** Field names that a caller must never be able to set on themselves. */
const PRIVILEGED_FIELDS = ['role', 'isAdmin', 'admin', 'permissions', 'scopes', 'tenantId', 'verified'];

/** Response keys that should never leave the server. Matched on the key, not the value. */
const SECRET_FIELDS = [
  /password/i, /passwd/i, /^hash$/i, /passwordhash/i, /salt/i,
  /^token$/i, /apitoken/i, /api_key/i, /apikey/i, /secret/i, /privatekey/i, /ssn/i, /creditcard/i
];

/**
 * Mass assignment / broken object property level authorization.
 *
 * The claim is narrow on purpose: the caller sent a privileged field and the application
 * echoed it back as applied. An application that accepts the field and silently ignores it
 * returns the old value, and that is not a finding.
 */
export async function checkMassAssignment(scanner, { baseUrl, path, actor, fields = PRIVILEGED_FIELDS, escalateTo = 'admin', testId = 'SECA-MASSASSIGN' }) {
  const url = `${baseUrl}${path.replace('{id}', actor.resourceId)}`;

  const before = await scanner.request({
    url, risk: SECURITY_RISK.ACTIVE, testId: `${testId}:before`,
    headers: actor.cookie ? { cookie: actor.cookie } : {}, as: actor.label,
    note: 'reading the object before attempting to set a privileged field'
  });
  if (!before.allowed) return { skipped: true, decision: before.decision, findings: [] };

  const found = [];
  const exchanges = [before];

  for (const field of fields) {
    const attempt = await scanner.request({
      url, method: 'PATCH', risk: SECURITY_RISK.STATE_CHANGING, testId: `${testId}:${field}`,
      headers: { 'content-type': 'application/json', ...(actor.cookie ? { cookie: actor.cookie } : {}) },
      body: { [field]: escalateTo }, as: actor.label,
      note: `attempting to set '${field}' on the caller's own object`
    });
    if (!attempt.allowed) return { skipped: true, decision: attempt.decision, findings: [] };
    exchanges.push(attempt);

    if (attempt.status >= 400) continue;

    // Accepted is not applied. The finding requires the new value to come back.
    const body = attempt.responseBody ?? {};
    const applied = Array.isArray(body.applied) ? body.applied.includes(field) : null;
    const echoed = JSON.stringify(body).includes(`"${field}":"${escalateTo}"`);
    if (applied === true || echoed) found.push({ field, status: attempt.status });
  }

  if (found.length === 0) {
    return { skipped: false, findings: [], ok: true,
             detail: `${fields.length} privileged field(s) offered; none was applied` };
  }

  return {
    skipped: false,
    findings: [{
      category: 'BrokenObjectPropertyLevelAuthorization',
      title: `A caller can set a privileged field on their own object (${found.map(f => f.field).join(', ')})`,
      endpoint: path, httpMethod: 'PATCH', parameter: found[0].field, observedAsRole: actor.label,
      description: `${actor.label} sent ${found.map(f => `'${f.field}'`).join(', ')} in a PATCH of their own `
        + `object and the application returned the new value as applied. The field was not merely `
        + 'accepted and ignored: the response carries the value the caller supplied.',
      impact: 'A user can grant themselves a role or a permission the application never intended to expose.',
      remediation: 'Bind an explicit allowlist of writable fields per role rather than merging the request body.',
      cwe: 'CWE-915', cweConfidence: 'confirmed',
      owaspApiCategory: 'API3:2023', owaspWebCategory: 'A01:2021',
      severityFactors: new SeverityFactors('trivial', 'serious', 'authenticatedUser', 'personalData', 'authenticatedUsers'),
      confidence: confidenceFrom({ reproduced: false, corroborated: true, unambiguous: true }),
      exchanges
    }]
  };
}

/**
 * Missing input validation.
 *
 * Three probes that are safe against any application: a wrong type, an empty value and an
 * oversized value. The oversized value is bounded at `maxLength` — 5,000 characters by
 * default — because "send a gigabyte and see what happens" is a load test wearing a
 * security test's clothes.
 */
export async function checkInputValidation(scanner, { baseUrl, path, field, actor, maxLength = 5_000, testId = 'SECA-INPUT' }) {
  const url = `${baseUrl}${path}`;
  const headers = { 'content-type': 'application/json', ...(actor?.cookie ? { cookie: actor.cookie } : {}) };

  const probes = [
    { id: 'wrong-type', value: 12345, describes: 'a number where a string belongs' },
    { id: 'empty', value: '', describes: 'an empty value in a field that should be required' },
    { id: 'oversized', value: 'A'.repeat(maxLength), describes: `${maxLength} characters` }
  ];

  const accepted = [];
  const exchanges = [];
  for (const probe of probes) {
    const result = await scanner.request({
      url, method: 'POST', risk: SECURITY_RISK.STATE_CHANGING, testId: `${testId}:${probe.id}`,
      headers, body: { [field]: probe.value }, as: actor?.label ?? 'unauthenticated',
      note: `input validation probe: ${probe.describes}`
    });
    if (!result.allowed) return { skipped: true, decision: result.decision, findings: [] };
    exchanges.push(result);
    if (result.status >= 200 && result.status < 300) accepted.push(probe);
  }

  // One accepted probe is not a finding — plenty of fields legitimately accept an empty
  // string or a number. All three together mean the field is not validated at all.
  if (accepted.length < probes.length) {
    return { skipped: false, findings: [], ok: true,
             detail: `${accepted.length} of ${probes.length} probe(s) accepted; `
               + `rejected: ${probes.filter(p => !accepted.includes(p)).map(p => p.id).join(', ') || 'none'}` };
  }

  return {
    skipped: false,
    findings: [{
      category: 'MissingInputValidation',
      title: `'${field}' accepts any type, an empty value and an oversized value`,
      endpoint: path, httpMethod: 'POST', parameter: field, observedAsRole: actor?.label ?? 'unauthenticated',
      description: `All three probes were accepted: ${probes.map(p => `${p.describes} (${exchanges[probes.indexOf(p)].status})`).join(', ')}. `
        + 'Any one of these alone would be unremarkable; all three together indicate the field is not '
        + 'validated at all.',
      impact: 'Unvalidated input reaches whatever consumes it — storage, a template, a query, a downstream '
        + 'service — and each of those has its own way of being surprised.',
      remediation: 'Validate type, presence and length at the boundary, and reject rather than coerce.',
      cwe: 'CWE-20', cweConfidence: 'confirmed',
      owaspApiCategory: 'API8:2023', owaspWebCategory: 'A04:2021',
      severityFactors: new SeverityFactors('trivial', 'limited', 'authenticatedUser', 'nonSensitive', 'authenticatedUsers'),
      confidence: confidenceFrom({ reproduced: true, corroborated: true, unambiguous: false }),
      exchanges,
      coverageNote: `The oversized probe was bounded at ${maxLength} characters. No conclusion is drawn `
        + 'about behaviour at larger sizes, and none was attempted.'
    }]
  };
}

/**
 * A destructive verb answered without authorization.
 *
 * The object deleted is one this check created moments earlier through the application's
 * own creation endpoint. Nothing that existed before the scan is touched.
 */
export async function checkUnsafeMethods(scanner, { baseUrl, createPath, deletePath, field = 'title', actor, testId = 'SECA-METHOD' }) {
  const created = await scanner.request({
    url: `${baseUrl}${createPath}`, method: 'POST', risk: SECURITY_RISK.STATE_CHANGING,
    headers: { 'content-type': 'application/json', ...(actor?.cookie ? { cookie: actor.cookie } : {}) },
    body: { [field]: 'AIRA security probe: this object exists only to be deleted by this check' },
    as: actor?.label ?? 'unauthenticated', testId: `${testId}:create`,
    note: 'creating the object that the DELETE probe will target, so nothing pre-existing is at risk'
  });
  if (!created.allowed) return { skipped: true, decision: created.decision, findings: [] };
  if (created.status < 200 || created.status >= 300) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: `Could not create an object to delete (${created.status}), and this check will not `
               + 'delete one it did not create.' };
  }

  const body = created.responseBody ?? {};
  const id = body.id ?? body.note?.id ?? Object.values(body).map(v => v?.id).find(Boolean);
  if (!id) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: 'The creation response carries no identifier, so there is no object this check can '
               + 'safely target.' };
  }

  const attempt = await scanner.request({
    url: `${baseUrl}${deletePath.replace('{id}', id)}`, method: 'DELETE',
    risk: SECURITY_RISK.DESTRUCTIVE, testId: `${testId}:delete`,
    as: 'unauthenticated', note: 'deleting the scan\'s own object with no credentials'
  });
  if (!attempt.allowed) return { skipped: true, decision: attempt.decision, findings: [] };

  if (attempt.status === 401 || attempt.status === 403 || attempt.status === 405) {
    return { skipped: false, findings: [], ok: true, detail: `unauthenticated DELETE refused with ${attempt.status}` };
  }

  return {
    skipped: false,
    findings: [{
      category: 'UnsafeMethodAllowed',
      title: 'DELETE succeeds with no credentials',
      endpoint: deletePath, httpMethod: 'DELETE', observedAsRole: 'unauthenticated',
      description: `An unauthenticated DELETE received ${attempt.status}. The object deleted was created by `
        + 'this check one request earlier for exactly this purpose; no pre-existing data was touched.',
      impact: 'Anyone who can reach the endpoint can destroy data.',
      remediation: 'Require authentication and authorization on every state-changing verb, not only on reads.',
      cwe: 'CWE-650', cweConfidence: 'confirmed',
      owaspApiCategory: 'API5:2023', owaspWebCategory: 'A01:2021',
      severityFactors: new SeverityFactors('trivial', 'serious', 'none', 'nonSensitive', 'public'),
      confidence: confidenceFrom({ reproduced: false, corroborated: true, unambiguous: true }),
      exchanges: [created, attempt]
    }]
  };
}

/**
 * No rate limiting.
 *
 * Bounded at `attempts` and paced by the scope. This answers "is there a threshold below
 * fifteen requests", which is a useful thing to know and an honest thing to claim. It does
 * not answer "how much can this endpoint take", and the finding says so.
 */
export async function checkRateLimit(scanner, { baseUrl, path, attempts = 15, actor, testId = 'SECA-RATE' }) {
  const headers = actor?.cookie ? { cookie: actor.cookie } : {};
  const statuses = [];
  const exchanges = [];

  for (let i = 1; i <= attempts; i++) {
    const result = await scanner.request({
      url: `${baseUrl}${path}`, risk: SECURITY_RISK.ACTIVE, testId: `${testId}:${i}`,
      headers, as: actor?.label ?? 'unauthenticated', note: `bounded rate probe ${i} of ${attempts}`
    });
    if (!result.allowed) return { skipped: true, decision: result.decision, findings: [] };
    statuses.push(result.status);
    if (i === 1 || i === attempts) exchanges.push(result);
  }

  const limited = statuses.findIndex(s => s === 429);
  if (limited >= 0) {
    return { skipped: false, findings: [], ok: true, detail: `429 at request ${limited + 1} of ${attempts}` };
  }

  return {
    skipped: false,
    findings: [{
      category: 'NoRateLimit',
      title: `${attempts} requests in quick succession were never rate limited`,
      endpoint: path, httpMethod: 'GET', observedAsRole: actor?.label ?? 'unauthenticated',
      description: `${attempts} requests were answered ${[...new Set(statuses)].join('/')} with no 429 and no `
        + `Retry-After. Exactly ${attempts} requests were sent, at the rate the scan's scope permits.`,
      impact: 'An endpoint with no limit can be used for enumeration, scraping or amplification.',
      remediation: 'Rate limit per account and per source, and answer 429 with Retry-After.',
      cwe: 'CWE-770', cweConfidence: 'likely',
      owaspApiCategory: 'API4:2023', owaspWebCategory: 'A04:2021',
      severityFactors: new SeverityFactors('trivial', 'minimal', 'none', 'nonSensitive', 'public'),
      confidence: confidenceFrom({ reproduced: true, corroborated: false, unambiguous: false }),
      exchanges,
      coverageNote: `Bounded probe: ${attempts} requests. This establishes that no threshold exists below `
        + 'that number. It is not a load test and says nothing about capacity.'
    }]
  };
}

/**
 * Excessive data exposure — secrets in a response that had no business carrying them.
 *
 * Matched on field names rather than on values, because a value that looks like a secret
 * usually is not one and a field called `passwordHash` always is. The values themselves are
 * never reproduced in the finding.
 */
export async function checkExcessiveData(scanner, { baseUrl, path, actor, testId = 'SECA-EXCESS' }) {
  const result = await scanner.request({
    url: `${baseUrl}${path}`, risk: SECURITY_RISK.ACTIVE, testId,
    headers: actor?.cookie ? { cookie: actor.cookie } : {}, as: actor?.label ?? 'unauthenticated',
    note: 'reading a collection and inspecting the field names it returns'
  });
  if (!result.allowed) return { skipped: true, decision: result.decision, findings: [] };
  if (result.status !== 200) {
    return { skipped: false, findings: [], inconclusive: true, reason: `The endpoint answered ${result.status}.` };
  }

  const offending = new Set();
  const walk = value => {
    if (value === null || typeof value !== 'object') return;
    for (const [key, inner] of Object.entries(value)) {
      if (SECRET_FIELDS.some(p => p.test(key))) offending.add(key);
      walk(inner);
    }
  };
  walk(result.responseBody);

  if (offending.size === 0) {
    return { skipped: false, findings: [], ok: true, detail: 'no secret-shaped field names in the response' };
  }

  return {
    skipped: false,
    findings: [{
      category: 'SensitiveDataExposure',
      title: `The response carries ${[...offending].join(', ')}`,
      endpoint: path, httpMethod: 'GET', observedAsRole: actor?.label ?? 'unauthenticated',
      description: `${path} returns field(s) named ${[...offending].join(', ')}. The values are not `
        + 'reproduced here or in the sanitized evidence; the field names alone establish the finding.',
      impact: 'Credentials and secrets are handed to every client that reads the collection, and to '
        + 'every log, cache and proxy on the way.',
      remediation: 'Serialize an explicit view model rather than the storage entity.',
      cwe: 'CWE-213', cweConfidence: 'confirmed',
      owaspApiCategory: 'API3:2023', owaspWebCategory: 'A01:2021',
      severityFactors: new SeverityFactors('trivial', 'serious', 'authenticatedUser', 'credentials', 'authenticatedUsers'),
      confidence: confidenceFrom({ reproduced: false, corroborated: true, unambiguous: true }),
      exchanges: [result],
      // The values are the secret. Evidence writing redacts them; this names them so it can.
      redactLiterals: Object.values(result.responseBody?.users ?? []).flatMap(u =>
        [...offending].map(k => u?.[k]).filter(v => typeof v === 'string'))
    }]
  };
}
