/**
 * Checks the security lab against its own ground truth.
 *
 * Two questions, and the second is the one that matters:
 *
 *   1. Is every vulnerability the ground truth names actually present?
 *   2. Is every endpoint it calls safe actually safe?
 *
 * If the lab and its ground truth disagree, every number AIRA produces against it is
 * measured with a broken ruler — a "missed detection" might be a vulnerability that was
 * never there, and a "false positive" might be a real flaw nobody wrote down. This runs
 * before the security suites for the same reason the functional lab's audit does.
 *
 * It exercises each flaw directly over HTTP. It does not ask AIRA anything.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const truth = JSON.parse(readFileSync(resolve(HERE, 'ground-truth.json'), 'utf8'));

const green = t => `\u001b[32m${t}\u001b[0m`;
const red = t => `\u001b[31m${t}\u001b[0m`;
const dim = t => `\u001b[2m${t}\u001b[0m`;

let checked = 0, failed = 0;

const report = (ok, id, detail) => {
  checked++;
  if (ok) console.log(`  ${green('present')}  ${id.padEnd(32)} ${dim(detail)}`);
  else { failed++; console.log(`  ${red('ABSENT ')}  ${id.padEnd(32)} ${red(detail)}`); }
};

const reportSafe = (ok, endpoint, detail) => {
  checked++;
  if (ok) console.log(`  ${green('safe   ')}  ${endpoint.padEnd(32)} ${dim(detail)}`);
  else { failed++; console.log(`  ${red('UNSAFE ')}  ${endpoint.padEnd(32)} ${red(detail)}`); }
};

const json = async (url, options = {}) => {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* html or text */ }
  return { status: response.status, headers: response.headers, text, json: body };
};

const signIn = async (base, username = 'alice') => {
  const response = await fetch(`${base}/api/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'lab-password' })
  });
  const cookie = (response.headers.getSetCookie?.() ?? [])[0]?.split(';')[0] ?? '';
  const body = await response.json().catch(() => ({}));
  return { cookie, body };
};

// ---------------------------------------------------------------------------

const base = app => truth.applications.find(a => a.application === app).baseUrl;

console.log('\nSecurity lab — ground truth audit\n');

// ---- auth-lab --------------------------------------------------------------
{
  const b = base('auth-lab');
  console.log(dim('auth-lab'));

  const unknown = await json(`${b}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'nobody-here', password: 'x' }) });
  const wrongPassword = await json(`${b}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'wrong' }) });
  report(unknown.json?.error !== wrongPassword.json?.error, 'VULN_USER_ENUMERATION',
    `unknown="${unknown.json?.error}" vs wrong-password="${wrongPassword.json?.error}"`);

  let lockedOut = false;
  for (let i = 0; i < 8; i++) {
    const r = await json(`${b}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'wrong' }) });
    if (r.status === 429) { lockedOut = true; break; }
  }
  report(!lockedOut, 'VULN_NO_LOCKOUT', '8 failed sign-ins, never throttled');

  const { cookie } = await signIn(b);
  await fetch(`${b}/api/session`, { method: 'DELETE', headers: { cookie } });
  const afterLogout = await json(`${b}/api/session`, { headers: { cookie } });
  report(afterLogout.status === 200, 'VULN_SESSION_SURVIVES_LOGOUT', `token still authenticates: ${afterLogout.status}`);

  const fresh = await signIn(b);
  report((fresh.body.expiresInSeconds ?? 0) > 60 * 60 * 24, 'VULN_LONG_SESSION',
    `expiresInSeconds=${fresh.body.expiresInSeconds}`);

  const reset = await json(`${b}/api/password-reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice' }) });
  const token = reset.json?.resetToken;
  const first = await json(`${b}/api/password-reset/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  const second = await json(`${b}/api/password-reset/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  report(first.status === 200 && second.status === 200, 'VULN_RESET_TOKEN_REUSE', `first=${first.status} second=${second.status}`);

  // The safe claim is that this endpoint does not enumerate, and the test has to be the
  // one an enumeration detector would actually run: same status, same fields. The earlier
  // version asserted that an unknown account got *no* token, which was the enumerating
  // behaviour — the shape of the response gave the account away as plainly as a 404 would.
  const knownReset = await json(`${b}/api/password-reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice' }) });
  const unknownReset = await json(`${b}/api/password-reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'nobody-here' }) });
  const shape = r => `${r.status}:${Object.keys(r.json ?? {}).sort().join(',')}`;
  reportSafe(shape(knownReset) === shape(unknownReset) && unknownReset.status === 202,
    'POST /api/password-reset',
    `known and unknown accounts both answered ${shape(unknownReset)}`);

  // And the token an unknown account receives must be inert, or the endpoint would be
  // handing out working reset tokens for accounts that do not exist.
  const inert = await json(`${b}/api/password-reset/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: unknownReset.json?.resetToken }) });
  reportSafe(inert.status === 400, 'POST /api/password-reset/confirm',
    `the token issued for an unknown account is rejected (${inert.status})`);
}

