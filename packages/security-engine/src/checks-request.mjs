/**
 * Request-level flaws: CSRF, file upload, open redirect and SSRF.
 *
 * What these have in common is that the application is being asked to trust something it
 * should not — a request's origin, a file's name, a redirect target, a URL to fetch.
 *
 * Safety, check by check:
 *
 *   CSRF     sends the application's own state-changing request, once, with the same body
 *            a legitimate caller would send. It changes whatever that endpoint changes.
 *            Declared state-changing so the scope guard governs it.
 *   upload   sends metadata describing a file. It does not send an executable, a script,
 *            a web shell or a polyglot, and the "oversized" probe declares a size rather
 *            than transferring one — a scanner that uploads a gigabyte to test a size
 *            limit is running a load test.
 *   redirect never follows the Location it is given. The finding is that the header names
 *            an external host; going there is not part of establishing that.
 *   SSRF     asks the application to fetch a loopback address by default. The metadata
 *            endpoints (169.254.169.254 and friends) are behind an explicit opt-in and are
 *            off unless someone has turned them on, because the brief forbids reaching
 *            cloud metadata or internal infrastructure by default — and because a scanner
 *            that quietly pulls credentials out of an instance profile has done real harm
 *            in the course of proving it could.
 */
import { SECURITY_RISK } from './scope-guard.mjs';
import { SeverityFactors, confidenceFrom } from './severity.mjs';

/** A host that exists to be recognised in a Location header and is never visited. */
const EXTERNAL_MARKER_HOST = 'aira-redirect-probe.invalid';

/**
 * Missing anti-CSRF token: a state-changing request succeeds without one.
 *
 * The control matters as much as the claim. An endpoint that refuses the request with a
 * token as well proves nothing, and this reports inconclusive rather than calling it safe.
 */
export async function checkCsrfToken(scanner, { baseUrl, path, session, body = {}, tokenHeader = 'x-csrf-token', testId = 'SECA-CSRF' }) {
  if (!session?.cookie) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: 'No authenticated session, so a cross-site request cannot be distinguished from an '
               + 'unauthenticated one.' };
  }

  const withToken = await scanner.request({
    url: `${baseUrl}${path}`, method: 'POST', risk: SECURITY_RISK.STATE_CHANGING,
    headers: {
      'content-type': 'application/json', cookie: session.cookie,
      origin: baseUrl, ...(session.csrf ? { [tokenHeader]: session.csrf } : {})
    },
    body, as: 'the legitimate caller', testId: `${testId}:control`,
    note: 'the request as the application\'s own page would send it'
  });
  if (!withToken.allowed) return { skipped: true, decision: withToken.decision, findings: [] };
  if (withToken.status >= 400) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: `The endpoint refused the request even with a token and a same-site origin `
               + `(${withToken.status}), so nothing can be concluded about what it does without one.` };
  }

  const withoutToken = await scanner.request({
    url: `${baseUrl}${path}`, method: 'POST', risk: SECURITY_RISK.STATE_CHANGING,
    headers: { 'content-type': 'application/json', cookie: session.cookie, origin: baseUrl },
    body, as: 'a caller with no anti-CSRF token', testId: `${testId}:no-token`,
    note: 'the same request with the anti-CSRF token removed'
  });
  if (!withoutToken.allowed) return { skipped: true, decision: withoutToken.decision, findings: [] };

  if (withoutToken.status >= 400) {
    return { skipped: false, findings: [], ok: true,
             detail: `with token ${withToken.status}, without token ${withoutToken.status}` };
  }

  return {
    skipped: false,
    findings: [{
      category: 'MissingCsrfToken',
      title: 'A state-changing request succeeds with no anti-CSRF token',
      endpoint: path, httpMethod: 'POST', observedAsRole: 'authenticated session, no token',
      description: `The request succeeded with a token (${withToken.status}) and succeeded identically `
        + `without one (${withoutToken.status}). The session cookie alone is enough to authorise the change.`,
      impact: 'Any site the user visits while signed in can make this request on their behalf.',
      remediation: 'Require a per-session anti-CSRF token on every state-changing request, or set the '
        + 'session cookie SameSite=Strict and validate Origin.',
      cwe: 'CWE-352', cweConfidence: 'confirmed',
      owaspApiCategory: 'API8:2023', owaspWebCategory: 'A01:2021',
      severityFactors: new SeverityFactors('straightforward', 'serious', 'none', 'personalData', 'public'),
      confidence: confidenceFrom({ reproduced: false, corroborated: true, unambiguous: true }),
      exchanges: [withToken, withoutToken]
    }]
  };
}

