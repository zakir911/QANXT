/**
 * The locator laboratory.
 *
 * One small application whose only job is to change the way its controls are addressed,
 * one variable at a time, so that healing can be measured rather than described.
 *
 * The cases it can present:
 *
 *   baseline              the control is where the test left it
 *   renamed               same control, new label and new test id      → healing is correct
 *   test id only          same label, new test id                      → healing is correct
 *   moved into a dialog   same control, now behind a button            → healing is correct
 *   removed               no control performs that function any more   → healing must be refused
 *   ambiguous             two equally plausible controls               → healing must be refused
 *   meaning changed       same label, different behaviour              → healing must be refused
 *   decoy                 an unrelated button in the same position     → healing must be refused
 *
 * The last four are the ones that matter. A healer that finds something in each of them is
 * not resilient; it is dangerous, because it turns a broken application into a green run.
 */
import { createLabApp, escapeHtml } from '../shared/http.js';
import { createFaultEngine } from '../shared/faults.js';
import { SESSION_COOKIE, createSessionStore } from '../shared/sessions.js';
import { layout } from '../shared/render.js';

const PORT = Number(process.env.HEALING_PORT ?? 4350);
const APPLICATION = 'AIRA Locator Lab';

const FAULTS = [
  { id: 'FAULT_LOGIN_BUTTON_RENAMED', description: 'The submit control is relabelled "Sign In" and its test id becomes signin-submit.' },
  { id: 'FAULT_LOGIN_BUTTON_REMOVED', description: 'No control submits the form. Healing must be refused.' },
  { id: 'FAULT_TESTID_ONLY_CHANGED', description: 'The label stays "Log in"; only the test id changes.' },
  { id: 'FAULT_CONTROL_MOVED_TO_DIALOG', description: 'Submitting now happens inside a dialog opened by a "Continue" button.' },
  { id: 'FAULT_AMBIGUOUS_CONTROLS', description: 'Two equally plausible submit controls exist. Healing must be refused.' },
  { id: 'FAULT_MEANING_CHANGED', description: 'A control labelled "Log in" now cancels instead of signing in. Healing must be refused.' },
  { id: 'FAULT_DECOY_CONTROL', description: 'An unrelated button takes the submit control\'s place. Healing must be refused.' },
  { id: 'FAULT_SLOW_ELEMENT', description: 'The submit control is rendered after a delay.' }
];

const faults = createFaultEngine(FAULTS, { parameters: { slowElementMs: 4000 } });
const sessions = createSessionStore({ maxFailedAttempts: 99 });
const USERS = [{ id: 'usr-lab', username: 'alice', password: 'Password123!', displayName: 'Alice Fernsby' }];

const app = createLabApp({ name: APPLICATION, version: '1.0.0', faults });

// ---------------------------------------------------------------------------
// The sign-in page — the only page whose controls drift
// ---------------------------------------------------------------------------

app.get('/', ctx => ctx.redirect('/login'));

app.get('/login', (ctx) => {
  const error = ctx.query.error;
  ctx.html(200, layout({
    title: 'Sign in',
    application: APPLICATION,
    body: `
<h1 data-testid="page-title">Sign in</h1>
<p class="muted">The control below is the subject of every healing measurement. What it looks like depends on which fault is enabled; the form around it never changes.</p>

<form method="post" action="/login" class="card" data-testid="login-form" style="max-width:420px">
  <div class="field">
    <label for="username">Username</label>
    <input id="username" name="username" autocomplete="username" data-testid="username" required />
  </div>
  <div class="field">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" data-testid="password" required />
  </div>
  ${submitArea()}
  ${error ? `<p class="error" role="alert" data-testid="login-error">${escapeHtml(errorText(error))}</p>` : ''}
</form>

<p class="muted">Signed-in state is verified by the presence of <code>welcome-heading</code> on /welcome.</p>
${faults.on('FAULT_CONTROL_MOVED_TO_DIALOG') ? DIALOG_SCRIPT : ''}
`
  }));
});

/**
 * Renders whichever submit area the enabled fault calls for.
 *
 * Each branch is deliberately complete: the healthy control disappears when a fault
 * replaces it, so a test cannot pass by accidentally finding the old one still present.
 */