// ---- access-control-lab ------------------------------------------------------
{
  const b = base('access-control-lab');
  console.log(dim('\naccess-control-lab'));
  const { cookie } = await signIn(b, 'alice');

  const bob = await json(`${b}/api/accounts/acc-1002`, { headers: { cookie } });
  report(bob.status === 200 && bob.json?.account?.owner === 'u-bob', 'VULN_BOLA',
    `alice read ${bob.json?.account?.id} owned by ${bob.json?.account?.owner}`);

  const admin = await json(`${b}/api/admin/users`, { headers: { cookie } });
  report(admin.status === 200, 'VULN_VERTICAL_ESCALATION', `customer received ${admin.status} from an admin route`);

  const readonly = await signIn(b, 'mallory');
  const transfer = await json(`${b}/api/transfers`, { method: 'POST', headers: { cookie: readonly.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ from: 'acc-1003', to: 'acc-1001', amount: 1 }) });
  report(transfer.status === 201, 'VULN_READONLY_CAN_WRITE', `readonly account received ${transfer.status}`);

  const statement = await json(`${b}/api/accounts/acc-1002/statement`);
  report(statement.status === 200, 'VULN_MISSING_AUTHZ', `unauthenticated caller received ${statement.status}`);

  const own = await json(`${b}/api/accounts`, { headers: { cookie } });
  const ids = (own.json?.accounts ?? []).map(a => a.id);
  reportSafe(ids.length === 1 && ids[0] === 'acc-1001', 'GET /api/accounts', `returned only ${ids.join(',')}`);
}

// ---- api-lab ------------------------------------------------------------------
{
  const b = base('api-lab');
  console.log(dim('\napi-lab'));

  const forged = await json(`${b}/api/users`, { headers: { authorization: 'Bearer u-admin.forged' } });
  report(forged.status === 200, 'VULN_UNVERIFIED_TOKEN', `a forged bearer naming u-admin received ${forged.status}`);

  const { cookie } = await signIn(b, 'alice');
  const patched = await json(`${b}/api/users/u-alice`, { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ role: 'admin' }) });
  report(patched.json?.user?.role === 'admin', 'VULN_MASS_ASSIGNMENT', `role became ${patched.json?.user?.role}`);

  const badNote = await json(`${b}/api/notes`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ title: 12345 }) });
  report(badNote.status === 201, 'VULN_NO_INPUT_VALIDATION', `a numeric title was accepted: ${badNote.status}`);

  const del = await json(`${b}/api/notes/note-1`, { method: 'DELETE' });
  report(del.status === 204, 'VULN_UNSAFE_METHODS', `unauthenticated DELETE received ${del.status}`);

  let limited = false;
  for (let i = 0; i < 15; i++) {
    const r = await json(`${b}/api/search?q=x`);
    if (r.status === 429) { limited = true; break; }
  }
  report(!limited, 'VULN_NO_RATE_LIMIT', '15 requests, never refused');

  const users = await json(`${b}/api/users`, { headers: { cookie } });
  report(users.text.includes('passwordHash') && users.text.includes('apiToken'), 'VULN_EXCESSIVE_DATA',
    'the response carries passwordHash and apiToken');

  const other = await json(`${b}/api/accounts/acc-1002`, { headers: { cookie } });
  reportSafe(other.status === 403, 'GET /api/accounts/{id}', `alice received ${other.status} for bob's account`);
}