/** Missing origin validation: a cross-origin Origin header is accepted. */
export async function checkOriginValidation(scanner, { baseUrl, path, session, body = {}, tokenHeader = 'x-csrf-token', testId = 'SECA-ORIGIN' }) {
  if (!session?.cookie) {
    return { skipped: false, findings: [], inconclusive: true, reason: 'No authenticated session.' };
  }

  const headers = {
    'content-type': 'application/json', cookie: session.cookie,
    ...(session.csrf ? { [tokenHeader]: session.csrf } : {})
  };

  const sameOrigin = await scanner.request({
    url: `${baseUrl}${path}`, method: 'POST', risk: SECURITY_RISK.STATE_CHANGING,
    headers: { ...headers, origin: baseUrl }, body,
    as: 'same-origin', testId: `${testId}:control`, note: 'the request with the application\'s own origin'
  });
  if (!sameOrigin.allowed) return { skipped: true, decision: sameOrigin.decision, findings: [] };
  if (sameOrigin.status >= 400) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: `The endpoint refused a same-origin request (${sameOrigin.status}).` };
  }

  const crossOrigin = await scanner.request({
    url: `${baseUrl}${path}`, method: 'POST', risk: SECURITY_RISK.STATE_CHANGING,
    headers: { ...headers, origin: `https://${EXTERNAL_MARKER_HOST}` }, body,
    as: 'cross-origin', testId: `${testId}:cross`,
    note: `the same request claiming to come from ${EXTERNAL_MARKER_HOST}, a host that does not resolve`
  });
  if (!crossOrigin.allowed) return { skipped: true, decision: crossOrigin.decision, findings: [] };

  if (crossOrigin.status >= 400) {
    return { skipped: false, findings: [], ok: true,
             detail: `same-origin ${sameOrigin.status}, cross-origin ${crossOrigin.status}` };
  }

  return {
    skipped: false,
    findings: [{
      category: 'MissingOriginValidation',
      title: 'A state-changing request is accepted from any origin',
      endpoint: path, httpMethod: 'POST', observedAsRole: 'cross-origin caller',
      description: `An Origin of https://${EXTERNAL_MARKER_HOST} was accepted (${crossOrigin.status}), the `
        + `same answer a same-origin request received (${sameOrigin.status}). The header is not being read. `
        + 'The host named does not resolve and nothing was sent to it.',
      impact: 'The origin check that would stop a cross-site request is not there.',
      remediation: 'Validate Origin (and Sec-Fetch-Site where available) on every state-changing request.',
      cwe: 'CWE-352', cweConfidence: 'confirmed',
      // A01, not A05. A missing origin check is a broken access control, not a
      // misconfiguration — it is the same failure as the missing anti-CSRF token beside it,
      // and filing the two under different categories would split one problem in a report.
      owaspApiCategory: 'API8:2023', owaspWebCategory: 'A01:2021',
      // 'nonSensitive': a missing origin check on its own does not reach personal data — it
      // removes one of the two defences against a cross-site request. Where the anti-CSRF
      // token is also missing, that finding carries the data impact and this one does not
      // need to double-count it.
      severityFactors: new SeverityFactors('straightforward', 'limited', 'none', 'nonSensitive', 'public'),
      confidence: confidenceFrom({ reproduced: false, corroborated: true, unambiguous: true }),
      exchanges: [sameOrigin, crossOrigin]
    }]
  };
}

/**
 * Unrestricted file upload.
 *
 * Nothing executable is sent. The probe describes a file — a name, a declared content type
 * and a size — because that is what the application's validation reads, and because
 * sending a real web shell to an application that might store and serve it is how a test
 * becomes the incident it was meant to prevent.
 */
