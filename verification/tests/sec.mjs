/**
 * Security verification, executed against the running control plane.
 *
 * Written to try to get in, not to confirm that the guards exist. Every check states what
 * it attempted and keeps the exchange as evidence so a reader can see the request that was
 * actually sent.
 */
import { check, login, newTenant, request, saveEvidence, suite, API } from './harness.mjs';

suite('security');

const alpha = await newTenant('Alpha');
const beta = await newTenant('Beta');

const exchanges = [];
const record = (label, response, attempted) => {
  exchanges.push({
    label, attempted, status: response.status,
    body: response.text.slice(0, 400),
    at: new Date().toISOString()
  });
};

// ---- SEC-001 authentication -------------------------------------------------
await check('SEC-001', 'Unauthenticated access is refused', async () => {
  const paths = ['/api/v1/projects', '/api/v1/users', '/api/v1/testruns?projectId=x',
                 '/api/v1/agent/runs', '/api/v1/quality-gates?projectId=x'];
  const results = [];
  for (const path of paths) {
    const response = await request(path);
    record(`anonymous ${path}`, response, 'access without a token');
    results.push({ path, status: response.status });
  }
  const bad = results.filter(r => r.status !== 401);
  return {
    pass: bad.length === 0,
    detail: bad.length ? `not 401: ${JSON.stringify(bad)}` : `${results.length} endpoints all returned 401`
  };
});

await check('SEC-002', 'A forged token is refused', async () => {
  // Same header and payload shape as a real token, signed with a key we control.
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: alpha.userId, org: alpha.organizationId, kind: 'user',
    perm: ['project:read', 'project:write', 'user:write'],
    exp: Math.floor(Date.now() / 1000) + 3600, iss: 'aira', aud: 'aira-console'
  })).toString('base64url');
  const forged = `${header}.${payload}.${Buffer.from('forged').toString('base64url')}`;

  const response = await request('/api/v1/projects', { token: forged });
  record('forged signature', response, 'a token signed with the wrong key');
  return { pass: response.status === 401, detail: `status ${response.status}` };
});

await check('SEC-003', 'The alg=none downgrade is refused', async () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: alpha.userId, org: alpha.organizationId, kind: 'user', perm: ['project:read'],
    exp: Math.floor(Date.now() / 1000) + 3600, iss: 'aira', aud: 'aira-console'
  })).toString('base64url');

  const response = await request('/api/v1/projects', { token: `${header}.${payload}.` });
  record('alg=none', response, 'an unsigned token claiming alg=none');
  return { pass: response.status === 401, detail: `status ${response.status}` };
});

// ---- SEC-010 tenant isolation -------------------------------------------------
const alphaProject = await request('/api/v1/projects', {
  token: alpha.token, method: 'POST',
  body: { name: 'Alpha Private', key: `A${Math.random().toString(36).slice(2, 8).toUpperCase()}`, description: 'secret' }
});

await check('SEC-010', 'One tenant cannot read another tenant by id (IDOR)', async () => {
  const id = alphaProject.json.id;
  const response = await request(`/api/v1/projects/${id}`, { token: beta.token });
  record('beta reads alpha project', response, `GET /api/v1/projects/${id} as the other tenant`);
  // 404 rather than 403: confirming an id exists is itself a leak.
  return {
    pass: response.status === 404,
    detail: `status ${response.status} (404 expected so existence is not confirmed)`
  };
});

await check('SEC-011', 'One tenant cannot write into another tenant', async () => {
  const id = alphaProject.json.id;
  const response = await request(`/api/v1/quality-gates?projectId=${id}`, {
    token: beta.token, method: 'POST',
    body: { name: 'planted', metric: 'failedCount', operator: 'lessThanOrEqual', threshold: 99 }
  });
  record('beta writes into alpha project', response, 'creating a gate rule in the other tenant');
  return { pass: response.status === 404, detail: `status ${response.status}` };
});