// ---- xss-lab --------------------------------------------------------------------
{
  const b = base('xss-lab');
  console.log(dim('\nxss-lab'));
  const marker = '<aira-marker>';

  const search = await json(`${b}/search?q=${encodeURIComponent(marker)}`);
  report(search.text.includes(marker), 'VULN_REFLECTED_XSS', 'the marker came back with its angle brackets intact');

  await fetch(`${b}/profile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bio: marker }) });
  const profile = await json(`${b}/profile`);
  report(profile.text.includes(marker), 'VULN_STORED_XSS', 'a stored marker is rendered unencoded');

  const dom = await json(`${b}/dom`);
  report(dom.text.includes('innerHTML'), 'VULN_DOM_XSS', 'location.hash reaches innerHTML');

  const greet = await json(`${b}/greet?name=${encodeURIComponent(marker)}`);
  reportSafe(!greet.text.includes(marker) && greet.text.includes('&lt;aira-marker&gt;'), 'GET /greet',
    'reflected HTML-escaped');

  const echo = await json(`${b}/echo?value=${encodeURIComponent(marker)}`);
  reportSafe(echo.headers.get('content-type')?.includes('application/json') === true, 'GET /echo',
    'reflected into JSON, not an HTML context');
}

// ---- csrf-upload-lab --------------------------------------------------------------
{
  const b = base('csrf-upload-lab');
  console.log(dim('\ncsrf-upload-lab'));
  const { cookie } = await signIn(b, 'alice');

  const noToken = await json(`${b}/api/transfer`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ to: 'acc-1002', amount: 1 }) });
  report(noToken.status === 201, 'VULN_NO_CSRF_TOKEN', `accepted with no CSRF token: ${noToken.status}`);

  const crossOrigin = await json(`${b}/api/transfer`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: 'https://evil.test' }, body: JSON.stringify({ to: 'acc-1002', amount: 1 }) });
  report(crossOrigin.status === 201, 'VULN_NO_ORIGIN_CHECK', `accepted from https://evil.test: ${crossOrigin.status}`);

  const exe = await json(`${b}/api/upload`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ filename: 'payload.exe', contentType: 'image/png', size: 10 }) });
  report(exe.status === 201, 'VULN_UPLOAD_ANY_TYPE', `.exe declared as image/png accepted: ${exe.status}`);

  const huge = await json(`${b}/api/upload`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ filename: 'big.txt', contentType: 'text/plain', size: 50_000_000 }) });
  report(huge.status === 201, 'VULN_UPLOAD_NO_SIZE_LIMIT', `50MB declared and accepted: ${huge.status}`);

  const traversal = await json(`${b}/api/upload`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ filename: '../../etc/passwd', contentType: 'text/plain', size: 10 }) });
  report(String(traversal.json?.upload?.storedAs ?? '').includes('../'), 'VULN_UPLOAD_PATH_TRAVERSAL',
    `storedAs="${traversal.json?.upload?.storedAs}"`);

  const redirect = await fetch(`${b}/redirect?next=https://evil.test/`, { redirect: 'manual' });
  report(redirect.headers.get('location') === 'https://evil.test/', 'VULN_OPEN_REDIRECT',
    `Location: ${redirect.headers.get('location')}`);

  const ssrf = await json(`${b}/api/fetch?url=${encodeURIComponent('http://10.255.255.1/x')}`);
  report(ssrf.status !== 400 && ssrf.json?.attempted === 'http://10.255.255.1/x', 'VULN_SSRF',
    `a private-range destination was accepted (${ssrf.status})`);

  const ownOrigin = await json(`${b}/api/fetch?url=${encodeURIComponent(`${b}/health`)}`);
  reportSafe(ownOrigin.status === 200, 'GET /api/fetch?url=<same origin>',
    `the application's own origin is accepted (${ownOrigin.status})`);
}

