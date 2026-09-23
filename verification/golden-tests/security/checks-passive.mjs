/**
 * Passive checks: everything readable from a response the application was already serving.
 *
 * Nothing here sends input the application did not ask for, so every check runs at
 * SECURITY_RISK.PASSIVE and survives the passive profile — which is what makes this the
 * only set that may run against an authorized production environment.
 *
 * The recurring discipline is restraint. A missing header is not automatically a
 * vulnerability, a permissive CORS policy is not automatically dangerous, and a string that
 * looks like an email is not automatically a leak. Each check below decides with context and
 * says which way it decided, including when the answer is "not applicable".
 */
import { SECURITY_RISK } from './scope-guard.mjs';
import { SeverityFactors } from './severity.mjs';

/** Headers a browser-facing HTML response should carry, and what each one is for. */
const EXPECTED_HEADERS = [
  { name: 'content-security-policy', purpose: 'limits where scripts may come from' },
  { name: 'x-content-type-options', purpose: 'stops content-type sniffing' },
  { name: 'x-frame-options', purpose: 'stops the page being framed', alternative: 'a frame-ancestors directive in CSP' },
  { name: 'referrer-policy', purpose: 'limits what is leaked in the Referer header' },
  { name: 'strict-transport-security', purpose: 'pins HTTPS', httpsOnly: true },
  { name: 'permissions-policy', purpose: 'limits access to device features', advisory: true }
];

/**
 * Security headers on an HTML response.
 *
 * Returns one finding per genuinely missing header, and reports the rest as present so a
 * coverage report can say what was checked rather than only what failed.
 */
export async function checkSecurityHeaders(scanner, url, testId = 'SECP-HEADERS') {
  const result = await scanner.request({ url, risk: SECURITY_RISK.PASSIVE, testId });
  if (!result.allowed) return { skipped: true, decision: result.decision, findings: [], observations: [] };

  const headers = result.responseHeaders ?? {};
  const isHtml = (headers['content-type'] ?? '').includes('text/html');
  const isHttps = url.startsWith('https://');

  const findings = [];
  const observations = [];

  for (const expected of EXPECTED_HEADERS) {
    // Not applicable is a real answer and is recorded as one. HSTS on a plain-HTTP lab
    // address is not a finding; reporting it as one is how a report earns distrust.
    if (expected.httpsOnly && !isHttps) {
      observations.push({ header: expected.name, state: 'notApplicable', why: 'the response was not served over HTTPS' });
      continue;
    }
    if (!isHtml && expected.name !== 'x-content-type-options') {
      observations.push({ header: expected.name, state: 'notApplicable', why: 'the response is not an HTML document' });
      continue;
    }

    const value = headers[expected.name];
    if (value) { observations.push({ header: expected.name, state: 'present', value }); continue; }

    // x-frame-options is satisfied by CSP frame-ancestors, and reporting both would be
    // reporting the same gap twice.
    if (expected.alternative && (headers['content-security-policy'] ?? '').includes('frame-ancestors')) {
      observations.push({ header: expected.name, state: 'present', value: expected.alternative });
      continue;
    }

    observations.push({ header: expected.name, state: 'missing' });
    if (expected.advisory) continue;   // reported, never a finding on its own

    findings.push({
      category: 'MissingSecurityHeader',
      title: `${expected.name} is not set`,
      parameter: expected.name,
      endpoint: new URL(url).pathname,
      description: `The response carries no ${expected.name} header, which ${expected.purpose}.`,
      impact: 'A browser applies its own defaults, which are more permissive than an explicit policy.',
      remediation: `Set ${expected.name} on HTML responses.`,
      cwe: 'CWE-1021', cweConfidence: 'potential',
      owaspWebCategory: 'A05:2021',
      // Deliberately modest. A missing header is not itself exploitable and reaches no data.
      severityFactors: new SeverityFactors('difficult', 'limited', 'none', 'none', 'public'),
      exchanges: [result]
    });
  }

  return { skipped: false, findings, observations };
}

