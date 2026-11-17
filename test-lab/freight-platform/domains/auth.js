/**
 * Sign-in, multi-factor, password recovery and the account screens.
 *
 * Carries FP_D30: the "remember me" branch builds its Set-Cookie header by hand and loses
 * HttpOnly. The ordinary branch uses ctx.setCookie and keeps it, so the same application
 * is both correct and wrong depending on a checkbox, which is how this defect usually
 * reaches production.
 */
import { escapeHtml } from '../../shared/http.js';
import { shell, field, h, table, kv, tabs, statusPill, dateTime } from '../ui/chrome.js';

export const SCREENS = [
  { path: '/auth/sign-in', title: 'Sign in', kind: 'form', anonymous: true },
  { path: '/auth/mfa', title: 'Two-factor code', kind: 'form', anonymous: true },
  { path: '/auth/forgot-password', title: 'Forgotten password', kind: 'form', anonymous: true },
  { path: '/auth/reset-password', title: 'Choose a new password', kind: 'form', anonymous: true },
  { path: '/account/profile', title: 'Your profile', kind: 'form' },
  { path: '/account/preferences', title: 'Preferences', kind: 'form' },
  { path: '/account/sessions', title: 'Active sessions', kind: 'list' }
];

export default function registerAuth({ app, core, state, faults, sessions }) {
  const { definePage, csrfField, csrfValid, setFlash, currentUser } = core;

  // ---- sign in ------------------------------------------------------------

  /** Rendered without the shell: a sign-in page has no sidebar to show. */
  const signInPage = (ctx, { error = '', username = '' } = {}) => {
    const reason = ctx.query.reason;
    const notice = reason === 'expired' ? 'Your session timed out. Sign in again to continue.'
      : reason === 'signedOut' ? 'You have been signed out.'
      : '';
    return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in · Meridian Freight</title>
<style>${AUTH_CSS}</style></head><body>
<main class="auth-card">
<h1>Meridian Freight</h1>
<p class="sub">Operations console</p>
${notice ? `<div class="flash flash-info" role="status" data-testid="flash">${h(notice)}</div>` : ''}
${error ? `<div class="flash flash-error" role="alert" data-testid="sign-in-error">${h(error)}</div>` : ''}
<form method="post" action="/auth/sign-in" data-testid="sign-in-form" novalidate>
${csrfField(ctx)}
<input type="hidden" name="next" value="${h(ctx.query.next ?? '/dashboard')}" />
${field({ name: 'username', label: 'Username', required: true, value: username, testId: 'username', attrs: { autocomplete: 'username' } })}
${field({ name: 'password', label: 'Password', type: 'password', required: true, testId: 'password', attrs: { autocomplete: 'current-password' } })}
${field({ name: 'remember', label: 'Keep me signed in on this device', type: 'checkbox', testId: 'remember' })}
<button class="btn" type="submit" data-testid="sign-in-submit">Sign in</button>
</form>
<p class="links"><a href="/auth/forgot-password" data-testid="forgot-password-link">Forgotten your password?</a></p>
<p class="lab-note">Synthetic lab. Accounts: ops.lead, warehouse, finance, customs, admin, readonly, driver.ops — password <code>Freight!2026</code>.</p>
</main></body></html>`;
  };

  app.get('/auth/sign-in', ctx => ctx.html(200, signInPage(ctx)));

  app.post('/auth/sign-in', async (ctx) => {
    const body = await ctx.body();
    if (!await csrfValid(ctx)) {
      return ctx.html(403, signInPage(ctx, { error: 'Your session expired before the form was sent. Try again.' }));
    }

    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');
    if (!username || !password) {
      return ctx.html(400, signInPage(ctx, { error: 'Enter both a username and a password.', username }));
    }

    const account = state.users.find(candidate => candidate.username === username);
    if (account?.status === 'suspended') {
      return ctx.html(403, signInPage(ctx, { error: 'This account is suspended. Contact an administrator.', username }));
    }

    const result = sessions.signIn(state.users, username, password);
    if (!result.ok) {
      const message = result.reason === 'locked'
        ? `Too many failed attempts. Try again in ${Math.ceil((result.retryInMs ?? 0) / 60000)} minutes.`
        : 'That username and password do not match.';
      return ctx.html(401, signInPage(ctx, { error: message, username }));
    }

    const remember = body.remember === 'on' || body.remember === 'true';

    if (remember && faults.on('FP_D30_SESSION_COOKIE_FLAGS')) {
      // FP_D30 — the header is assembled here rather than through ctx.setCookie, and
      // HttpOnly is lost. A real instance of this is a "remember me" feature added later
      // by someone who copied the cookie string from a blog post.
      ctx.res.setHeader('Set-Cookie', `lab_session=${result.token}; Path=/; Max-Age=2592000; SameSite=Lax`);
    } else {
      ctx.setCookie('lab_session', result.token, { maxAge: remember ? 2_592_000 : undefined });
    }

    if (account.mfa) {
      ctx.setCookie('lab_mfa_pending', '1');
      return ctx.redirect('/auth/mfa');
    }

    const next = String(body.next ?? '/dashboard');
    return ctx.redirect(next.startsWith('/') ? next : '/dashboard');
  });

  app.post('/auth/sign-out', (ctx) => {
    sessions.signOut?.(ctx.cookies.lab_session);
    ctx.clearCookie('lab_session');
    ctx.clearCookie('lab_mfa_pending');
    ctx.redirect('/auth/sign-in?reason=signedOut');
  });

  // ---- multi-factor -------------------------------------------------------

  definePage({
    path: '/auth/mfa', domain: 'dashboard', title: 'Two-factor code', kind: 'form', anonymous: true,
    view: (ctx) => ({
      title: 'Two-factor code',
      body: `<div class="panel" style="max-width:420px">
<p>A six digit code was sent to the number on your account. In this lab the code is always <code>246810</code>.</p>
<form method="post" action="/auth/mfa" data-testid="mfa-form">
${csrfField(ctx)}
${field({ name: 'code', label: 'Authentication code', required: true, testId: 'mfa-code',
  attrs: { inputmode: 'numeric', pattern: '[0-9]{6}', maxlength: '6', autocomplete: 'one-time-code' },
  hint: 'Six digits.' })}
${ctx.query.error ? '<div class="error" role="alert" data-testid="mfa-error">That code is not correct.</div>' : ''}
<button class="btn" type="submit" data-testid="mfa-submit">Verify</button>
</form></div>`
    })
  });

  app.post('/auth/mfa', async (ctx) => {
    const body = await ctx.body();
    if (String(body.code ?? '') !== '246810') return ctx.redirect('/auth/mfa?error=1');
    ctx.clearCookie('lab_mfa_pending');
    return ctx.redirect('/dashboard');
  });

  // ---- password recovery --------------------------------------------------

  definePage({
    path: '/auth/forgot-password', domain: 'dashboard', title: 'Forgotten password', kind: 'form', anonymous: true,
    view: (ctx) => ({
      title: 'Forgotten password',
      body: `<div class="panel" style="max-width:460px">
<p>Enter the email address on your account and a reset link will be sent.</p>
<form method="post" action="/auth/forgot-password" data-testid="forgot-form">
${csrfField(ctx)}
${field({ name: 'email', label: 'Email address', type: 'email', required: true, testId: 'forgot-email',
  attrs: { autocomplete: 'email' }, hint: 'The address you sign in with.' })}
<button class="btn" type="submit" data-testid="forgot-submit">Send reset link</button>
</form>
${ctx.query.sent ? '<div class="flash flash-success" role="status" data-testid="forgot-sent" style="margin-top:12px">If that address has an account, a reset link is on its way.</div>' : ''}
</div>`
    })
  });

  app.post('/auth/forgot-password', async (ctx) => {
    // Deliberately correct: the same answer whether or not the address exists, so the
    // form does not enumerate accounts. Present so the lab is not uniformly broken.
    await ctx.body();
    ctx.redirect('/auth/forgot-password?sent=1');
  });

  definePage({
    path: '/auth/reset-password', domain: 'dashboard', title: 'Choose a new password', kind: 'form', anonymous: true,
    view: (ctx) => ({
      title: 'Choose a new password',
      body: `<div class="panel" style="max-width:460px">
<form method="post" action="/auth/reset-password" data-testid="reset-form">
${csrfField(ctx)}
<input type="hidden" name="token" value="${h(ctx.query.token ?? 'lab-reset-token')}" />
${field({ name: 'password', label: 'New password', type: 'password', required: true, testId: 'new-password',
  attrs: { minlength: '12', autocomplete: 'new-password' },
  hint: 'At least 12 characters, including a number and a symbol.' })}
${field({ name: 'confirm', label: 'Confirm new password', type: 'password', required: true, testId: 'confirm-password',
  attrs: { minlength: '12', autocomplete: 'new-password' } })}
<button class="btn" type="submit" data-testid="reset-submit">Set password</button>
</form></div>`
    })
  });

  app.post('/auth/reset-password', async (ctx) => {
    const body = await ctx.body();
    const password = String(body.password ?? '');
    const confirm = String(body.confirm ?? '');
    if (password.length < 12) {
      setFlash(ctx, 'error', 'The password must be at least 12 characters.');
      return ctx.redirect('/auth/reset-password');
    }
    // Correct: the confirmation is compared. The registration-style mismatch defect lives
    // in the form lab, not here, and duplicating it would teach nothing new.
    if (password !== confirm) {
      setFlash(ctx, 'error', 'The two passwords do not match.');
      return ctx.redirect('/auth/reset-password');
    }
    setFlash(ctx, 'success', 'Your password has been changed. Sign in with it.');
    return ctx.redirect('/auth/sign-in');
  });

  // ---- account ------------------------------------------------------------

  definePage({
    path: '/account/profile', domain: 'dashboard', title: 'Your profile', kind: 'form',
    view: (ctx, user) => ({
      title: 'Your profile',
      breadcrumbs: [{ label: 'Dashboard', href: '/dashboard' }, { label: 'Your profile' }],
      body: `<div class="panel" style="max-width:560px">
<form method="post" action="/account/profile" data-testid="profile-form">
${csrfField(ctx)}
${field({ name: 'displayName', label: 'Display name', value: user.displayName, required: true, testId: 'display-name' })}
${field({ name: 'email', label: 'Email address', type: 'email', value: user.email, required: true, testId: 'email' })}
${field({ name: 'phone', label: 'Mobile number', type: 'tel', value: '+44 7700 900000', testId: 'phone',
  hint: 'Used for two-factor codes and delivery exceptions.' })}
${field({ name: 'team', label: 'Team', value: user.team, attrs: { readonly: true }, testId: 'team',
  hint: 'Changed by an administrator.' })}
<button class="btn" type="submit" data-testid="profile-save">Save changes</button>
</form></div>`
    })
  });

  app.post('/account/profile', async (ctx) => {
    const user = core.requireAuth(ctx);
    if (!user) return;
    const body = await ctx.body();
    const displayName = String(body.displayName ?? '').trim();
    if (!displayName) {
      setFlash(ctx, 'error', 'A display name is required.');
      return ctx.redirect('/account/profile');
    }
    user.displayName = displayName;
    user.email = String(body.email ?? user.email).trim();
    setFlash(ctx, 'success', 'Your profile has been saved.');
    return ctx.redirect('/account/profile');
  });

  definePage({
    path: '/account/preferences', domain: 'dashboard', title: 'Preferences', kind: 'form',
    view: (ctx, user) => ({
      title: 'Preferences',
      breadcrumbs: [{ label: 'Dashboard', href: '/dashboard' }, { label: 'Preferences' }],
      body: `<div class="panel" style="max-width:560px">
<form method="post" action="/account/preferences" data-testid="preferences-form">
${csrfField(ctx)}
${field({ name: 'landingPage', label: 'Open this section when I sign in', options: [
  { value: '/dashboard', label: 'Dashboard' }, { value: '/shipments', label: 'Shipments' },
  { value: '/orders', label: 'Orders' }, { value: '/warehouse', label: 'Warehouse' }
], value: '/dashboard', testId: 'landing-page' })}
${field({ name: 'density', label: 'Table density', options: ['comfortable', 'compact'], value: 'comfortable', testId: 'density' })}
${field({ name: 'weightUnit', label: 'Show weights in', options: ['kg', 'lb'], value: 'kg', testId: 'weight-unit' })}
${field({ name: 'emailExceptions', label: 'Email me when a shipment raises an exception', type: 'checkbox', value: true, testId: 'email-exceptions' })}
${field({ name: 'emailDigest', label: 'Send me the daily summary', type: 'checkbox', value: true, testId: 'email-digest' })}
<button class="btn" type="submit" data-testid="preferences-save">Save preferences</button>
</form></div>`
    })
  });

  app.post('/account/preferences', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    await ctx.body();
    setFlash(ctx, 'success', 'Preferences saved.');
    return ctx.redirect('/account/preferences');
  });

  definePage({
    path: '/account/sessions', domain: 'dashboard', title: 'Active sessions', kind: 'list',
    view: (ctx, user) => {
      const rows = [
        { device: 'Chrome on Windows', location: 'Felixstowe, GB', ip: '203.0.113.17', startedAt: user.lastSeenAt, current: true },
        { device: 'Safari on iPhone', location: 'Ipswich, GB', ip: '203.0.113.92', startedAt: user.lastSeenAt, current: false },
        { device: 'Edge on Windows', location: 'Rotterdam, NL', ip: '203.0.113.211', startedAt: user.lastSeenAt, current: false }
      ];
      return {
        title: 'Active sessions',
        breadcrumbs: [{ label: 'Dashboard', href: '/dashboard' }, { label: 'Active sessions' }],
        body: `<div class="panel">
<p class="hint">Signing out of a session ends it on that device immediately.</p>
${table({
  caption: 'Sessions currently signed in to your account', testId: 'sessions-table',
  columns: [
    { header: 'Device', cell: row => `${h(row.device)}${row.current ? ' <span class="pill pill-info">This device</span>' : ''}` },
    { header: 'Location', cell: row => h(row.location) },
    { header: 'IP address', cell: row => h(row.ip) },
    { header: 'Started', cell: row => dateTime(row.startedAt) },
    { header: '', cell: row => row.current ? '' :
      `<form method="post" action="/account/sessions/end" style="margin:0">${csrfField(ctx)}
       <input type="hidden" name="ip" value="${h(row.ip)}" />
       <button class="btn btn-secondary" type="submit" data-testid="end-session-${h(row.ip)}">End</button></form>` }
  ],
  rows
})}</div>`
      };
    }
  });

  app.post('/account/sessions/end', async (ctx) => {
    if (!core.requireAuth(ctx)) return;
    await ctx.body();
    setFlash(ctx, 'success', 'That session has been ended.');
    return ctx.redirect('/account/sessions');
  });
}

const AUTH_CSS = `
:root{--ink:#131a26;--muted:#5d6b80;--line:#dfe5ee;--accent:#1457d6;--danger:#b32020;--ok:#0f7a52}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(160deg,#10243f,#1d3b63);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);padding:20px}
.auth-card{background:#fff;border-radius:12px;padding:30px;width:100%;max-width:400px;box-shadow:0 18px 46px rgba(8,20,38,.3)}
h1{font-size:21px;margin:0}
.sub{color:var(--muted);margin:3px 0 20px;font-size:13.5px}
.field{margin-bottom:13px}
.field label{display:block;font-size:13px;font-weight:600;margin-bottom:4px}
input[type=text],input[type=email],input[type=password]{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:6px;font:inherit;font-size:14px}
input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
input[aria-invalid=true]{border-color:var(--danger)}
.btn{width:100%;background:var(--accent);color:#fff;border:0;padding:10px;border-radius:6px;font:inherit;font-size:14.5px;font-weight:600;cursor:pointer;margin-top:4px}
.btn:hover{filter:brightness(1.08)}
.flash{padding:9px 12px;border-radius:6px;margin-bottom:14px;font-size:13.5px;border:1px solid}
.flash-error{background:#fdeaea;color:var(--danger);border-color:#f3c4c4}
.flash-info{background:#e9eefc;color:var(--accent);border-color:#c5d4f6}
.flash-success{background:#e7f6ef;color:var(--ok);border-color:#b9e4d1}
.hint{font-size:12px;color:var(--muted);margin-top:3px}
.error{color:var(--danger);font-size:12.5px;margin-top:3px}
.links{margin:16px 0 0;font-size:13.5px;text-align:center}
.links a{color:var(--accent)}
.lab-note{margin:18px 0 0;font-size:11.5px;color:var(--muted);border-top:1px solid var(--line);padding-top:12px;line-height:1.5}
.required-mark{color:var(--danger);margin-left:2px}
`;
