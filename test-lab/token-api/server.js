/**
 * A second target that does everything differently from Meridian Freight.
 *
 * Meridian Freight is a server-rendered, cookie-session, form-login application with an
 * anti-forgery hidden field, and it redirects to the sign-in page when you are not signed
 * in. Every assumption the scanner turned out to be carrying was fitted to that shape, and
 * a single target cannot show you which of your beliefs are about the world and which are
 * about your one example.
 *
 * So this one is the other common shape, and deliberately so at every point:
 *
 *   sign-in       POST /api/auth/token with JSON, answering a bearer token, not a cookie
 *   refusal       403 with a JSON body, not a 302 to a login page
 *   anti-forgery  an X-CSRF-Token header, not a hidden field
 *   content       JSON from an API, with one HTML page that reads a query parameter
 *
 * Four defects are planted, written down here rather than inferred later:
 *
 *   TA_D01  /api/orders/:id serves any order to any signed-in caller (object-level authz)
 *   TA_D02  /search reflects its q parameter into HTML unescaped
 *   TA_D03  no throttling: failed sign-ins are never slowed or blocked
 *   TA_D04  /api/orders/:id returns a stack trace when the id does not parse
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 4500);

const USERS = new Map([
  ['alice', { password: 'Token!2026', role: 'owner', customer: 'cust-a' }],
  ['bob', { password: 'Token!2026', role: 'owner', customer: 'cust-b' }],
  ['auditor', { password: 'Token!2026', role: 'readonly', customer: 'cust-a' }]
]);

const ORDERS = new Map([
  ['ord-1', { id: 'ord-1', customer: 'cust-a', total: 420.5, reference: 'TA-0001' }],
  ['ord-2', { id: 'ord-2', customer: 'cust-b', total: 980.0, reference: 'TA-0002' }]
]);

/** token -> username. A bearer token, deliberately not a cookie. */
const TOKENS = new Map();

const json = (response, status, body, extra = {}) => {
  response.writeHead(status, { 'content-type': 'application/json', ...extra });
  response.end(JSON.stringify(body));
};

const html = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  response.end(body);
};

const bearerUser = (request) => {
  const header = request.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const username = TOKENS.get(match[1].trim());
  return username ? { username, ...USERS.get(username) } : null;
};

const readBody = (request) => new Promise(resolve => {
  let raw = '';
  request.on('data', chunk => { raw += chunk; });
  request.on('end', () => {
    try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
  });
});

const server = createServer(async (request, response) => {
  // A request line the URL parser will not take is answered, not thrown on. "//" is a
  // protocol-relative URL with no host, and new URL("//", base) raises ERR_INVALID_URL —
  // which, uncaught in a request handler, stops the process. A scan sent one, this server
  // died, and the twenty-three tests that followed failed with ECONNREFUSED against a
  // target that was no longer there. A real server answers 400.
  let url;
  try {
    url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  } catch {
    return json(response, 400, { error: 'bad_request', detail: 'The request path could not be parsed.' });
  }
  const path = url.pathname;

  // ---- sign-in: JSON in, bearer token out -------------------------------
  if (path === '/api/auth/token' && request.method === 'POST') {
    const body = await readBody(request);
    const user = USERS.get(String(body.username ?? ''));
    // TA_D03: every failure is answered identically and immediately, for ever.
    if (!user || user.password !== body.password) {
      return json(response, 401, { error: 'invalid_credentials' });
    }
    const token = randomUUID();
    TOKENS.set(token, String(body.username));
    return json(response, 200, { token, tokenType: 'Bearer', role: user.role });
  }

  if (path === '/api/auth/token' && request.method === 'DELETE') {
    const header = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '');
    if (header) TOKENS.delete(header[1].trim());
    return json(response, 204, {});
  }

  // ---- the one HTML page, which reads a query parameter -----------------
  if (path === '/search') {
    const caller = bearerUser(request);
    if (!caller) return json(response, 403, { error: 'forbidden' });
    const q = url.searchParams.get('q') ?? '';
    // TA_D02: written straight into the document.
    return html(response, 200, `<!doctype html><html><head><title>Search</title></head>
      <body><h1>Results</h1><p class="empty">Nothing matched ${q}</p></body></html>`);
  }

  // ---- the API ----------------------------------------------------------
  if (path === '/api/orders' && request.method === 'GET') {
    const caller = bearerUser(request);
    if (!caller) return json(response, 403, { error: 'forbidden' });
    return json(response, 200,
      [...ORDERS.values()].filter(o => o.customer === caller.customer));
  }

  const order = /^\/api\/orders\/([^/]+)$/.exec(path);
  if (order && request.method === 'GET') {
    const caller = bearerUser(request);
    if (!caller) return json(response, 403, { error: 'forbidden' });
    const found = ORDERS.get(order[1]);
    if (!found) {
      // TA_D04: the failure path leaks a stack trace and absolute paths.
      const error = new Error(`Cannot read properties of undefined (reading 'total')`);
      return json(response, 500, { error: error.message, stack: error.stack });
    }
    // TA_D01: no check that the order belongs to the caller's customer.
    return json(response, 200, found);
  }

  if (order && request.method === 'DELETE') {
    const caller = bearerUser(request);
    if (!caller) return json(response, 403, { error: 'forbidden' });
    // A state change that a read-only identity should not be allowed, and is not.
    if (caller.role === 'readonly') return json(response, 403, { error: 'forbidden' });
    ORDERS.delete(order[1]);
    return json(response, 204, {});
  }

  if (path === '/' ) {
    return html(response, 200, `<!doctype html><html><head><title>Token API</title></head>
      <body><h1>Token API</h1><ul>
      <li><a href="/search?q=example">Search</a></li>
      <li><a href="/api/orders">Orders</a></li>
      </ul></body></html>`);
  }

  return json(response, 404, { error: 'not_found' });
});

server.listen(PORT, '127.0.0.1', () =>
  console.log(`token-api listening on http://127.0.0.1:${PORT}`));