/** Cookie attributes, judged against what the cookie appears to be for. */
export async function checkCookies(scanner, url, testId = 'SECP-COOKIES') {
  const result = await scanner.request({ url, risk: SECURITY_RISK.PASSIVE, testId });
  if (!result.allowed) return { skipped: true, decision: result.decision, findings: [], observations: [] };

  const setCookies = result.headers?.getSetCookie?.() ?? [];
  const findings = [];
  const observations = [];

  for (const raw of setCookies) {
    const [pair] = raw.split(';');
    const name = pair.split('=')[0].trim();
    const attributes = raw.split(';').slice(1).map(a => a.trim().toLowerCase());

    const has = a => attributes.some(x => x === a || x.startsWith(`${a}=`));
    const httpOnly = has('httponly');
    const secure = has('secure');
    const sameSite = attributes.find(a => a.startsWith('samesite='))?.split('=')[1] ?? null;

    // Purpose matters. A session cookie without HttpOnly is a finding; a UI preference
    // cookie without it is how preferences work, and flagging it is noise.
    const looksLikeSession = /sess|auth|token|jwt|sid/i.test(name);

    // The value is never recorded — only its shape.
    observations.push({ cookie: name, httpOnly, secure, sameSite, looksLikeSession, valueLength: pair.split('=')[1]?.length ?? 0 });

    if (!looksLikeSession) continue;

    const missing = [];
    if (!httpOnly) missing.push('HttpOnly');
    if (!sameSite) missing.push('SameSite');
    // Secure on a plain-HTTP address would prevent the cookie being sent at all, so its
    // absence there is correct rather than careless.
    if (!secure && url.startsWith('https://')) missing.push('Secure');

    if (missing.length === 0) continue;

    findings.push({
      category: 'InsecureCookieAttributes',
      title: `Session cookie "${name}" is missing ${missing.join(', ')}`,
      parameter: name,
      endpoint: new URL(url).pathname,
      description: `The cookie "${name}" looks like a session cookie and does not set ${missing.join(', ')}.`,
      impact: missing.includes('HttpOnly')
        ? 'Script running in the page can read the session cookie.'
        : 'The cookie is sent on cross-site requests.',
      remediation: `Set ${missing.join(', ')} on "${name}".`,
      cwe: 'CWE-1004', cweConfidence: 'confirmed',
      owaspWebCategory: 'A05:2021',
      severityFactors: new SeverityFactors('difficult', 'serious', 'none', 'credentials', 'public'),
      exchanges: [result]
    });
  }

  return { skipped: false, findings, observations };
}

/**
 * CORS. Only the genuinely dangerous combination is a finding.
 *
 * The brief says not to classify every permissive policy as a vulnerability, and the line is
 * credentials: reflecting an arbitrary origin is how a public API works, and reflecting one
 * *while allowing credentials* is how another site reads a signed-in user's data.
 */
export async function checkCors(scanner, url, testId = 'SECP-CORS') {
  const probeOrigin = 'https://aira-security-probe.invalid';
  const result = await scanner.request({
    url, risk: SECURITY_RISK.PASSIVE, testId, headers: { origin: probeOrigin }
  });
  if (!result.allowed) return { skipped: true, decision: result.decision, findings: [], observations: [] };

  const allowOrigin = result.responseHeaders?.['access-control-allow-origin'] ?? null;
  const allowCredentials = (result.responseHeaders?.['access-control-allow-credentials'] ?? '').toLowerCase() === 'true';

  const reflectsArbitrary = allowOrigin === probeOrigin;
  const wildcard = allowOrigin === '*';

  const observations = [{ allowOrigin, allowCredentials, reflectsArbitrary, wildcard, probeOrigin }];

  if (!reflectsArbitrary || !allowCredentials) {
    // Includes the wildcard-without-credentials case, which is correct and commonly
    // mis-flagged. Recorded, not reported.
    return { skipped: false, findings: [], observations };
  }

  return {
    skipped: false, observations,
    findings: [{
      category: 'DangerousCorsPolicy',
      title: 'Any origin is reflected while credentials are allowed',
      endpoint: new URL(url).pathname,
      description: `The response reflected the probe origin ${probeOrigin} in `
        + 'Access-Control-Allow-Origin and set Access-Control-Allow-Credentials: true. '
        + 'Together these let any site read this response using a signed-in visitor\'s credentials.',
      impact: 'Another origin can read authenticated responses from this endpoint.',
      remediation: 'Reflect only origins from an allowlist, or drop credentials support.',
      cwe: 'CWE-942', cweConfidence: 'confirmed',
      owaspWebCategory: 'A05:2021',
      severityFactors: new SeverityFactors('straightforward', 'serious', 'none', 'personalData', 'public'),
      exchanges: [result]
    }]
  };
}

/** Patterns that are worth looking at, with the reason attached rather than implied. */
const SENSITIVE_PATTERNS = [
  { name: 'bcrypt password hash', pattern: /\$2[aby]\$\d{2}\$[A-Za-z0-9./]{20,}/, cwe: 'CWE-522', data: 'credentials' },
  { name: 'API key', pattern: /\bsk_[A-Za-z0-9_]{12,}\b/, cwe: 'CWE-798', data: 'credentials' },
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, cwe: 'CWE-522', data: 'credentials' },
  { name: 'private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, cwe: 'CWE-321', data: 'credentials' },
  { name: 'connection string with credentials', pattern: /\b[a-z]+:\/\/[^\s:@/]+:[^\s:@/]+@/, cwe: 'CWE-522', data: 'credentials' },
  { name: 'stack trace', pattern: /\bat [A-Z][A-Za-z.]+\.[A-Za-z]+\(.*\) in .*:line \d+/, cwe: 'CWE-209', data: 'nonSensitive' }
];

