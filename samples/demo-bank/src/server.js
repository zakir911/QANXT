import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { URL } from 'node:url';
import { accountsFor, findUser, payees as allPayees, transactionsFor, accounts as allAccounts } from './data.js';
import { getScenario, resetScenario, setScenario, SCENARIO_KEYS } from './scenario.js';
import {
  accountDetailPage, accountsPage, activityPage, dashboardPage, errorPage, loginPage,
  paymentsPage, profilePage
} from './views.js';

/**
 * Demo Bank: a small but genuine server-rendered banking application with a JSON API
 * alongside it, used as the platform's target of record.
 *
 * Deliberately built on the Node standard library: the point is to test an ordinary
 * application, and a dependency-free target keeps the demo reproducible years from now.
 */

const PORT = Number(process.env.DEMO_BANK_PORT ?? 4200);
const sessions = new Map();
const SESSION_COOKIE = 'demo_bank_session';
const SESSION_TTL_MS = 30 * 60 * 1000;

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  try {
    await route(req, res);
  } catch (error) {
    if (!res.headersSent) {
      const status = error.statusCode ?? 500;
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(errorPage({ status, message: error.message }));
    }
    if (!error.statusCode) console.error('[demo-bank] unhandled error', error);
  } finally {
    console.log(`[demo-bank] ${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - started}ms)`);
  }
});

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? `localhost:${PORT}`}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';

  // ---- Test-control surface -------------------------------------------------
  // Namespaced under /__control so it can never collide with an application route,
  // and clearly separate from the application the platform is meant to be testing.
  if (path === '/__control/scenario' && method === 'GET') return json(res, 200, getScenario());
  if (path === '/__control/scenario' && method === 'POST') {
    const body = await readJson(req);
    return json(res, 200, setScenario(body));
  }
  if (path === '/__control/reset' && method === 'POST') {
    sessions.clear();
    return json(res, 200, resetScenario());
  }
  if (path === '/__control/keys' && method === 'GET') return json(res, 200, { keys: SCENARIO_KEYS });
  if (path === '/health') return json(res, 200, { status: 'ok', scenario: getScenario() });

  // ---- Public --------------------------------------------------------------
  if (path === '/' && method === 'GET') return redirect(res, '/login');
  if (path === '/login' && method === 'GET') return html(res, 200, loginPage({}));
  if (path === '/login' && method === 'POST') return handleLogin(req, res);
  if (path === '/logout' && method === 'POST') return handleLogout(req, res);

  // ---- Authenticated -------------------------------------------------------
  const session = currentSession(req);
  if (path.startsWith('/api/')) return apiRoutes(req, res, url, path, method, session);

  if (!session) return redirect(res, '/login');

  // A single expiry event: the switch fires once and then clears itself, which is
  // how a real session timeout behaves from the test's point of view.
  if (getScenario().sessionTimeout) {
    setScenario({ sessionTimeout: false });
    sessions.delete(session.id);
    return redirect(res, '/login?expired=1');
  }

  const user = session.user;

  if (path === '/dashboard' && method === 'GET') {
    if (getScenario().slowDashboard) await delay(6000);
    const accounts = accountsFor(user.id);
    const trueTotal = accounts.reduce((sum, a) => sum + a.balance, 0);
    // wrongBalance omits the last account from the total: a defect an assertion should catch.
    const total = getScenario().wrongBalance
      ? accounts.slice(0, -1).reduce((sum, a) => sum + a.balance, 0)
      : trueTotal;
    return html(res, 200, dashboardPage({ user, accounts, total, currency: accounts[0]?.currency ?? 'GBP' }));
  }

  if (path === '/accounts' && method === 'GET') {
    return html(res, 200, accountsPage({ user, accounts: accountsFor(user.id) }));
  }

  const accountMatch = /^\/accounts\/([A-Za-z0-9-]+)$/.exec(path);
  if (accountMatch && method === 'GET') {
    const account = ownedAccount(user, accountMatch[1]);
    const filters = readFilters(url);
    let error = null;
    let rows = transactionsFor(account.id);

    const rangeError = validateRange(filters);
    if (rangeError) {
      error = rangeError;
      rows = [];
    } else {
      rows = rows.filter(t =>
        (!filters.from || t.date >= filters.from) &&
        (!filters.to || t.date <= filters.to) &&
        (!filters.category || t.category === filters.category));
    }

    return html(res, 200, accountDetailPage({ user, account, transactions: rows, filters, error }));
  }

  const statementMatch = /^\/accounts\/([A-Za-z0-9-]+)\/statement$/.exec(path);
  if (statementMatch && method === 'GET') return handleStatement(res, user, statementMatch[1], url);

  if (path === '/activity' && method === 'GET') {
    return html(res, 200, activityPage({ user, accounts: accountsFor(user.id) }));
  }

  if (path === '/payments' && method === 'GET') {
    return html(res, 200, paymentsPage({ user, accounts: accountsFor(user.id), payees: payeesFor(user.id) }));
  }
  if (path === '/payments' && method === 'POST') return handlePayment(req, res, user);

  if (path === '/profile' && method === 'GET') return html(res, 200, profilePage({ user }));
  if (path === '/profile' && method === 'POST') return handleProfile(req, res, user);

  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
  res.end(errorPage({ status: 404, message: 'That page does not exist.', user }));
}