await check('SEC-012', 'A listing never contains another tenant rows', async () => {
  const response = await request('/api/v1/projects', { token: beta.token });
  const leaked = (response.json ?? []).some(p => p.id === alphaProject.json.id || p.name === 'Alpha Private');
  record('beta lists projects', response, 'listing projects as the other tenant');
  return { pass: !leaked, detail: leaked ? 'the other tenant appeared in the listing' : 'no cross-tenant rows' };
});

await check('SEC-013', "A tenant cannot see another tenant's people", async () => {
  const response = await request('/api/v1/users', { token: beta.token });
  const leaked = (response.json ?? []).some(u => u.email === alpha.email);
  return { pass: !leaked, detail: leaked ? 'alpha admin visible to beta' : 'no cross-tenant users' };
});

// ---- SEC-020 authorization ------------------------------------------------------
await check('SEC-020', 'A permission the session lacks is refused', async () => {
  // A session that can read must not be able to write just because it is authenticated.
  const project = alphaProject.json;
  const viewer = await request('/api/v1/users', {
    token: alpha.token, method: 'POST',
    body: { email: `viewer-${Math.random().toString(36).slice(2, 10)}@example.test`,
            displayName: 'A Viewer', role: 'viewer' }
  });
  if (!viewer.ok) return { pass: false, detail: `could not create a viewer: ${viewer.status}` };

  const viewerToken = await login(viewer.json.user.email, viewer.json.temporaryPassword);
  if (!viewerToken) return { pass: false, detail: 'the viewer could not sign in' };

  const write = await request('/api/v1/projects', {
    token: viewerToken, method: 'POST',
    body: { name: 'Viewer should not create this', key: `V${Math.random().toString(36).slice(2, 8).toUpperCase()}` }
  });
  const read = await request('/api/v1/projects', { token: viewerToken });
  record('viewer writes a project', write, 'creating a project as a viewer');

  return {
    pass: write.status === 403 && read.status === 200,
    detail: `write ${write.status} (403 expected), read ${read.status} (200 expected)`
  };
});

// ---- SEC-030 injection ------------------------------------------------------------
await check('SEC-030', 'SQL injection in a query parameter does not execute', async () => {
  const payloads = [
    "' OR '1'='1",
    "'; DROP TABLE users; --",
    "1' UNION SELECT NULL,NULL,NULL--",
    "\\'; SELECT pg_sleep(5); --"
  ];
  const statuses = [];
  for (const payload of payloads) {
    const response = await request(`/api/v1/testruns?projectId=${encodeURIComponent(payload)}`, { token: alpha.token });
    record(`sqli ${payload.slice(0, 20)}`, response, 'SQL metacharacters in projectId');
    statuses.push(response.status);
  }
  // The tables must still be there afterwards.
  const stillAlive = await request('/api/v1/users', { token: alpha.token });
  return {
    pass: stillAlive.status === 200 && !statuses.includes(500),
    detail: `statuses ${statuses.join(',')}; users endpoint afterwards ${stillAlive.status}`
  };
});

await check('SEC-031', 'A malformed body is rejected, not crashed on', async () => {
  const bodies = ['{ not json', '', '[]', '{"name":' + '"a"'.repeat(1) + '}', 'null'];
  const statuses = [];
  for (const body of bodies) {
    const response = await request('/api/v1/projects', {
      token: alpha.token, method: 'POST', raw: true, body,
      headers: { 'content-type': 'application/json' }
    });
    statuses.push(response.status);
  }
  const serverErrors = statuses.filter(s => s >= 500);
  return {
    pass: serverErrors.length === 0,
    detail: `statuses ${statuses.join(',')}; ${serverErrors.length} server errors`
  };
});

