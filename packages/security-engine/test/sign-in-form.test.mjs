import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSignInForm } from '../src/engine.mjs';

/**
 * Reading an application's own sign-in form.
 *
 * This exists because the scanner used to sign in by POSTing JSON to a hard-coded
 * `/api/session`. Meridian Freight is an ordinary form-login application: that endpoint
 * 404s, all three identities failed, and every authorization check reported "an owning
 * identity is needed" — 66 of the 204 findings that scan could not establish, including
 * both planted authorization defects. A scanner that can only sign in to one convention
 * cannot test authorization on most web applications.
 */

/**
 * The freight lab's sign-in form, copied verbatim from the running application.
 *
 * Inlined rather than fetched: a test that needs a server running is a test that gets
 * skipped, and this is the exact markup the scanner could not read.
 */
const LAB = `<form method="post" action="/auth/sign-in" data-testid="sign-in-form" novalidate>
<input type="hidden" name="_csrf" value="csrf-616e6f6e796d6f7573" data-testid="csrf" />
<input type="hidden" name="next" value="/dashboard" />
<div class="field">
<label for="f-username">Username<span class="required-mark" aria-hidden="true">*</span></label>
<input type="text" id="f-username" name="username" data-testid="username" required autocomplete="username" value="" />
      </div>
<div class="field">
<label for="f-password">Password<span class="required-mark" aria-hidden="true">*</span></label>
<input type="password" id="f-password" name="password" data-testid="password" required autocomplete="current-password" value="" />
      </div>
<div class="field"><label for="f-remember" style="display:flex;gap:8px;align-items:center;font-weight:500">
      <input type="checkbox" id="f-remember" name="remember" data-testid="remember"  style="width:auto" />Keep me signed in on this device</label>
      </div>
<button class="btn" type="submit" data-testid="sign-in-submit">Sign in</button>
</form>`;

test('reads the freight lab\'s real sign-in form', () => {
  const form = readSignInForm(LAB, 'ops.lead', 'Freight!2026');

  assert.notEqual(form, null, 'the form the scanner failed to find for the whole measurement');
  assert.equal(form.action, '/auth/sign-in');
  assert.equal(form.method, 'POST');
  assert.equal(form.fields['username'], 'ops.lead');
  assert.equal(form.fields['password'], 'Freight!2026');
});

test('carries a hidden field through unchanged', () => {
  // Not a nicety: an application that verifies an anti-forgery token refuses a submission
  // without one, and that refusal is indistinguishable from a wrong password — so the scan
  // reports "could not sign in" for credentials that were perfectly good.
  const form = readSignInForm(`
    <form method="post" action="/login">
      <input type="hidden" name="__RequestVerificationToken" value="tok-abc" />
      <input name="username" /><input type="password" name="password" />
      <button type="submit">Sign in</button>
    </form>`, 'u', 'p');

  assert.equal(form.fields['__RequestVerificationToken'], 'tok-abc');
});

test('ignores a form with no password field', () => {
  // Guessing a sign-in page from its URL alone put credentials into search boxes.
  assert.equal(readSignInForm(`
    <form action="/search" method="get"><input name="q" /></form>`, 'u', 'p'), null);
});

test('picks the sign-in form out of a page that has several forms', () => {
  const form = readSignInForm(`
    <form action="/search" method="get"><input name="q" /></form>
    <form action="/auth/login" method="post">
      <input name="email" /><input type="password" name="pw" />
    </form>`, 'someone@example.test', 'secret');

  assert.equal(form.action, '/auth/login');
  assert.equal(form.fields['email'], 'someone@example.test');
  assert.equal(form.fields['pw'], 'secret');
});

test('finds the identity field under any of the usual names', () => {
  for (const name of ['username', 'user', 'email', 'login', 'identifier', 'userid']) {
    const form = readSignInForm(
      `<form action="/l" method="post"><input name="${name}" /><input type="password" name="p" /></form>`,
      'who', 'pw');
    assert.equal(form.fields[name], 'who', `identity field "${name}"`);
  }
});

test('falls back to the one text input that is not the password', () => {
  const form = readSignInForm(`
    <form action="/l" method="post">
      <input type="text" name="staff_number" /><input type="password" name="secret" />
    </form>`, '4417', 'pw');

  assert.equal(form.fields['staff_number'], '4417');
});

test('does not send a checkbox the user did not tick', () => {
  // "Remember me" changes what the application does with the session; a scanner must not
  // silently opt into it.
  const form = readSignInForm(`
    <form action="/l" method="post">
      <input name="username" /><input type="password" name="password" />
      <input type="checkbox" name="remember" value="1" />
    </form>`, 'u', 'p');

  assert.equal('remember' in form.fields, false);
});

test('keeps a GET form a GET', () => {
  const form = readSignInForm(`
    <form action="/l" method="GET"><input name="username" /><input type="password" name="p" /></form>`,
    'u', 'pw');
  assert.equal(form.method, 'GET');
});

test('defaults to POST when the form does not say', () => {
  const form = readSignInForm(`
    <form action="/l"><input name="username" /><input type="password" name="p" /></form>`, 'u', 'pw');
  assert.equal(form.method, 'POST');
});

test('reads single-quoted and unquoted attributes', () => {
  const form = readSignInForm(`
    <form action='/auth' method=post>
      <input name='username'><input type=password name=password>
    </form>`, 'u', 'pw');

  assert.equal(form.action, '/auth');
  assert.equal(form.method, 'POST');
  assert.equal(form.fields['username'], 'u');
});

test('returns null rather than guessing when there is no form at all', () => {
  assert.equal(readSignInForm('<p>Signed out.</p>', 'u', 'p'), null);
});
