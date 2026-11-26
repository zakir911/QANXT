import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecurityScanner } from '../src/engine.mjs';

/**
 * The anti-forgery token a scan holds after signing in.
 *
 * It was read from one place: a JSON field called `csrfToken`. Every application that serves
 * its token as a hidden input — which is every server-rendered application there is — gave
 * the scan a session with no token at all.
 *
 * That was invisible until the anti-forgery check could actually issue a request the endpoint
 * would accept. Then it mattered twice over: the control request is the application's own
 * request, token included, so with no token it is refused; and on an application that answers
 * a refusal by redirecting to the record rather than re-showing the form, it is refused
 * *invisibly*. Both arms are refused identically, and the check reports a missing
 * anti-forgery token on an endpoint that validates its token properly. Ten findings on
 * freight in one run, every one of them against a well-behaved endpoint.
 *
 * It also has to be read *after* signing in. The token on the sign-in page belongs to the
 * session the caller had before it signed in, and freight derives its token from the session
 * cookie — so the pre-login value is syntactically a token and wrong, which is worse than
 * none.
 */
function scannerThat(handler) {
  const scanner = new SecurityScanner({
    profile: 'standard',
    scope: {
      enabled: true, allowedDomains: ['host'], allowedApiDomains: ['host'],
      allowActiveTesting: true, allowDestructiveTesting: false,
      authorizationNote: 'A stub, for a unit test. No request leaves this process.'
    }
  });
  const sent = [];
  scanner.request = async (options) => {
    sent.push(options);
    return { allowed: true, ...handler(options) };
  };
  return { scanner, sent };
}

const headers = (map = {}) => ({
  get: (name) => map[name.toLowerCase()] ?? null,
  getSetCookie: () => (map['set-cookie'] ? [map['set-cookie']] : [])
});

const SIGN_IN_PAGE = `<!doctype html><form method="post" action="/auth/sign-in">
  <input type="hidden" name="_csrf" value="csrf-before-login" data-testid="csrf" />
  <label for="u">Username</label><input id="u" name="username" />
  <label for="p">Password</label><input id="p" type="password" name="password" />
  <button type="submit">Sign in</button></form>`;

/** The dashboard a successful sign-in redirects to, carrying this session's token. */
const DASHBOARD = `<!doctype html><h1>Dashboard</h1>
  <form method="post" action="/search">
  <input type="hidden" name="_csrf" value="csrf-after-login" /></form>`;

/** A server-rendered application in freight's shape. */
const serverRendered = (landing = DASHBOARD) => (options) => {
  if (options.method === 'POST' && options.url.endsWith('/auth/sign-in')) {
    return {
      status: 302, responseBody: '', responseText: '',
      headers: headers({ location: '/dashboard', 'set-cookie': 'lab_session=s1; Path=/' }),
      responseHeaders: { location: '/dashboard', 'set-cookie': 'lab_session=s1; Path=/' }
    };
  }
  if (options.method === 'POST') return { status: 404, headers: headers({}), responseHeaders: {} };
  if (options.url.endsWith('/dashboard') || options.url.endsWith('/')) {
    return { status: 200, responseBody: landing, responseText: landing,
             headers: headers({}), responseHeaders: {} };
  }
  if (options.url.includes('/auth/sign-in')) {
    return { status: 200, responseBody: SIGN_IN_PAGE, responseText: SIGN_IN_PAGE,
             headers: headers({}), responseHeaders: {} };
  }
  return { status: 404, headers: headers({}), responseHeaders: {} };
};

test('the token is read out of a hidden input, not only out of a JSON field', async () => {
  const { scanner } = scannerThat(serverRendered());

  const session = await scanner.signIn('http://host', 'ops.lead', 'pw');

  assert.ok(session, 'signed in');
  assert.equal(session.csrf, 'csrf-after-login');
});

test('and from the session it holds now, not the one it had on the sign-in page', async () => {
  const { scanner } = scannerThat(serverRendered());

  const session = await scanner.signIn('http://host', 'ops.lead', 'pw');

  // An application that derives its token from the session cookie issues a different one once
  // the session changes. The pre-login value is a token-shaped wrong answer.
  assert.notEqual(session.csrf, 'csrf-before-login');
});