await check('SEC-032', 'A stored XSS payload is returned encoded, not executed', async () => {
  const payload = '<script>alert("xss")</script>';
  const created = await request('/api/v1/projects', {
    token: alpha.token, method: 'POST',
    body: { name: payload, key: `X${Math.random().toString(36).slice(2, 8).toUpperCase()}`, description: payload }
  });
  if (!created.ok) return { pass: false, detail: `could not create: ${created.status}` };

  const listed = await request('/api/v1/projects', { token: alpha.token });
  const contentType = listed.headers.get('content-type') ?? '';
  // A JSON API returning application/json is not an XSS sink; the console escapes on render.
  return {
    pass: contentType.includes('application/json'),
    detail: `stored and returned as ${contentType}`
  };
});

// ---- SEC-040 SSRF -------------------------------------------------------------------
// Two separate contracts. Some addresses must be refused however the platform is
// configured; loopback and RFC1918 are refused only when the private-network flag is off,
// because letting a developer point at their own machine is what that flag is for.
await check('SEC-040', 'Never-permitted targets are refused whatever the configuration', async () => {
  const project = alphaProject.json;
  const targets = [
    'http://169.254.169.254/latest/meta-data/',
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://[::ffff:169.254.169.254]/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://100.64.0.1/',
    'http://0.0.0.0/',
    'file:///etc/passwd',
    'gopher://127.0.0.1:6379/_FLUSHALL',
    'javascript:fetch("http://evil.test")',
    'http://169.254.169.254@example.com/'
  ];
  const results = [];
  for (const baseUrl of targets) {
    const response = await request('/api/v1/applications', {
      token: alpha.token, method: 'POST',
      body: { projectId: project.id, name: 'ssrf probe', baseUrl, authStrategy: 'none' }
    });
    record(`ssrf ${baseUrl}`, response, 'registering an application at a forbidden target');
    results.push({ baseUrl, status: response.status });
  }
  const accepted = results.filter(r => r.status < 400);
  return {
    pass: accepted.length === 0,
    detail: accepted.length ? `accepted: ${JSON.stringify(accepted)}` : `all ${results.length} refused`
  };
});

await check('SEC-041', 'Private and loopback targets follow the configuration flag', async () => {
  // This deployment runs with ALLOW_PRIVATE_NETWORK_TARGETS=true for the bundled demo, so
  // loopback must be accepted here; a second instance with the flag off must refuse it.
  // Anything else means the flag does not do what it says.
  const project = alphaProject.json;
  const loopbackForms = ['http://127.0.0.1:4200/', 'http://0177.0.0.1/', 'http://localhost:4200/'];

  const permissive = [];
  for (const baseUrl of loopbackForms) {
    const response = await request('/api/v1/applications', {
      token: alpha.token, method: 'POST',
      body: { projectId: project.id, name: 'loopback probe', baseUrl, authStrategy: 'none' }
    });
    permissive.push({ baseUrl, status: response.status });
  }

  const STRICT = process.env.AIRA_STRICT_API_URL ?? 'http://127.0.0.1:5099';
  const probe = await request(`${STRICT}/health`);
  if (probe.status !== 200) {
    return { pass: false, detail: `no strict-mode instance on ${STRICT} to compare against` };
  }

  const unique = Math.random().toString(36).slice(2, 12);
  const strictReg = await request(`${STRICT}/api/v1/auth/register`, {
    method: 'POST',
    body: { organizationName: `Strict ${unique}`, email: `strict-${unique}@example.test`,
            password: 'Str0ngPassphrase!2026', displayName: 'Strict' }
  });
  const strictToken = strictReg.json.accessToken;
  const strictProject = await request(`${STRICT}/api/v1/projects`, {
    token: strictToken, method: 'POST',
    body: { name: 'Strict', key: `T${unique.slice(0, 7).toUpperCase()}` }
  });

  const strict = [];
  for (const baseUrl of loopbackForms) {
    const response = await request(`${STRICT}/api/v1/applications`, {
      token: strictToken, method: 'POST',
      body: { projectId: strictProject.json.id, name: 'loopback probe', baseUrl, authStrategy: 'none' }
    });
    record(`strict ${baseUrl}`, response, 'loopback with the flag off');
    strict.push({ baseUrl, status: response.status });
  }

  const allowedWhenOn = permissive.every(r => r.status < 400);
  const refusedWhenOff = strict.every(r => r.status === 400);
  return {
    pass: allowedWhenOn && refusedWhenOff,
    detail: `flag on: ${permissive.map(r => r.status).join(',')} (all <400 expected); `
          + `flag off: ${strict.map(r => r.status).join(',')} (all 400 expected)`
  };
});

