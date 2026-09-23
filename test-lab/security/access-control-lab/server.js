/**
 * Access control, broken on purpose.
 *
 * The brief calls authorization AIRA's highest-priority security capability, and this is
 * the application it is proved against. Five synthetic identities own five synthetic
 * accounts, and the endpoints below get the ownership and role checks wrong in the four
 * ways that matter:
 *
 *   BOLA          /api/accounts/:id returns any account to any signed-in caller
 *   VERTICAL      /api/admin/users is served to a customer
 *   READONLY      a read-only account can POST a transfer
 *   MISSING_AUTHZ /api/accounts/:id/statement has no check at all
 *
 * Each is independently switchable, because a false-positive test needs the application to
 * be *correct* and AIRA to say nothing. Switch VULN_BOLA off and /api/accounts/:id starts
 * behaving; AIRA reporting BOLA anyway is then a defect in AIRA, not a finding.
 *
 * Every account here is fictional and every balance is a round number, so a leak shows up
 * unmistakably in evidence rather than having to be argued about.
 */
import { ACCOUNTS, IDENTITIES, createSecurityLab, findAccount, findIdentity } from '../shared/security-lab.js';

const PORT = Number(process.env.ACCESS_CONTROL_LAB_PORT ?? 4401);

const app = createSecurityLab({
  name: 'AIRA Access Control Lab',
  vulnerabilities: [
    { id: 'VULN_BOLA', description: 'GET /api/accounts/:id returns any account to any signed-in caller (broken object level authorization).' },
    { id: 'VULN_VERTICAL_ESCALATION', description: 'GET /api/admin/users is served to non-admin callers (broken function level authorization).' },
    { id: 'VULN_READONLY_CAN_WRITE', description: 'POST /api/transfers is accepted from a read-only account.' },
    { id: 'VULN_MISSING_AUTHZ', description: 'GET /api/accounts/:id/statement applies no authorization at all.' }
  ]
});

app.use(ctx => { app.writeSecurityHeaders(ctx); });

const publicUser = identity => ({
  id: identity.id, username: identity.username, role: identity.role, displayName: identity.displayName
});

// ---- Authentication (correct here; the auth lab is where it is broken) -----

app.post('/api/session', async ctx => {
  const { username, password } = await ctx.body();
  const identity = findIdentity(String(username ?? ''));
  if (!identity || identity.password !== password) {
    return ctx.json(401, { error: 'invalid_credentials' });
  }
  const session = app.signIn(ctx, identity);
  return ctx.json(200, { user: publicUser(identity), csrfToken: session.csrf });
});

app.delete('/api/session', ctx => { app.signOut(ctx); return ctx.json(204, {}); });

app.get('/api/session', ctx => {
  const identity = app.currentIdentity(ctx);
  if (!identity) return ctx.json(401, { error: 'unauthenticated' });
  return ctx.json(200, { user: publicUser(identity) });
});

// ---- The accounts the caller genuinely owns -------------------------------

app.get('/api/accounts', ctx => {
  const identity = app.currentIdentity(ctx);
  if (!identity) return ctx.json(401, { error: 'unauthenticated' });
  const owned = ACCOUNTS.filter(a => a.owner === identity.id);
  return ctx.json(200, { accounts: owned });
});

// ---- BOLA: one account by identifier --------------------------------------

app.get('/api/accounts/:id', ctx => {
  const identity = app.currentIdentity(ctx);
  if (!identity) return ctx.json(401, { error: 'unauthenticated' });

  const account = findAccount(ctx.params.id);
  if (!account) return ctx.json(404, { error: 'not_found' });

  // The whole point. With the vulnerability on, ownership is never consulted, so alice
  // reads bob's balance and sort code by changing a digit in the URL.
  if (!app.faults.on('VULN_BOLA') && !app.faults.on('DISABLE_AUTHORIZATION')) {
    if (account.owner !== identity.id && identity.role !== 'admin') {
      // 404 rather than 403 when the caller has no business knowing it exists, which is
      // the behaviour the brief names as acceptable alongside 403.
      return ctx.json(404, { error: 'not_found' });
    }
  }
  return ctx.json(200, { account });
});

// ---- Missing authorization entirely ---------------------------------------

app.get('/api/accounts/:id/statement', ctx => {
  const account = findAccount(ctx.params.id);
  if (!account) return ctx.json(404, { error: 'not_found' });

  if (!app.faults.on('VULN_MISSING_AUTHZ') && !app.faults.on('DISABLE_AUTHORIZATION')) {
    const identity = app.currentIdentity(ctx);
    if (!identity) return ctx.json(401, { error: 'unauthenticated' });
    if (account.owner !== identity.id && identity.role !== 'admin') {
      return ctx.json(403, { error: 'forbidden' });
    }
  }
  return ctx.json(200, {
    statement: {
      accountId: account.id,
      holder: account.name,
      balance: account.balance,
      sortCode: account.sortCode,
      lines: [{ date: '2026-01-02', description: 'Synthetic opening balance', amount: account.balance }]
    }
  });
});

// ---- Vertical escalation ---------------------------------------------------

app.get('/api/admin/users', ctx => {
  const identity = app.currentIdentity(ctx);
  if (!identity) return ctx.json(401, { error: 'unauthenticated' });

  if (!app.faults.on('VULN_VERTICAL_ESCALATION') && !app.faults.on('DISABLE_AUTHORIZATION')) {
    if (identity.role !== 'admin') return ctx.json(403, { error: 'forbidden' });
  }
  return ctx.json(200, { users: IDENTITIES.map(publicUser) });
});

// ---- Read-only account performing a write ----------------------------------

app.post('/api/transfers', async ctx => {
  const identity = app.currentIdentity(ctx);
  if (!identity) return ctx.json(401, { error: 'unauthenticated' });

  if (!app.faults.on('VULN_READONLY_CAN_WRITE') && !app.faults.on('DISABLE_AUTHORIZATION')) {
    if (identity.role === 'readonly') return ctx.json(403, { error: 'forbidden' });
  }
  const { from, to, amount } = await ctx.body();
  // Nothing is actually moved. A lab that mutates state makes a second run depend on the
  // first, and a security test that cannot be repeated is not a regression test.
  return ctx.json(201, {
    transfer: { id: `txn-${Date.now()}`, from, to, amount, acceptedFor: identity.username },
    note: 'Synthetic. No balance was changed.'
  });
});

// ---- A page, so a browser-driven scan has somewhere to start ----------------

app.get('/', ctx => ctx.html(200, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Access Control Lab</title></head>
<body>
  <h1>Access Control Lab</h1>
  <p>Deliberately vulnerable. Synthetic data only.</p>
  <form id="signin" method="post" action="/api/session">
    <label for="username">Username</label><input id="username" name="username" data-testid="username">
    <label for="password">Password</label><input id="password" name="password" type="password" data-testid="password">
    <button type="submit" data-testid="login-submit">Sign in</button>
  </form>
  <a href="/api/accounts" data-testid="accounts-link">Accounts</a>
</body></html>`));

app.post('/__reset', ctx => { app.resetSessions(); return ctx.json(200, { reset: true }); });

await app.listen(PORT);
