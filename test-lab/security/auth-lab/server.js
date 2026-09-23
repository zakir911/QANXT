/**
 * Authentication and session handling, broken on purpose.
 *
 * Covers the brief's authentication list: credential handling, repeated failures and
 * lockout, error handling that distinguishes what it should not, session creation and
 * expiry, sign-out invalidation, reuse after sign-out, and cookie attributes.
 *
 * No password in this application is a real one and none is ever echoed. The sensitive-data
 * vulnerability below returns a *hash* and a token, which is the realistic leak and is
 * still synthetic.
 */
import { IDENTITIES, createSecurityLab, findIdentity } from '../shared/security-lab.js';

const PORT = Number(process.env.AUTH_LAB_PORT ?? 4400);

const app = createSecurityLab({
  name: 'AIRA Authentication Lab',
  vulnerabilities: [
    { id: 'VULN_USER_ENUMERATION', description: 'Sign-in says whether the username exists, so accounts can be enumerated.' },
    { id: 'VULN_NO_LOCKOUT', description: 'Repeated failed sign-ins are never throttled or locked out.' },
    { id: 'VULN_SESSION_SURVIVES_LOGOUT', description: 'A session token keeps working after sign-out.' },
    { id: 'VULN_LONG_SESSION', description: 'Sessions are issued with a 30-day lifetime.' },
    { id: 'VULN_RESET_TOKEN_REUSE', description: 'A password-reset token can be used more than once and never expires.' }
  ]
});

app.use(ctx => { app.writeSecurityHeaders(ctx); });

let failedAttempts = 0;
const resetTokens = new Map();
const publicUser = i => ({ id: i.id, username: i.username, role: i.role, displayName: i.displayName });

app.post('/api/session', async ctx => {
  const { username, password } = await ctx.body();
  const name = String(username ?? '');
  const identity = findIdentity(name);

  if (!app.faults.on('VULN_NO_LOCKOUT') && !app.faults.on('DISABLE_RATE_LIMIT')) {
    if (failedAttempts >= 5) {
      return ctx.json(429, { error: 'too_many_attempts', message: 'Account temporarily locked.' });
    }
  }

  if (!identity || identity.password !== password) {
    failedAttempts += 1;
    // The enumeration flaw: a distinguishable answer tells an attacker which usernames are
    // real, which is the whole value of the endpoint to them.
    if (app.faults.on('VULN_USER_ENUMERATION')) {
      return ctx.json(401, identity
        ? { error: 'invalid_password', message: `The password for ${name} is incorrect.` }
        : { error: 'unknown_user', message: `No account named ${name}.` });
    }
    return ctx.json(401, { error: 'invalid_credentials', message: 'The username or password is incorrect.' });
  }

  failedAttempts = 0;
  const ttl = app.faults.on('VULN_LONG_SESSION') ? 60 * 60 * 24 * 30 : 900;
  const session = app.signIn(ctx, identity, { ttlSeconds: ttl });

  const body = { user: publicUser(identity), csrfToken: session.csrf, expiresInSeconds: ttl };
  if (app.faults.on('EXPOSE_SENSITIVE_RESPONSE')) {
    // A password hash and a bearer token in a sign-in response. Synthetic, and exactly the
    // shape of leak the sensitive-data detector has to notice.
    body.passwordHash = '$2b$12$syntheticsynthetichashvaluefortestingonly000000';
    body.apiToken = 'sk_test_synthetic_4f8a2c9e1b7d3a5f6c0e';
  }
  return ctx.json(200, body);
});

app.delete('/api/session', ctx => {
  const token = ctx.cookies.session;
  if (app.faults.on('VULN_SESSION_SURVIVES_LOGOUT')) {
    // The cookie is cleared, so the browser forgets — but the token keeps working for
    // anyone who kept a copy, which is the actual failure.
    ctx.res.setHeader('Set-Cookie', 'session=; Path=/; Max-Age=0');
    return ctx.json(204, {});
  }
  if (token) app.sessions.delete(token);
  ctx.res.setHeader('Set-Cookie', 'session=; Path=/; Max-Age=0');
  return ctx.json(204, {});
});

app.get('/api/session', ctx => {
  const identity = app.currentIdentity(ctx);
  if (!identity) return ctx.json(401, { error: 'unauthenticated' });
  return ctx.json(200, { user: publicUser(identity) });
});

app.get('/api/profile', ctx => {
  const identity = app.currentIdentity(ctx);
  if (!identity) return ctx.json(401, { error: 'unauthenticated' });
  return ctx.json(200, { profile: publicUser(identity) });
});

// ---- Password reset --------------------------------------------------------

app.post('/api/password-reset', async ctx => {
  const { username } = await ctx.body();
  const identity = findIdentity(String(username ?? ''));
  // Always 202, whether or not the account exists: not leaking here is correct behaviour,
  // and a lab that got everything wrong would not test a detector's precision.
  if (identity) {
    const token = `reset-${Math.random().toString(36).slice(2, 18)}`;
    resetTokens.set(token, { user: identity.id, used: false, expiresAt: Date.now() + 15 * 60 * 1000 });
    return ctx.json(202, { accepted: true, resetToken: token, note: 'Synthetic lab: the token is returned rather than emailed.' });
  }
  return ctx.json(202, { accepted: true });
});

app.post('/api/password-reset/confirm', async ctx => {
  const { token } = await ctx.body();
  const entry = resetTokens.get(String(token ?? ''));
  if (!entry) return ctx.json(400, { error: 'invalid_token' });

  if (!app.faults.on('VULN_RESET_TOKEN_REUSE')) {
    if (entry.used) return ctx.json(400, { error: 'token_already_used' });
    if (entry.expiresAt < Date.now()) return ctx.json(400, { error: 'token_expired' });
  }
  entry.used = true;
  return ctx.json(200, { reset: true, user: entry.user, note: 'Synthetic. No password was changed.' });
});

app.get('/', ctx => ctx.html(200, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Authentication Lab</title></head>
<body>
  <h1>Authentication Lab</h1>
  <p>Deliberately vulnerable. Synthetic identities only.</p>
  <form method="post" action="/api/session">
    <label for="username">Username</label><input id="username" name="username" data-testid="username">
    <label for="password">Password</label><input id="password" name="password" type="password" data-testid="password">
    <button type="submit" data-testid="login-submit">Sign in</button>
  </form>
</body></html>`));

app.post('/__reset', ctx => {
  app.resetSessions(); failedAttempts = 0; resetTokens.clear();
  return ctx.json(200, { reset: true });
});

await app.listen(PORT);