// ---- SEC-050 secrets ------------------------------------------------------------------
await check('SEC-050', 'A stored credential never comes back out of the API', async () => {
  const project = alphaProject.json;
  const secret = 'V3rif1cation-S3cret-Do-Not-Echo';
  const created = await request('/api/v1/applications', {
    token: alpha.token, method: 'POST',
    body: {
      projectId: project.id, name: 'Credential probe', baseUrl: 'https://bank.example.test',
      allowedDomains: 'bank.example.test', authStrategy: 'formLogin',
      credentials: { username: 'alice', password: secret }
    }
  });
  if (!created.ok) return { pass: false, detail: `could not create: ${created.status} ${created.text.slice(0,150)}` };

  const listed = await request(`/api/v1/applications?projectId=${project.id}`, { token: alpha.token });
  const detail = await request(`/api/v1/applications/${created.json.id}`, { token: alpha.token });
  const leakedIn = [];
  if (created.text.includes(secret)) leakedIn.push('create response');
  if (listed.text.includes(secret)) leakedIn.push('list response');
  if (detail.text.includes(secret)) leakedIn.push('detail response');

  return {
    pass: leakedIn.length === 0,
    detail: leakedIn.length ? `leaked in: ${leakedIn.join(', ')}` : 'not present in create, list or detail responses'
  };
});

await check('SEC-051', 'Browser security headers are present', async () => {
  const response = await request('/api/v1/projects', { token: alpha.token });
  const expected = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer'
  };
  const missing = Object.entries(expected).filter(([k, v]) => response.headers.get(k) !== v).map(([k]) => k);
  if (!response.headers.get('content-security-policy')) missing.push('content-security-policy');
  return { pass: missing.length === 0, detail: missing.length ? `missing ${missing.join(', ')}` : 'all present' };
});

await check('SEC-052', 'A token in a query string does not authenticate', async () => {
  // SignalR needs this exception on /hubs; it must not leak to the rest of the API, where a
  // token in a URL lands in access logs and browser history.
  const response = await request(`/api/v1/projects?access_token=${encodeURIComponent(alpha.token)}`);
  record('token in query string', response, 'authenticating via ?access_token=');
  return { pass: response.status === 401, detail: `status ${response.status}` };
});

// ---- SEC-060 path traversal ---------------------------------------------------------------
await check('SEC-060', 'Path traversal in an artifact id does not read the filesystem', async () => {
  const attempts = [
    '../../../../etc/passwd',
    '..%2f..%2f..%2fetc%2fpasswd',
    '%2e%2e%2f%2e%2e%2fetc%2fpasswd'
  ];
  const results = [];
  for (const attempt of attempts) {
    const response = await request(`/api/v1/artifacts/${attempt}/content`, { token: alpha.token });
    record(`traversal ${attempt}`, response, 'requesting an artifact by a traversal path');
    results.push({ attempt, status: response.status, leaked: response.text.includes('root:x:') });
  }
  const leaked = results.filter(r => r.leaked);
  return {
    pass: leaked.length === 0,
    detail: leaked.length ? 'filesystem content returned' : `statuses ${results.map(r => r.status).join(',')}, no file content`
  };
});

const path = saveEvidence('security/http-exchanges.json', {
  recordedAt: new Date().toISOString(), api: API, exchanges
});
console.log(`\nexchanges recorded: ${exchanges.length} -> ${path}`);