export async function checkUploadRestrictions(scanner, { baseUrl, path, actor, declaredOversizeBytes = 50 * 1024 * 1024, testId = 'SECA-UPLOAD' }) {
  const headers = { 'content-type': 'application/json', ...(actor?.cookie ? { cookie: actor.cookie } : {}) };
  const send = async (body, id, note) => scanner.request({
    url: `${baseUrl}${path}`, method: 'POST', risk: SECURITY_RISK.STATE_CHANGING,
    headers, body, as: actor?.label ?? 'unauthenticated', testId: `${testId}:${id}`, note
  });

  const findings = [];

  // ---- executable extension with a mismatched declared type ----------------
  const executable = await send(
    { filename: 'aira-probe.php', contentType: 'image/png', size: 64,
      content: 'inert marker; this is not a script and nothing is intended to run' },
    'extension', 'an executable extension declared as an image — metadata only, no payload');
  if (!executable.allowed) return { skipped: true, decision: executable.decision, findings: [] };

  if (executable.status >= 200 && executable.status < 300) {
    findings.push({
      category: 'UnrestrictedFileUpload',
      title: 'An executable extension with a mismatched content type is accepted',
      endpoint: path, httpMethod: 'POST', parameter: 'filename',
      observedAsRole: actor?.label ?? 'unauthenticated',
      description: `A file named aira-probe.php declaring itself image/png was accepted `
        + `(${executable.status}). Neither the extension nor the disagreement between the two was `
        + 'checked. No executable content was sent: the request carried a name, a declared type and a '
        + 'size, which is what the validation reads.',
      impact: 'A file the server may later execute or serve can be uploaded by anyone who can upload at all.',
      remediation: 'Allowlist extensions, verify the content against the declared type, store outside the '
        + 'web root and serve with a fixed content type.',
      cwe: 'CWE-434', cweConfidence: 'confirmed',
      owaspApiCategory: 'API8:2023', owaspWebCategory: 'A04:2021',
      severityFactors: new SeverityFactors('straightforward', 'serious', 'authenticatedUser', 'personalData', 'public'),
      confidence: confidenceFrom({ reproduced: false, corroborated: true, unambiguous: true }),
      exchanges: [executable]
    });
  }

  // ---- a declared size far above any plausible limit -----------------------
  const oversize = await send(
    { filename: 'aira-probe.txt', contentType: 'text/plain', size: declaredOversizeBytes, content: 'marker' },
    'size', `a declared size of ${declaredOversizeBytes} bytes — declared, not transferred`);
  if (!oversize.allowed) return { skipped: true, decision: oversize.decision, findings: [] };

  if (oversize.status >= 200 && oversize.status < 300) {
    findings.push({
      category: 'NoUploadSizeLimit',
      title: `A declared size of ${Math.round(declaredOversizeBytes / 1024 / 1024)}MB is accepted`,
      endpoint: path, httpMethod: 'POST', parameter: 'size',
      observedAsRole: actor?.label ?? 'unauthenticated',
      description: `The upload declared ${declaredOversizeBytes} bytes and was accepted `
        + `(${oversize.status}). The size was declared in the request body; nothing of that size was `
        + 'transferred, and no attempt was made to find the real limit by sending larger and larger files.',
      impact: 'Storage and bandwidth can be consumed without bound.',
      remediation: 'Enforce a maximum size, and enforce it on the bytes received rather than on what the '
        + 'client declares.',
      cwe: 'CWE-770', cweConfidence: 'likely',
      owaspApiCategory: 'API4:2023', owaspWebCategory: 'A04:2021',
      // 'straightforward' rather than 'trivial': declaring a large size is free, but causing
      // any actual harm means transferring the bytes, which this check deliberately did not do
      // and cannot speak to.
      severityFactors: new SeverityFactors('straightforward', 'minimal', 'authenticatedUser', 'none', 'authenticatedUsers'),
      confidence: confidenceFrom({ reproduced: false, corroborated: false, unambiguous: true }),
      exchanges: [oversize],
      coverageNote: 'The size was declared, not transferred. This establishes that the declared value is '
        + 'not validated, not that a file of that size would be accepted.'
    });
  }

  // ---- path traversal in the supplied filename -----------------------------
  const traversal = await send(
    { filename: '../../aira-probe.txt', contentType: 'text/plain', size: 32, content: 'marker' },
    'traversal', 'a relative path in the filename');
  if (!traversal.allowed) return { skipped: true, decision: traversal.decision, findings: [] };

  const storedAs = traversal.responseBody?.upload?.storedAs ?? traversal.responseBody?.storedAs ?? null;
  if (traversal.status >= 200 && traversal.status < 300 && typeof storedAs === 'string' && storedAs.includes('..')) {
    findings.push({
      category: 'PathTraversalInFilename',
      title: 'The supplied filename is stored without sanitisation',
      endpoint: path, httpMethod: 'POST', parameter: 'filename',
      observedAsRole: actor?.label ?? 'unauthenticated',
      description: `A filename of '../../aira-probe.txt' was stored as '${storedAs}', keeping the relative `
        + 'path. The finding is what the application reported it stored; no file was written outside any '
        + 'directory during this test and none was attempted.',
      impact: 'A caller can influence where a file is written, which in the general case means overwriting '
        + 'something the application depends on.',
      remediation: 'Discard the supplied name. Generate the stored name yourself.',
      cwe: 'CWE-22', cweConfidence: 'confirmed',
      owaspApiCategory: 'API8:2023', owaspWebCategory: 'A01:2021',
      severityFactors: new SeverityFactors('straightforward', 'serious', 'authenticatedUser', 'personalData', 'authenticatedUsers'),
      confidence: confidenceFrom({ reproduced: false, corroborated: true, unambiguous: true }),
      exchanges: [traversal]
    });
  }

  if (findings.length === 0) {
    return { skipped: false, findings: [], ok: true,
             detail: `extension ${executable.status}, declared size ${oversize.status}, `
               + `traversal ${traversal.status}${storedAs ? ` stored as '${storedAs}'` : ''}` };
  }
  return { skipped: false, findings };
}