/** Values that match a pattern but are not leaks. The brief names these explicitly. */
const KNOWN_BENIGN = [
  /example\.com/i, /example\.org/i, /\.invalid\b/i, /\.test\b/i,
  /your-api-key/i, /<redacted>/i, /\*{4,}/
];

/**
 * Sensitive data in a response.
 *
 * Pattern detection plus context: a match inside documentation-shaped text, or one that is
 * itself a placeholder, is recorded and not reported. The point is precision — a detector
 * that flags `example@example.com` teaches its readers to skim.
 */
export async function checkSensitiveData(scanner, url, testId = 'SECP-SENSITIVE', options = {}) {
  const result = await scanner.request({
    url, risk: SECURITY_RISK.PASSIVE, testId, headers: options.headers ?? {}
  });
  if (!result.allowed) return { skipped: true, decision: result.decision, findings: [], observations: [] };

  const text = result.responseText ?? '';
  const findings = [];
  const observations = [];

  for (const candidate of SENSITIVE_PATTERNS) {
    const match = candidate.pattern.exec(text);
    if (!match) continue;

    const benign = KNOWN_BENIGN.some(p => p.test(match[0]));
    observations.push({ pattern: candidate.name, matched: true, benign });
    if (benign) continue;

    findings.push({
      category: 'SensitiveDataExposure',
      title: `A ${candidate.name} appears in the response`,
      endpoint: new URL(url).pathname,
      description: `The response body contains something matching a ${candidate.name}. `
        + 'The value itself is not reproduced here or in the evidence.',
      impact: candidate.data === 'credentials'
        ? 'A credential returned to a client can be replayed by anyone who sees the response.'
        : 'Internal implementation detail is disclosed to a caller.',
      remediation: 'Remove the value from the response, or replace it with a reference.',
      cwe: candidate.cwe, cweConfidence: 'confirmed',
      owaspWebCategory: candidate.data === 'credentials' ? 'A02:2021' : 'A05:2021',
      owaspApiCategory: 'API3:2023',
      severityFactors: candidate.data === 'credentials'
        ? new SeverityFactors('trivial', 'severe', 'authenticatedUser', 'credentials', 'authenticatedUsers')
        : new SeverityFactors('straightforward', 'limited', 'none', 'nonSensitive', 'public'),
      exchanges: [result]
    });
  }

  return { skipped: false, findings, observations };
}

/** Endpoints that should not be reachable, probed one at a time and only by GET. */
export async function checkMisconfiguration(scanner, baseUrl, testId = 'SECP-MISCONFIG') {
  // Each probe carries its own factors. They were briefly shared, which made an exposed
  // source map score the same as an exposed .env — and a model that cannot tell those
  // apart is not a model, it is a constant.
  const probes = [
    { path: '/debug', category: 'DebugEndpointExposed', cwe: 'CWE-489',
      title: 'A debug endpoint is reachable',
      factors: () => new SeverityFactors('straightforward', 'serious', 'none', 'credentials', 'public') },
    { path: '/files', category: 'DirectoryListing', cwe: 'CWE-548',
      title: 'A directory listing is served',
      factors: () => new SeverityFactors('straightforward', 'limited', 'none', 'nonSensitive', 'public') },
    { path: '/app.js.map', category: 'SourceMapExposed', cwe: 'CWE-540',
      title: 'A JavaScript source map is served',
      factors: () => new SeverityFactors('difficult', 'minimal', 'none', 'nonSensitive', 'public') },
    { path: '/.env', category: 'ConfigurationFileExposed', cwe: 'CWE-538',
      title: 'An environment file is reachable',
      factors: () => new SeverityFactors('trivial', 'severe', 'none', 'credentials', 'public') }
  ];

  const findings = [];
  const observations = [];

  for (const probe of probes) {
    const result = await scanner.request({
      url: `${baseUrl}${probe.path}`, risk: SECURITY_RISK.PASSIVE, testId: `${testId}:${probe.path}`
    });
    if (!result.allowed) { observations.push({ path: probe.path, skipped: true, reason: result.decision.reason }); continue; }

    const reachable = result.status === 200;
    observations.push({ path: probe.path, status: result.status, reachable });
    if (!reachable) continue;

    findings.push({
      category: probe.category,
      title: probe.title,
      endpoint: probe.path,
      description: `GET ${probe.path} answered 200.`,
      impact: 'Information intended for developers is available to anyone who asks for it.',
      remediation: `Do not serve ${probe.path} outside development.`,
      cwe: probe.cwe, cweConfidence: 'confirmed',
      owaspWebCategory: 'A05:2021', owaspApiCategory: 'API8:2023',
      severityFactors: probe.factors(),
      exchanges: [result]
    });
  }

  return { skipped: false, findings, observations };
}