// ---- headers-lab --------------------------------------------------------------------
{
  const b = base('headers-lab');
  console.log(dim('\nheaders-lab'));

  const weak = await json(`${b}/weak`);
  report(!weak.headers.get('content-security-policy'), 'VULN_NO_CSP', 'no Content-Security-Policy');
  const weakCookie = (weak.headers.getSetCookie?.() ?? [])[0] ?? '';
  report(!/HttpOnly/i.test(weakCookie) && !/Secure/i.test(weakCookie), 'VULN_WEAK_COOKIE', `Set-Cookie: ${weakCookie}`);

  const cors = await json(`${b}/api/data`, { headers: { origin: 'https://evil.test' } });
  report(cors.headers.get('access-control-allow-origin') === 'https://evil.test'
      && cors.headers.get('access-control-allow-credentials') === 'true', 'VULN_REFLECTED_CORS',
    'arbitrary origin reflected with credentials allowed');

  const files = await json(`${b}/files`);
  report(files.status === 200 && files.text.includes('backup.sql'), 'VULN_DIRECTORY_LISTING', 'index names backup.sql and .env');

  const boom = await json(`${b}/boom`);
  report(boom.text.includes('at Lab.Controllers'), 'VULN_VERBOSE_ERROR', 'a stack trace with source paths');

  const map = await json(`${b}/app.js.map`);
  report(map.status === 200 && map.text.includes('sourcesContent'), 'VULN_SOURCE_MAP', 'source map served with sourcesContent');

  const strict = await json(`${b}/strict`);
  const strictCookie = (strict.headers.getSetCookie?.() ?? [])[0] ?? '';
  reportSafe(Boolean(strict.headers.get('content-security-policy'))
    && /HttpOnly/i.test(strictCookie) && /Secure/i.test(strictCookie) && /SameSite/i.test(strictCookie),
    'GET /strict', 'CSP present and the cookie fully attributed');

  const pub = await json(`${b}/api/public`, { headers: { origin: 'https://evil.test' } });
  reportSafe(pub.headers.get('access-control-allow-origin') === '*'
    && !pub.headers.get('access-control-allow-credentials'),
    'GET /api/public', 'wildcard origin with no credentials — correct, and commonly mis-flagged');
}

// ---- injection-lab ----------------------------------------------------------------------
{
  const b = base('injection-lab');
  console.log(dim('\ninjection-lab'));

  const quote = await json(`${b}/api/products?name=${encodeURIComponent("x'")}`);
  report(quote.status === 500 && /SQLSTATE/.test(quote.text), 'VULN_SQL_INJECTION',
    'an unbalanced quote produced a database error');

  const tautology = await json(`${b}/api/products?name=${encodeURIComponent("x' or '1'='1")}`);
  report((tautology.json?.matched ?? 0) === 3, 'VULN_SQL_INJECTION (tautology)',
    `a tautology widened the result to ${tautology.json?.matched} rows`);

  const nosql = await json(`${b}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: { $ne: null } }) });
  report(nosql.json?.authenticated === true, 'VULN_NOSQL_INJECTION', 'an operator object was accepted where a string belongs');

  const command = await json(`${b}/api/ping?host=${encodeURIComponent('x;id')}`);
  report(command.status === 500 && /\/bin\/sh/.test(command.text), 'VULN_COMMAND_INJECTION',
    'a metacharacter produced a shell-shaped error');

  const template = await json(`${b}/api/render?template=${encodeURIComponent('{{7*7}}')}`);
  report(template.json?.rendered === '49', 'VULN_TEMPLATE_INJECTION', '{{7*7}} rendered as 49');
}

// ---------------------------------------------------------------------------

console.log('');
if (failed === 0) {
  console.log(green(`Ground truth matches the lab: ${checked} check(s), every planted vulnerability present and every safe endpoint safe.`));
  process.exit(0);
}
console.log(red(`${failed} of ${checked} check(s) disagree with the ground truth.`));
console.log(red('Nothing measured against this lab would mean anything until they agree.'));
process.exit(1);