/**
 * Open redirect.
 *
 * The Location header is read; it is never followed. `redirect: 'manual'` is set on every
 * request the engine makes, so this is enforced rather than promised.
 */
export async function checkOpenRedirect(scanner, { baseUrl, path, parameter = 'next', testId = 'SECA-REDIRECT' }) {
  const target = `https://${EXTERNAL_MARKER_HOST}/aira-probe`;

  const relative = await scanner.request({
    url: `${baseUrl}${path}?${parameter}=${encodeURIComponent('/dashboard')}`,
    risk: SECURITY_RISK.ACTIVE, testId: `${testId}:control`, as: 'unauthenticated',
    note: 'a relative destination, which the endpoint should accept'
  });
  if (!relative.allowed) return { skipped: true, decision: relative.decision, findings: [] };

  const external = await scanner.request({
    url: `${baseUrl}${path}?${parameter}=${encodeURIComponent(target)}`,
    risk: SECURITY_RISK.ACTIVE, testId: `${testId}:external`, as: 'unauthenticated',
    note: `an absolute destination on ${EXTERNAL_MARKER_HOST}, a host that does not resolve; the Location `
      + 'header is read and never followed'
  });
  if (!external.allowed) return { skipped: true, decision: external.decision, findings: [] };

  const location = external.responseHeaders?.location ?? '';
  const redirected = external.status >= 300 && external.status < 400;
  const goesExternal = location.includes(EXTERNAL_MARKER_HOST);

  if (!(redirected && goesExternal)) {
    return { skipped: false, findings: [], ok: true,
             detail: `relative ${relative.status}, external ${external.status}`
               + `${location ? ` → ${location}` : ''}` };
  }

  return {
    skipped: false,
    findings: [{
      category: 'OpenRedirect',
      title: `'${parameter}' redirects to any host`,
      endpoint: path, httpMethod: 'GET', parameter, observedAsRole: 'unauthenticated',
      description: `The endpoint answered ${external.status} with Location: ${location}. The destination `
        + 'was supplied in the query string and was not checked against the application\'s own origin. '
        + `The host does not resolve and the redirect was not followed — the engine issues every request `
        + 'with redirects disabled.',
      impact: 'A link that starts on a domain the user trusts can land them anywhere, which is what makes '
        + 'this useful in phishing and in stealing tokens carried in a redirect.',
      remediation: 'Allow relative paths only, or match the destination against an allowlist of hosts.',
      cwe: 'CWE-601', cweConfidence: 'confirmed',
      owaspApiCategory: 'API8:2023', owaspWebCategory: 'A01:2021',
      // 'minimal' direct impact: an open redirect does not by itself disclose or change
      // anything. Its value to an attacker is as a step in something else, and scoring the
      // step as though it were the whole attack is how severity stops meaning anything.
      severityFactors: new SeverityFactors('trivial', 'minimal', 'none', 'nonSensitive', 'public'),
      confidence: confidenceFrom({ reproduced: false, corroborated: true, unambiguous: true }),
      exchanges: [relative, external]
    }]
  };
}