function submitArea() {
  if (faults.on('FAULT_LOGIN_BUTTON_REMOVED')) {
    return `<p class="notice" data-testid="signin-unavailable">Sign-in is temporarily unavailable.</p>`;
  }

  if (faults.on('FAULT_AMBIGUOUS_CONTROLS')) {
    // Two controls, equally plausible, doing different things. Nothing on the page says
    // which one the original test meant, so nothing can safely choose for it.
    return `
<div class="row">
  <button type="submit" name="mode" value="personal" class="primary" data-testid="submit-personal">Log in to personal banking</button>
  <button type="submit" name="mode" value="business" class="primary" data-testid="submit-business">Log in to business banking</button>
</div>`;
  }

  if (faults.on('FAULT_MEANING_CHANGED')) {
    // Same words, opposite behaviour. Matching on the label alone gets this wrong.
    return `
<button type="button" class="primary" data-testid="cancel-control"
        onclick="window.location.href='/cancelled'">Log in</button>
<p class="muted">(This control abandons the sign-in.)</p>`;
  }

  if (faults.on('FAULT_DECOY_CONTROL')) {
    return `
<button type="button" class="primary" data-testid="marketing-cta"
        onclick="window.location.href='/offers'">See our new savings rates</button>`;
  }

  if (faults.on('FAULT_CONTROL_MOVED_TO_DIALOG')) {
    return `
<button type="button" class="primary" data-testid="continue-control">Continue</button>
<div id="dialog" hidden>
  <div class="modal-backdrop" data-testid="signin-dialog">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Confirm sign in">
      <h2>Confirm sign in</h2>
      <p class="muted">Press the button below to finish signing in.</p>
      <button type="submit" class="primary" data-testid="dialog-submit">Log in</button>
    </div>
  </div>
</div>`;
  }

  if (faults.on('FAULT_LOGIN_BUTTON_RENAMED')) {
    return `<button type="submit" class="primary" data-testid="signin-submit">Sign In</button>`;
  }

  if (faults.on('FAULT_TESTID_ONLY_CHANGED')) {
    return `<button type="submit" class="primary" data-testid="auth-submit-v2">Log in</button>`;
  }

  if (faults.on('FAULT_SLOW_ELEMENT')) {
    const delay = faults.parameter('slowElementMs');
    return `
<span data-testid="submit-pending" class="muted">Preparing sign-in…</span>
<span id="late"></span>
<script>
  setTimeout(() => {
    document.getElementById('late').innerHTML =
      '<button type="submit" class="primary" data-testid="login-submit">Log in</button>';
    document.querySelector('[data-testid="submit-pending"]').remove();
  }, ${delay});
</script>`;
  }

  return `<button type="submit" class="primary" data-testid="login-submit">Log in</button>`;
}

const DIALOG_SCRIPT = `
<script>
  document.querySelector('[data-testid="continue-control"]').addEventListener('click', () => {
    document.getElementById('dialog').hidden = false;
  });
</script>`;

function errorText(code) {
  return code === 'credentials'
    ? 'That username and password do not match.'
    : 'Enter your username and password.';
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

app.post('/login', async (ctx) => {
  const body = await ctx.body();
  if (!body.username || !body.password) return ctx.redirect('/login?error=missing', 303);

  const result = sessions.signIn(USERS, String(body.username), String(body.password));
  if (!result.ok) return ctx.redirect('/login?error=credentials', 303);

  ctx.setCookie(SESSION_COOKIE, result.token, { maxAge: 3600 });
  // The business/personal split only exists under the ambiguous fault; recording which
  // control was pressed is what lets a test prove the wrong one was chosen.
  const mode = body.mode ? `?mode=${encodeURIComponent(body.mode)}` : '';
  return ctx.redirect(`/welcome${mode}`, 303);
});

app.get('/welcome', (ctx) => {
  const { session } = sessions.resolve(ctx.cookies[SESSION_COOKIE]);
  if (!session) return ctx.redirect('/login', 303);

  ctx.html(200, layout({
    title: 'Welcome',
    application: APPLICATION,
    body: `
<h1 data-testid="welcome-heading">You are signed in</h1>
<p data-testid="welcome-message">Welcome back, ${escapeHtml(session.username)}.</p>
${ctx.query.mode ? `<p class="pill" data-testid="welcome-mode">${escapeHtml(ctx.query.mode)} banking</p>` : ''}
<p><a href="/logout" data-testid="logout">Sign out</a></p>`
  }));
});

/** Where the meaning-changed control leads: signed out, and saying so. */
app.get('/cancelled', ctx => ctx.html(200, layout({
  title: 'Cancelled',
  application: APPLICATION,
  body: `<h1 data-testid="cancelled-heading">Sign-in cancelled</h1>
<p data-testid="cancelled-message">You are not signed in. Nothing was submitted.</p>
<p><a href="/login" data-testid="back-to-login">Back to sign in</a></p>`
})));

/** Where the decoy leads. */
app.get('/offers', ctx => ctx.html(200, layout({
  title: 'Savings rates',
  application: APPLICATION,
  body: `<h1 data-testid="offers-heading">Our savings rates</h1>
<p data-testid="offers-message">You are not signed in. This is a marketing page.</p>
<p><a href="/login" data-testid="back-to-login">Back to sign in</a></p>`
})));

app.get('/logout', (ctx) => {
  sessions.signOut(ctx.cookies[SESSION_COOKIE]);
  ctx.clearCookie(SESSION_COOKIE);
  ctx.redirect('/login', 303);
});

app.post('/__reset', ctx => ctx.json(200, { reset: true, faults: faults.reset() }));

await app.listen(PORT);