test('the page the redirect led to is where it looks first', async () => {
  const { scanner, sent } = scannerThat(serverRendered());

  await scanner.signIn('http://host', 'ops.lead', 'pw');

  const afterSignIn = sent.filter(o => o.method === 'GET' && o.url.endsWith('/dashboard'));
  assert.equal(afterSignIn.length, 1);
  assert.match(afterSignIn[0].note ?? '', /anti-forgery token this session holds/);
});

test('the root is tried when the landing page carries no token', async () => {
  const noToken = '<!doctype html><h1>Dashboard</h1>';
  const withToken = '<input type="hidden" name="authenticity_token" value="rails-token">';
  const { scanner } = scannerThat((options) => {
    if (options.method === 'GET' && options.url.endsWith('/dashboard')) {
      return { status: 200, responseBody: noToken, responseText: noToken,
               headers: headers({}), responseHeaders: {} };
    }
    if (options.method === 'GET' && options.url === 'http://host/') {
      return { status: 200, responseBody: withToken, responseText: withToken,
               headers: headers({}), responseHeaders: {} };
    }
    return serverRendered()(options);
  });

  const session = await scanner.signIn('http://host', 'ops.lead', 'pw');

  assert.equal(session.csrf, 'rails-token');
});

test('an application with no token anywhere yields null rather than something invented', async () => {
  const bare = '<!doctype html><h1>Dashboard</h1>';
  const { scanner } = scannerThat(serverRendered(bare));

  const session = await scanner.signIn('http://host', 'ops.lead', 'pw');

  assert.ok(session, 'signed in');
  assert.equal(session.csrf, null);
});

test('the spellings frameworks actually use are all read', async () => {
  for (const [name, value] of [
    ['_csrf', 'a'], ['csrf_token', 'b'], ['authenticity_token', 'c'],
    ['__RequestVerificationToken', 'd'], ['_token', 'e'], ['xsrf-token', 'f']
  ]) {
    const landing = `<input type="hidden" name="${name}" value="${value}">`;
    const { scanner } = scannerThat(serverRendered(landing));
    const session = await scanner.signIn('http://host', 'ops.lead', 'pw');
    assert.equal(session.csrf, value, name);
  }
});

test('attribute order does not decide whether the token is found', async () => {
  const landing = '<input value="reversed-order" name="_csrf" type="hidden">';
  const { scanner } = scannerThat(serverRendered(landing));

  const session = await scanner.signIn('http://host', 'ops.lead', 'pw');

  assert.equal(session.csrf, 'reversed-order');
});

test('a token published as a meta tag is read, which is how a SPA is handed one', async () => {
  const landing = '<meta name="csrf-token" content="meta-token"><div id="app"></div>';
  const { scanner } = scannerThat(serverRendered(landing));

  const session = await scanner.signIn('http://host', 'ops.lead', 'pw');

  assert.equal(session.csrf, 'meta-token');
});

test('an empty value is not a token', async () => {
  const landing = '<input type="hidden" name="_csrf" value="">'
    + '<input type="hidden" name="authenticity_token" value="the-real-one">';
  const { scanner } = scannerThat(serverRendered(landing));

  const session = await scanner.signIn('http://host', 'ops.lead', 'pw');

  assert.equal(session.csrf, 'the-real-one');
});

test('a JSON sign-in still has its token read, as it always did', async () => {
  const { scanner } = scannerThat((options) => {
    if (options.method === 'POST' && options.url.endsWith('/api/session')) {
      return { status: 200, responseBody: { ok: true, csrfToken: 'json-token' },
               headers: headers({ 'set-cookie': 'sid=1' }),
               responseHeaders: { 'set-cookie': 'sid=1' } };
    }
    if (options.method === 'POST') return { status: 404, headers: headers({}), responseHeaders: {} };
    const empty = '<div id="app"></div>';
    return { status: 200, responseBody: empty, responseText: empty,
             headers: headers({}), responseHeaders: {} };
  });

  const session = await scanner.signIn('http://host', 'user', 'pw');

  assert.equal(session.csrf, 'json-token');
});
