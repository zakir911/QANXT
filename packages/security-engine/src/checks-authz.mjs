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
export async function checkBola(scanner, {
  baseUrl, path, owner, intruder,
  /**
   * Where the owner's resource came from: 'declared' when a caller who knows the data named
   * it, 'assumed' when it was read off an address discovery happened to reach.
   *
   * The difference decides whether a finding is possible at all. BOLA needs a record that
   * one identity may see and another must not, and an address the crawl reached establishes
   * only the first half. Deriving the identifier and then treating both identities reading it
   * as a finding reports an IDOR on every record two roles may legitimately share.
   *
   * Measured: pointed at freight's `/api/shipments/{id}` with the identifier taken from a
   * sample URL, this check reported "readonly can read a resource owned by ops.lead". The
   * application is right and the finding was wrong — `role-viewer` holds `shipment:read` by
   * design, and shipments belong to customers rather than to users. The control group is what
   * caught it: the finding persisted with the planted defect switched off.
   *
   * The same reasoning is already written into the vertical-escalation check: "Both roles
   * reached it. That is only a defect if the route was meant to be restricted, and nothing
   * observed here says it was."
   */
  resourceOwnership = 'declared',
  testId = 'SECA-BOLA'
}) {
  const sameActor = sameIdentity(owner, intruder);
  if (sameActor) {
    return {
      skipped: false, findings: [], inconclusive: true,
      reason: `Not evaluated: the owning and intruding identities are the same one `
        + `(${owner.label}), matched on ${sameActor}. An identity reading its own record is `
        + 'the application working. Supply two distinct identities.'
    };
  }

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
    note: resourceOwnership === 'declared'
      ? 'the owner reading their own resource'
      : 'an identity reading a record discovery saw it reach'
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

  // Both identities read the record. That is a finding only if the record was the first
  // one's to see and not the second's, and an identifier taken off an address the crawl
  // reached does not say so. Most records two roles can both read are records two roles are
  // both meant to read: a read-only auditor reading a shipment is the application working.
  //
  // So a derived resource can establish a pass — the intruder was refused — and cannot
  // establish a finding. Saying which is missing beats both a false finding and the old
  // "no resource was supplied", because the identifier is no longer what is missing.
  if (resourceOwnership !== 'declared') {
    return {
      skipped: false, findings: [], inconclusive: true,
      reason: `Not evaluated: ${owner.label} and ${intruder.label} both read ${resourceId}, and `
        + 'nothing establishes that it was private to the first. Its identifier was taken from '
        + 'an address discovery reached, which shows the record is visible to that identity and '
        + 'says nothing about whether the other was meant to see it — and a record two roles may '
        + 'both read is the ordinary case. Name a resource one identity owns, or map the '
        + 'application again as each identity and compare what each is shown.'
    };
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

/**
 * Whether two actors are the same identity, and on what evidence.
 *
 * Label alone is not enough: a caller may hand the same credential under two names. What
 * authenticates the request is what decides, so the headers and the cookie are compared too,
 * and the reason is returned so the check can say how it knows.
 *
 * @returns {string|null} what matched, or null when they are genuinely different
 */
function sameIdentity(a, b) {
  if (!a || !b) return null;
  if (a === b) return 'the same object';
  if (a.label && b.label && a.label === b.label) return 'their label';
  if (a.cookie && b.cookie && a.cookie === b.cookie) return 'the same session cookie';
  const headersOf = x => JSON.stringify(Object.entries(x.headers ?? {}).sort());
  const both = headersOf(a);
  if (both !== '[]' && both === headersOf(b)) return 'identical authentication headers';
  return null;
}

/** Broken function level authorization — a lesser role reaching a privileged route. */
export async function checkVerticalEscalation(scanner, { baseUrl, path, privileged, lesser, testId = 'SECA-VERT' }) {
  const url = at(baseUrl, `${path}`);

  // Two identities that are one identity cannot establish anything. The caller resolved both
  // of these by position once, got the administrator twice, and this check dutifully compared
  // him with himself and reported that both roles reached the route — on evidence that could
  // not have come out any other way. It reads as a scoping limit and is a check that could
  // never fail, which is the more dangerous of the two.
  const same = sameIdentity(privileged, lesser);
  if (same) {
    return {
      skipped: false, findings: [], inconclusive: true,
      reason: `Not evaluated: the privileged and lesser identities are the same one `
        + `(${privileged.label}), matched on ${same}. Comparing an identity with itself cannot `
        + 'show a privilege escalation, because the lesser identity holds every privilege. '
        + 'Supply two distinct identities, declaring which is which by role.'
    };
  }

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

  // Both roles reached it. That is only a defect if the route was meant to be restricted,
  // and nothing observed here says it was.
  //
  // This reported the finding on that evidence alone, at high severity with "confirmed" CWE
  // confidence and both corroborated and unambiguous set. On any real application most
  // authenticated collections are reachable by every role — that is what a collection is —
  // so a scan would raise one of these per collection, titled "a route intended for the
  // administrator" about a route intended for everybody. A permit register raised it on the
  // form clerks use to file applications.
  //
  // The route's own name is the only evidence available without discovering the application
  // separately as each role, which this engine does not do. So an administrative-looking
  // route still produces the finding, with the confidence that evidence deserves rather than
  // "unambiguous", and anything else is inconclusive with its reason stated. The stronger
  // version of this check is the application's own interface: a control the privileged user
  // is shown and the lesser user is not is the application declaring the route restricted.
  if (!looksPrivileged(path)) {
    return {
      skipped: false, findings: [], inconclusive: true,
      reason: `Both ${privileged.label} and ${lesser.label} reach ${path} (${control.status} and `
        + `${attempt.status}), and nothing about the route says it was meant to be restricted — `
        + 'most routes are reachable by every role. Compare what each role is shown in the '
        + 'interface, or name the privileged routes, to judge this one.'
    };
  }

  return {
    skipped: false,
    findings: [{
      category: 'BrokenFunctionLevelAuthorization',
      title: `${lesser.label} reaches ${path}, which names itself administrative`,
      endpoint: path, httpMethod: 'GET', observedAsRole: lesser.label,
      description: `${privileged.label} receives ${control.status} from ${path} and ${lesser.label} `
        + `receives ${attempt.status} from the same route. The route's own name says it is `
        + 'administrative, which is why this is reported; that naming is a convention rather '
        + 'than proof, so confirm the route is meant to be restricted before acting.',
      impact: 'A lower-privileged account can perform or observe privileged functions.',
      remediation: 'Check the caller\'s role on the route, not only in the interface that links to it.',
      cwe: 'CWE-285', cweConfidence: 'likely',
      owaspApiCategory: 'API5:2023', owaspWebCategory: 'A01:2021',
      severityFactors: new SeverityFactors('trivial', 'serious', 'authenticatedUser', 'personalData', 'authenticatedUsers'),
      // Corroborated — two identities were compared and the comparison is real. Not
      // unambiguous: whether the route is restricted is read from its name.
      confidence: confidenceFrom({ reproduced: false, corroborated: true, unambiguous: false }),
      exchanges: [control, attempt]
    }]
  };
}

/** A read-only role performing a write. */
export async function checkReadOnlyWrite(scanner, { baseUrl, path, writer, readonly, body, testId = 'SECA-RO' }) {
  const sameActor = sameIdentity(writer, readonly);
  if (sameActor) {
    return {
      skipped: false, findings: [], inconclusive: true,
      reason: `Not evaluated: the writing and read-only identities are the same one `
        + `(${writer.label}), matched on ${sameActor}. A write succeeding for an identity `
        + 'permitted to write establishes nothing about one that is not. Supply two distinct '
        + 'identities.'
    };
  }

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

  // A 200 is not an exposure. Data served to the anonymous caller is.
  //
  // This check asked only whether the anonymous request was refused, and read "not
  // refused" as "the data leaked". On an application rendered in the browser, every route
  // answers 200 with the same empty shell to everybody — the data arrives separately over
  // the API, which does refuse. A scan of a three-screen clinical scheduler raised three
  // criticals that way: "protected data is served to an unauthenticated caller" about a
  // 244-byte document containing a script tag and nothing else. On a real application with
  // fifty routes it would have raised fifty, and a tool that does that is not used twice.
  //
  // So the finding now requires something to have been served. Where nothing was, the
  // answer is inconclusive with the reason stated, because this route genuinely cannot
  // show an exposure either way — not a pass, which would read as "checked, and safe".
  const carried = carriesData(anonymous);
  if (!carried.hasData) {
    return {
      skipped: false, findings: [], inconclusive: true,
      reason: `The route answered ${anonymous.status} to an anonymous caller, but with no data in `
        + `it (${carried.why}). An application that renders in the browser serves the same shell on `
        + `every route and fetches its data separately, so this route cannot show an exposure. `
        + `Check the endpoints it calls.`
    };
  }

  return {
    skipped: false,
    findings: [{
      category: 'MissingAuthorization',
      title: 'Protected data is served to an unauthenticated caller',
      endpoint: path, httpMethod: 'GET', observedAsRole: 'unauthenticated',
      description: `A request with no credentials received ${anonymous.status} from ${path}, the same `
        + `answer the owner received, and it carried data: ${carried.why}.`,
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

/**
 * Did this response actually serve anything?
 *
 * The question an authorization finding depends on and that none of these checks used to
 * ask. A status code says the request was allowed; only the body says whether data came
 * back with it.
 *
 * Deliberately conservative about HTML. A document whose visible text is a handful of
 * characters is a shell — the thing a client-rendered application serves on every route —
 * and treating it as data is what produced three critical findings about an empty page.
 * A document with paragraphs, table rows or a list in it has been rendered server-side and
 * is data by any reading.
 *
 * @param {{responseBody?: unknown, responseText?: string, responseHeaders?: object}} response
 * @returns {{hasData: boolean, why: string}}
 */
export function carriesData(response) {
  const body = response?.responseBody;
  if (body && typeof body === 'object') {
    const count = Array.isArray(body) ? body.length : Object.keys(body).length;
    // A JSON error envelope is not data, however many fields it has.
    const looksLikeAComplaint = !Array.isArray(body)
      && ['error', 'message', 'detail', 'title'].some(key => key in body)
      && Object.keys(body).length <= 3;
    if (looksLikeAComplaint) return { hasData: false, why: 'the body is a JSON error message' };
    return count > 0
      ? { hasData: true, why: `a JSON body with ${count} field(s) or item(s)` }
      : { hasData: false, why: 'the JSON body is empty' };
  }

  const text = typeof response?.responseText === 'string'
    ? response.responseText
    : (typeof body === 'string' ? body : '');
  if (text.trim() === '') return { hasData: false, why: 'the body is empty' };

  const type = String(response?.responseHeaders?.['content-type'] ?? '');
  if (!/html|xml/i.test(type) && !/^\s*</.test(text)) {
    return { hasData: true, why: `a ${text.length}-byte body` };
  }

  // Script and style content is markup's plumbing, not what a reader sees.
  const visible = text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // A <title> is served by a shell too, so the threshold is above a page title's worth.
  const MINIMUM_VISIBLE_CHARACTERS = 60;
  return visible.length >= MINIMUM_VISIBLE_CHARACTERS
    ? { hasData: true, why: `${visible.length} characters of visible text` }
    : { hasData: false, why: `only ${visible.length} characters of visible text — an application shell` };
}

/**
 * Does this route's own name say it is administrative?
 *
 * The only evidence available to a check comparing two roles on one route, and it is weak:
 * a convention, not proof, which is why a finding resting on it is reported as likely rather
 * than confirmed. The alternative — concluding escalation from "both roles got 200" — raises
 * one finding per authenticated collection on every application there is.
 *
 * Matched on whole path segments so `/users` counts and `/user-preferences` does not, and
 * `/manage` counts while `/management-report` does not.
 */
export function looksPrivileged(path) {
  // One word each. A hyphenated entry could never match, because the path is split on its
  // separators before being compared — three of them were dead on arrival, and `/back-office`
  // read as an ordinary route. The joined form of each segment pair is tested instead, so
  // `/back-office` and `/backoffice` are the same route to this function.
  const ADMINISTRATIVE = [
    'admin', 'administration', 'administrator', 'superuser', 'root',
    'manage', 'management', 'console', 'backoffice', 'internal',
    'users', 'accounts', 'roles', 'permissions', 'members', 'staff',
    'settings', 'configuration', 'config', 'system',
    'audit', 'auditlog', 'logs', 'billing', 'invoices', 'reports'
  ];
  let pathname;
  try {
    pathname = new URL(path, 'http://placeholder.invalid').pathname;
  } catch {
    pathname = String(path ?? '').split('?')[0] ?? '';
  }
  const segments = pathname.toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (segments.some(segment => ADMINISTRATIVE.includes(segment))) return true;
  // `back-office`, `audit-log`: one word to a reader, two segments to a split.
  return segments.slice(0, -1)
    .some((segment, index) => ADMINISTRATIVE.includes(`${segment}${segments[index + 1]}`));
}