/**
 * Server-side request forgery.
 *
 * By default this asks the application to fetch a loopback address on a port nothing is
 * listening on. That is enough to tell an application that validates its targets from one
 * that does not, and it reaches nothing.
 *
 * The cloud-metadata payloads are behind `allowMetadataPayloads`, which is false unless
 * someone sets it. The brief forbids reaching cloud metadata or internal infrastructure by
 * default, and there is a practical reason as well as a rule: an instance-metadata endpoint
 * hands out credentials, and a scanner that pulls them into its own evidence store has
 * created the breach it was hired to look for.
 */
export async function checkSsrf(scanner, { baseUrl, path, parameter = 'url', allowMetadataPayloads = false, testId = 'SECA-SSRF' }) {
  const probes = [
    { id: 'loopback', value: 'http://127.0.0.1:9/aira-probe',
      describes: 'a loopback address on the discard port, where nothing is listening' },
    { id: 'private-range', value: 'http://10.255.255.1/aira-probe',
      describes: 'an address in a private range that does not route from here' }
  ];
  if (allowMetadataPayloads) {
    probes.push({ id: 'cloud-metadata', value: 'http://169.254.169.254/latest/meta-data/',
                  describes: 'a cloud instance metadata endpoint, included only because the scan was '
                    + 'explicitly configured to' });
  }

  const external = await scanner.request({
    url: `${baseUrl}${path}?${parameter}=${encodeURIComponent(`https://${EXTERNAL_MARKER_HOST}/`)}`,
    risk: SECURITY_RISK.ACTIVE, testId: `${testId}:control`, as: 'unauthenticated',
    note: 'a destination outside the application, to establish what it does with one'
  });
  if (!external.allowed) return { skipped: true, decision: external.decision, findings: [] };

  const accepted = [];
  const exchanges = [external];
  for (const probe of probes) {
    const result = await scanner.request({
      url: `${baseUrl}${path}?${parameter}=${encodeURIComponent(probe.value)}`,
      risk: SECURITY_RISK.ACTIVE, testId: `${testId}:${probe.id}`, as: 'unauthenticated',
      note: `SSRF probe: ${probe.describes}`
    });
    if (!result.allowed) return { skipped: true, decision: result.decision, findings: [] };
    exchanges.push(result);

    // 400 means the application refused the target, which is the correct answer. Anything
    // else means it took the destination seriously — whether the connection then succeeded
    // is a property of the network, not of the application's validation.
    if (result.status !== 400 && result.status !== 403) accepted.push({ probe, status: result.status });
  }

  if (accepted.length === 0) {
    return { skipped: false, findings: [], ok: true,
             detail: `${probes.length} internal destination(s), all refused` };
  }

  return {
    skipped: false,
    findings: [{
      category: 'ServerSideRequestForgery',
      title: `'${parameter}' is fetched without validating the destination`,
      endpoint: path, httpMethod: 'GET', parameter, observedAsRole: 'unauthenticated',
      description: `The application accepted ${accepted.length} internal destination(s) it should have `
        + `refused: ${accepted.map(a => `${a.probe.value} (${a.status})`).join(', ')}. Each names an `
        + 'address that routes nowhere from here; nothing was reached and nothing was read back.'
        + (allowMetadataPayloads
          ? ' Cloud metadata payloads were included because this scan was explicitly configured to send them.'
          : ' Cloud metadata endpoints were NOT probed: they are off by default, and this finding says '
            + 'nothing about whether they are reachable.'),
      impact: 'The application will make requests to addresses the caller chooses, from inside the network '
        + 'where it runs.',
      remediation: 'Resolve the destination and match the resolved address against an allowlist, refusing '
        + 'loopback, link-local and private ranges — and re-check after every redirect.',
      cwe: 'CWE-918', cweConfidence: 'confirmed',
      owaspApiCategory: 'API7:2023', owaspWebCategory: 'A10:2021',
      severityFactors: new SeverityFactors('straightforward', 'serious', 'none', 'credentials', 'public'),
      confidence: confidenceFrom({ reproduced: true, corroborated: true, unambiguous: false }),
      exchanges,
      coverageNote: allowMetadataPayloads
        ? 'Cloud metadata endpoints were probed because this scan was configured to.'
        : 'Cloud metadata and internal infrastructure were not probed. That area is untested, not clean.'
    }]
  };
}