// ---- Handlers ---------------------------------------------------------------

async function handleLogin(req, res) {
  const form = await readForm(req);
  const username = (form.username ?? '').trim();
  const password = form.password ?? '';

  if (!username) return html(res, 400, loginPage({ error: 'Enter your username.', username }));
  if (!password) return html(res, 400, loginPage({ error: 'Enter your password.', username }));

  const user = findUser(username);
  if (!user || !constantTimeEquals(user.password, password)) {
    return html(res, 401, loginPage({ error: 'The username or password is incorrect.', username }));
  }
  if (user.status === 'locked') {
    return html(res, 423, loginPage({ error: 'This account is locked. Contact support to unlock it.', username }));
  }

  const id = randomUUID();
  sessions.set(id, { id, user: { ...user }, expiresAt: Date.now() + SESSION_TTL_MS });
  res.writeHead(302, {
    location: '/dashboard',
    'set-cookie': `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax`
  });
  res.end();
}

function handleLogout(req, res) {
  const session = currentSession(req);
  if (session) sessions.delete(session.id);
  res.writeHead(302, { location: '/login', 'set-cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0` });
  res.end();
}

function handleStatement(res, user, accountId, url) {
  const account = ownedAccount(user, accountId);
  const filters = readFilters(url);
  const rangeError = validateRange(filters);
  if (rangeError) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(rangeError);
  }

  const rows = getScenario().emptyStatement ? [] : transactionsFor(account.id).filter(t =>
    (!filters.from || t.date >= filters.from) && (!filters.to || t.date <= filters.to));

  const csv = ['Date,Description,Category,Amount,Balance']
    .concat(rows.map(t => `${t.date},"${t.description}",${t.category},${t.amount.toFixed(2)},${t.balanceAfter.toFixed(2)}`))
    .join('\n');

  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="statement-${account.number}.csv"`
  });
  res.end(csv);
}

async function handlePayment(req, res, user) {
  const form = await readForm(req);
  const accounts = accountsFor(user.id);
  const payees = payeesFor(user.id);
  const values = {
    fromAccount: form.fromAccount, payee: form.payee,
    amount: form.amount, reference: form.reference
  };

  const account = accounts.find(a => a.id === form.fromAccount);
  const amount = Number.parseFloat(String(form.amount ?? '').replace(/,/g, ''));

  let error = null;
  if (!account) error = 'Select an account to pay from.';
  else if (!payees.some(p => p.id === form.payee)) error = 'Select a payee.';
  else if (!Number.isFinite(amount) || amount <= 0) error = 'Enter an amount greater than zero.';
  else if (amount > account.balance) error = 'There are not enough funds in the selected account.';
  else if ((form.reference ?? '').length > 18) error = 'The reference must be 18 characters or fewer.';

  if (error) return html(res, 400, paymentsPage({ user, accounts, payees, error, values }));

  // Simulated: the in-memory balance moves so subsequent assertions see a consistent
  // application, but nothing is persisted beyond the process.
  account.balance = Math.round((account.balance - amount) * 100) / 100;
  const payee = payees.find(p => p.id === form.payee);
  return html(res, 200, paymentsPage({
    user, accounts, payees,
    message: `Payment of £${amount.toFixed(2)} to ${payee.name} has been scheduled.`
  }));
}

async function handleProfile(req, res, user) {
  const form = await readForm(req);
  if (form.displayName) user.displayName = String(form.displayName).slice(0, 80);
  if (form.email) user.email = String(form.email).slice(0, 120);
  if (form.phone) user.phone = String(form.phone).slice(0, 40);
  return html(res, 200, profilePage({ user, message: 'Your profile has been updated.' }));
}

// ---- JSON API ---------------------------------------------------------------
// The UI calls these, which is how the platform's API discovery correlates a click
// with the request it produced.

function apiRoutes(req, res, url, path, method, session) {
  if (path === '/api/session') {
    return session
      ? json(res, 200, { authenticated: true, user: publicUser(session.user) })
      : json(res, 401, { authenticated: false, error: 'Not signed in.' });
  }

  if (!session) return json(res, 401, { error: 'Authentication required.' });
  const user = session.user;

  if (path === '/api/accounts' && method === 'GET') {
    return json(res, 200, { accounts: accountsFor(user.id) });
  }

  const txnMatch = /^\/api\/accounts\/([A-Za-z0-9-]+)\/transactions$/.exec(path);
  if (txnMatch && method === 'GET') {
    if (getScenario().breakTransactionsApi) {
      return json(res, 500, { error: 'TRANSACTION_SERVICE_UNAVAILABLE', message: 'The transaction service is temporarily unavailable.' });
    }
    const account = ownedAccount(user, txnMatch[1]);
    const filters = readFilters(url);
    const rangeError = validateRange(filters);
    if (rangeError) return json(res, 400, { error: 'INVALID_DATE_RANGE', message: rangeError });

    const rows = transactionsFor(account.id).filter(t =>
      (!filters.from || t.date >= filters.from) &&
      (!filters.to || t.date <= filters.to) &&
      (!filters.category || t.category === filters.category));
    return json(res, 200, { accountId: account.id, count: rows.length, transactions: rows });
  }

  if (path === '/api/payees' && method === 'GET') return json(res, 200, { payees: payeesFor(user.id) });

  return json(res, 404, { error: 'NOT_FOUND', message: `No API route for ${method} ${path}.` });
}

// ---- Helpers ----------------------------------------------------------------

function publicUser(user) {
  const { password, ...safe } = user;      // a demo app still must not leak credentials
  return safe;
}

function payeesFor(userId) {
  return allPayees.filter(p => p.userId === userId);
}

function ownedAccount(user, accountId) {
  const account = allAccounts.find(a => a.id === accountId);
  if (!account) throw Object.assign(new Error('That account does not exist.'), { statusCode: 404 });
  if (account.userId !== user.id) {
    // Deliberately 404 rather than 403: existence of another customer's account is itself private.
    throw Object.assign(new Error('That account does not exist.'), { statusCode: 404 });
  }
  return account;
}

function readFilters(url) {
  return {
    from: url.searchParams.get('from') ?? '',
    to: url.searchParams.get('to') ?? '',
    category: url.searchParams.get('category') ?? ''
  };
}

function validateRange({ from, to }) {
  const isDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
  if (from && !isDate(from)) return 'The "from" date is not a valid date.';
  if (to && !isDate(to)) return 'The "to" date is not a valid date.';
  if (from && to && from > to) return 'The "from" date must be on or before the "to" date.';
  if (from && to) {
    const days = (Date.parse(to) - Date.parse(from)) / 86400000;
    if (days > 366) return 'The date range must not exceed 366 days.';
  }
  return null;
}

function currentSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const id = cookies[SESSION_COOKIE];
  if (!id) return null;
  const session = sessions.get(id);
  if (!session) return null;
  if (session.expiresAt < Date.now()) { sessions.delete(id); return null; }
  return session;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name) out[name] = rest.join('=');
  }
  return out;
}

function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

async function readBody(req, limitBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readForm(req) {
  const body = await readBody(req);
  return Object.fromEntries(new URLSearchParams(body));
}

async function readJson(req) {
  const body = await readBody(req);
  if (!body) return {};
  try { return JSON.parse(body); }
  catch { throw Object.assign(new Error('The request body is not valid JSON.'), { statusCode: 400 }); }
}

function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

server.listen(PORT, () => {
  console.log(`[demo-bank] listening on http://localhost:${PORT} (synthetic data only)`);
});

export { server };
