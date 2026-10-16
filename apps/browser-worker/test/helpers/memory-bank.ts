import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

/**
 * A banking application built the way the hard ones are:
 *
 * - a single-page application whose sign-in token lives only in memory, so loading any
 *   page by its address starts it afresh and signed out;
 * - one session per user: a second sign-in while one is open is refused with "already
 *   logged in", until the first signs out;
 * - a two-screen sign-in (user id, then password) and its forms behind it.
 */
export interface MemoryBank {
  baseUrl: string;
  /** How many sign-ins the server refused because a session was already open. */
  refusals(): number;
  /** Sessions open right now. */
  openSessions(): number;
  stop(): Promise<void>;
}

const SHELL = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Memory Bank</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<header id="top"></header><main id="root">Loading…</main>
<script>
let token = null; // in memory only: a page load forgets it
let pendingUser = '';
const root = document.getElementById('root');
const bar = document.getElementById('top');
const go = path => { history.pushState({}, '', path); render(); };
window.addEventListener('popstate', render);
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-route]');
  if (a) { e.preventDefault(); go(a.getAttribute('href')); }
});
async function api(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-token': token || '' }, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
function nav() {
  bar.innerHTML = token ? '<nav aria-label="Main"><a data-route href="/app/dashboard">Dashboard</a> <a data-route href="/app/accounts">Accounts</a> '
    + '<a data-route href="/app/transfer">Fund transfer</a> <a data-route href="/app/beneficiaries">Beneficiaries</a> '
    + '<a data-route href="/app/profile">My profile</a> <button id="logout" type="button">Logout</button></nav>' : '';
  const out = document.getElementById('logout');
  if (out) out.onclick = async () => { await api('/api/logout'); token = null; go('/app/login'); };
}
function render() {
  const path = location.pathname;
  nav();
  if (!token && path !== '/app/login' && path !== '/app/login2') { history.replaceState({}, '', '/app/login'); return render(); }
  if (path === '/app/login') {
    root.innerHTML = '<h1>Sign in</h1><label for="uid">User ID</label><input id="uid" name="userid" type="text">'
      + '<p id="msg" role="alert"></p><button id="next" type="button">Continue</button>';
    document.getElementById('next').onclick = () => { pendingUser = document.getElementById('uid').value; go('/app/login2'); };
    return;
  }
  if (path === '/app/login2') {
    root.innerHTML = '<h1>Sign in</h1><label for="pw">Password</label><input id="pw" name="new-password" type="text" style="-webkit-text-security:disc">'
      + '<p id="msg" role="alert"></p><button id="login" type="button">Login</button>';
    document.getElementById('login').onclick = async () => {
      const r = await api('/api/login', { user: pendingUser, password: document.getElementById('pw').value });
      if (r.status === 200) { token = r.body.token; go('/app/dashboard'); }
      else document.getElementById('msg').textContent = r.body.error;
    };
    return;
  }
  if (path === '/app/dashboard') { root.innerHTML = '<h1>Dashboard</h1><h2>Quick links</h2><a data-route href="/app/transfer">Make a transfer</a>'; return; }
  if (path === '/app/accounts') { root.innerHTML = '<h1>My accounts</h1><table><caption>Savings and current accounts</caption><tr><th>Account</th><th>Type</th></tr><tr><td>XXXX1234</td><td>Savings</td></tr></table>'; return; }
  if (path === '/app/transfer') {
    root.innerHTML = '<h1>Fund transfer</h1><form id="transfer"><label for="from">From account</label><select id="from" name="from" required><option value="">Choose</option><option>XXXX1234</option></select>'
      + '<label for="to">To account number</label><input id="to" name="to" required pattern="[0-9]{9,18}" inputmode="numeric">'
      + '<label for="amount">Amount</label><input id="amount" name="amount" type="number" min="1" max="100000" required>'
      + '<label for="remarks">Remarks</label><input id="remarks" name="remarks" maxlength="50">'
      + '<button type="submit">Transfer</button></form><p id="done"></p>';
    document.getElementById('transfer').onsubmit = e => { e.preventDefault(); document.getElementById('done').textContent = 'Transfer submitted.'; };
    return;
  }
  if (path === '/app/beneficiaries') {
    root.innerHTML = '<h1>Beneficiaries</h1><form id="ben"><label for="bname">Beneficiary name</label><input id="bname" name="name" required maxlength="40">'
      + '<label for="bacc">Account number</label><input id="bacc" name="account" required pattern="[0-9]{9,18}">'
      + '<label for="ifsc">IFSC code</label><input id="ifsc" name="ifsc" required pattern="[A-Z]{4}0[A-Z0-9]{6}">'
      + '<button type="submit">Add beneficiary</button></form>';
    document.getElementById('ben').onsubmit = e => e.preventDefault();
    return;
  }
  if (path === '/app/profile') {
    root.innerHTML = '<h1>My profile</h1><form id="prof"><label for="email">Email</label><input id="email" name="email" type="email" required>'
      + '<label for="mobile">Mobile number</label><input id="mobile" name="mobile" type="tel" pattern="[0-9]{10}" required><button type="submit">Save</button></form>';
    document.getElementById('prof').onsubmit = e => e.preventDefault();
    return;
  }
  root.innerHTML = '<h1>Page not found</h1>';
}
render();
</script></body></html>`;

export async function startMemoryBank(): Promise<MemoryBank> {
  let session: { token: string; at: number } | null = null;
  let refused = 0;

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (url.pathname.startsWith('/api/')) {
      let raw = '';
      request.on('data', chunk => { raw += chunk; });
      request.on('end', () => {
        const body = raw ? JSON.parse(raw) as { user?: string; password?: string } : {};
        if (url.pathname === '/api/login') {
          if (body.user !== 'tester' || body.password !== 'secret') return json(401, { error: 'Invalid user ID or password.' });
          if (session) { refused++; return json(409, { error: 'You are already logged in from another session.' }); }
          session = { token: randomUUID(), at: Date.now() };
          return json(200, { token: session.token });
        }
        if (url.pathname === '/api/logout') {
          if (session && request.headers['x-token'] === session.token) session = null;
          return json(200, {});
        }
        return json(404, {});
      });
      return;
    }
    if (url.pathname === '/' ) { response.writeHead(302, { location: '/app/login' }); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(SHELL);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    refusals: () => refused,
    openSessions: () => (session ? 1 : 0),
    stop: () => new Promise(resolve => server.close(() => resolve()))
  };
}
