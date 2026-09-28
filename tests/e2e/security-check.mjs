/**
 * Checks the security properties that only exist on a real stack, with real settings.
 *
 * The integration suite deliberately raises the credential rate limit so that a suite of
 * fast requests does not throttle itself — which means the limiter's real behaviour has to
 * be proved somewhere else, against a deployment configured the way a deployment actually
 * is. Same for the headers Kestrel emits and the token handling on the live-execution hub.
 *
 * The rate-limit probe deliberately spends the sign-in budget for the current window, so it
 * runs last and the script waits for the window to clear before it starts.
 */
const api = (process.env.QANXT_API_URL ?? 'http://127.0.0.1:5080').replace(/\/+$/, '');
const org = process.env.QANXT_ORG ?? 'northwind-bank';
const email = process.env.QANXT_EMAIL ?? 'qa.lead@northwind.test';
const password = process.env.QANXT_PASSWORD ?? 'Str0ngPassphrase!2026';

const fail = (message) => { console.log(`FAIL  ${message}`); process.exitCode = 1; };
const pass = (message) => console.log(`PASS  ${message}`);
const die = (message) => { fail(message); process.exit(1); };

const login = () => fetch(`${api}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ organizationSlug: org, email, password })
});

// A previous run, or a previous probe, may still be inside the same rate-limit window.
let auth = await login();
for (let waited = 0; auth.status === 429 && waited < 75; waited += 5) {
  if (waited === 0) console.log('      waiting for the sign-in rate-limit window to clear…');
  await new Promise(resolve => setTimeout(resolve, 5000));
  auth = await login();
}
if (!auth.ok) die(`could not sign in to ${api} (${auth.status})`);
const token = (await auth.json()).accessToken;
pass('signed in to the running platform');

// ---- The session actually resolves to a user -------------------------------
// This was broken once: inbound claim mapping rewrote "sub", so every request had a valid
// token and no user behind it. It cost nothing visible until audit entries turned out to
// record nobody, so it is checked on the real stack as well as in the integration suite.
const me = await fetch(`${api}/api/v1/auth/me`, { headers: { authorization: `Bearer ${token}` } });
if (!me.ok) {
  fail(`/auth/me returned ${me.status} for a valid token`);
} else {
  const body = await me.json();
  if (!body.userId || !body.email) fail(`/auth/me resolved no user: ${JSON.stringify(body)}`);
  else pass(`the session resolves to a real user (${body.email})`);
}

// ---- Headers a browser relies on -------------------------------------------
const headers = await fetch(`${api}/api/v1/projects`, { headers: { authorization: `Bearer ${token}` } });
const expected = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer'
};
const missing = Object.entries(expected)
  .filter(([name, value]) => headers.headers.get(name) !== value)
  .map(([name]) => name);
if (missing.length > 0) fail(`missing or wrong security headers: ${missing.join(', ')}`);
else pass('responses carry the browser security headers');

if (!headers.headers.get('content-security-policy')) fail('no content security policy is set');
else pass('a content security policy is set');

// ---- A token in a query string is not a session -----------------------------
// SignalR cannot set a header on its handshake, so the hub accepts ?access_token=. That
// exception must not leak to the rest of the API, where a token in a URL would end up in
// access logs, proxy logs and browser history.
const viaQuery = await fetch(`${api}/api/v1/projects?access_token=${encodeURIComponent(token)}`);
if (viaQuery.status !== 401) {
  fail(`a token in the query string authenticated a normal endpoint (${viaQuery.status})`);
} else pass('a token in a query string does not authenticate a normal endpoint');

// ---- Evidence is not public -------------------------------------------------
// A real artifact id is used, so a pass means the request was refused rather than merely
// not matching anything. The listing needs a session too, so the id comes from one.
const runs = await (await fetch(`${api}/api/v1/testruns?limit=1`, {
  headers: { authorization: `Bearer ${token}` }
})).json();

let artifactId;
if (runs.length > 0) {
  const executions = await (await fetch(`${api}/api/v1/testruns/${runs[0].id}/executions`, {
    headers: { authorization: `Bearer ${token}` }
  })).json();
  if (executions.length > 0) {
    const listed = await (await fetch(`${api}/api/v1/artifacts?executionId=${executions[0].id}`, {
      headers: { authorization: `Bearer ${token}` }
    })).json();
    artifactId = listed[0]?.id;
  }
}

if (!artifactId) {
  console.log('      no stored artifact to probe; run a test first for this check to mean anything');
} else {
  const anonymousList = await fetch(`${api}/api/v1/artifacts?executionId=${Math.random()}`);
  if (anonymousList.status !== 401) fail(`the artifact listing is open (${anonymousList.status})`);
  else pass('listing evidence requires a session');

  const anonymousContent = await fetch(`${api}/api/v1/artifacts/${artifactId}/content`);
  if (anonymousContent.status !== 401) {
    fail(`a stored artifact was served without a session (${anonymousContent.status})`);
  } else pass('downloading evidence requires a session');

  const authorized = await fetch(`${api}/api/v1/artifacts/${artifactId}/content`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!authorized.ok) fail(`an authorized download failed (${authorized.status})`);
  else pass('the same download succeeds with a session');
}

// ---- Credential rate limiting ------------------------------------------------
// Last: this spends the sign-in budget for the current window.
const attempts = [];
for (let index = 0; index < 15; index++) {
  const response = await fetch(`${api}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ organizationSlug: org, email: 'nobody@example.test', password: 'wrong' })
  });
  attempts.push(response.status);
}

const throttled = attempts.filter(status => status === 429).length;
const rejected = attempts.filter(status => status === 401).length;

if (throttled === 0) {
  fail(`15 rapid sign-in attempts were all allowed (${attempts.join(',')}) — brute force is not limited`);
} else {
  pass(`sign-in is rate limited: ${rejected} refused, then ${throttled} throttled`);
}

// A limiter that also blocks the first attempt would lock everyone out.
if (attempts[0] === 429) fail('the very first sign-in attempt was throttled');
else pass('the limit applies to a burst, not to the first attempt');

console.log(process.exitCode
  ? '\nThe deployment does not hold its security properties.'
  : '\nThe running deployment holds its security properties.');
