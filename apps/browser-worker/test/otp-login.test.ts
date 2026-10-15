import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { BrowserContext } from 'playwright';
import { BrowserPool } from '../src/browser/browser-pool.js';
import { Logger } from '../src/util/logger.js';
import { performLogin } from '../src/browser/authenticator.js';
import { base32Decode, totp } from '../src/browser/totp.js';

// The RFC 6238 test secret, "12345678901234567890", in base32.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('TOTP', () => {
  test('matches the RFC 6238 SHA-1 test vectors', () => {
    expect(base32Decode(RFC_SECRET).toString()).toBe('12345678901234567890');
    expect(totp(RFC_SECRET, 59_000, 30, 8)).toBe('94287082');
    expect(totp(RFC_SECRET, 1_111_111_109_000, 30, 8)).toBe('07081804');
    expect(totp(RFC_SECRET, 1_234_567_890_000, 30, 8)).toBe('89005924');
  });

  test('a secret that is not base32 is refused with a reason', () => {
    expect(() => totp('not-base32!!')).toThrow(/base32/);
  });
});

/**
 * A sign-in that asks for a code after the password, the way real applications do: a
 * server-rendered page with one field, and a page of single-digit boxes.
 */
function otpSite(): Server {
  const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const send = (html: string) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end(html); };
    const code = () => url.searchParams.get('code') ?? [1, 2, 3, 4, 5, 6].map(i => url.searchParams.get(`d${i}`) ?? '').join('');
    const expected = url.searchParams.get('style') === 'totp' ? totp(RFC_SECRET) : '246810';

    // A single-page application that renders its form two seconds after load.
    if (url.pathname === '/spa-login') {
      return send(page(`<div id="root">Loading…</div><script>
        setTimeout(() => { document.getElementById('root').innerHTML =
          '<form action="/otp" method="get"><input type="hidden" name="style" value="single">'
          + '<label>User ID <input name="j_uid"></label><label>Secret word <input type="password" name="pw"></label>'
          + '<button type="submit">Login</button></form>'; }, 2000);</script>`));
    }
    // User id first, password on the next screen.
    if (url.pathname === '/two-step') {
      return send(page(`<form action="/two-step-password" method="get"><label>Customer ID <input name="customerId"></label>
        <a href="/help">Forgot customer id?</a><button>Continue</button></form>`));
    }
    if (url.pathname === '/two-step-password') {
      return send(page(`<form action="/otp" method="get"><input type="hidden" name="style" value="single">
        <label>Password <input type="password" name="password"></label><button>Sign in</button></form>`));
    }
    // The form inside an iframe.
    if (url.pathname === '/framed') {
      return send(page(`<h1>Bank</h1><iframe src="/login?style=single" width="600" height="400"></iframe>`));
    }
    // Mobile number, then a code: no password at all.
    if (url.pathname === '/mobile-login') {
      return send(page(`<form action="/otp" method="get"><input type="hidden" name="style" value="single">
        <label>Mobile number <input name="mobile" type="tel"></label><button>Get OTP</button></form>`));
    }
    if (url.pathname === '/not-a-login') {
      return send(page(`<h1>Maintenance</h1><label>Search <input type="search" name="q"></label><button>Go</button>`));
    }
    // Shaped like a retail-banking login: a header full of buttons, a "Login" tab that is
    // disabled because it is the current one, no <form>, and a Continue button that enables
    // only once a user id has been typed (on keyup, for the keystroke variant).
    if (url.pathname === '/bank-login') {
      const event = url.searchParams.get('on') === 'keyup' ? 'keyup' : 'input';
      return send(page(`<header><button>bedtime</button><button>A-</button><button>A</button><button>A+</button>
        <button>Locate us</button><button>Contact us</button></header>
        <nav><button disabled aria-current="page">Login</button></nav>
        <div class="card"><label for="_r_o_">User ID</label><input type="text" name="userid" id="_r_o_">
        <button id="go" disabled>Continue</button><button>Register now</button></div>
        <footer><button>Privacy &amp; cookies policy</button><button>Terms &amp; conditions</button></footer>
        <script>
          const field = document.getElementById('_r_o_'), go = document.getElementById('go');
          field.addEventListener('${event}', () => { go.disabled = field.value.length < 4; });
          go.addEventListener('click', () => { location.href = '/two-step-password?user=' + encodeURIComponent(field.value); });
        </script>`));
    }
    // Code screens with no button at all: the page submits itself once the code is complete.
    // "single" listens for input on one field; "boxes" moves focus box to box on keyup and
    // submits after the last digit, the way most six-box screens behave.
    if (url.pathname === '/auto-otp') {
      const boxes = url.searchParams.get('kind') === 'boxes';
      return send(page(`<header><button onclick="location.href='/auto-login'">Sign in</button></header><h1>Enter the code sent to your phone</h1>
        ${url.searchParams.has('wrong') ? '<p role="alert">Invalid OTP</p>' : ''}
        ${boxes ? [0, 1, 2, 3, 4, 5].map(i => `<input class="d" maxlength="1" inputmode="numeric" aria-label="Digit ${i + 1}">`).join('')
                : '<input id="otp" name="otp" inputmode="numeric" maxlength="6" aria-label="OTP">'}
        <button>Resend OTP</button>
        <script>
          const go = code => { location.href = '/verify?style=single&code=' + code; };
          ${boxes
            ? `const d = Array.from(document.querySelectorAll('.d'));
               d.forEach((box, i) => box.addEventListener('keyup', () => {
                 if (box.value && d[i + 1]) d[i + 1].focus();
                 const code = d.map(x => x.value).join('');
                 if (code.length === 6) go(code);
               }));`
            : `const f = document.getElementById('otp');
               f.addEventListener('input', () => { if (f.value.length === 6) go(f.value); });`}
        </script>`));
    }
    if (url.pathname === '/auto-login') {
      return send(page(`<form action="/auto-otp" method="get"><input type="hidden" name="kind" value="${url.searchParams.get('kind') ?? 'single'}">
        <label>User ID <input name="userid"></label><label>Password <input type="password" name="password"></label>
        <button>Login</button></form>`));
    }
    // A retail-banking sign-in in two pages: the user id on the first, then the user id again
    // with a password box that is a text input the page masks itself. "css" masks with
    // -webkit-text-security; "js" keeps the real value from keystrokes and shows dots.
    if (url.pathname === '/hfc-login') {
      return send(page(`<header><button>bedtime</button><button>A-</button><button>A+</button><button>Login</button></header>
        <label for="_r_o_">User ID</label><input type="text" name="userid" id="_r_o_">
        <button id="go">Continue</button><button>Register now</button>
        <script>document.getElementById('go').addEventListener('click', () => {
          location.href = '/hfc-login2?mask=${url.searchParams.get('mask') ?? 'css'}&slow=${url.searchParams.get('slow') ?? '0'}&user=' + encodeURIComponent(document.getElementById('_r_o_').value); });</script>`));
    }
    if (url.pathname === '/hfc-login2') {
      const js = url.searchParams.get('mask') === 'js';
      const slow = Number(url.searchParams.get('slow') ?? '0');
      return send(page(`<header><button>bedtime</button><button>Login</button></header>
        <p role="alert" class="notice">Never share your OTP. Your account is locked after 3 failed attempts.</p>
        <label for="_r_u_">User ID</label><input type="text" name="userid" id="_r_u_" value="${url.searchParams.get('user') ?? ''}">
        <label for="_r_v_">Password</label><input type="text" name="new-password" id="_r_v_" autocomplete="off"
          style="-webkit-text-security: disc"><button type="button" id="eye">visibility_off</button>
        <button type="button">Forgot password?</button>
        <p id="err" role="alert" hidden>Wrong password</p>
        <button id="login">Login</button>
        <script>
          const box = document.getElementById('_r_v_');
          let real = '';
          ${js ? `box.addEventListener('keydown', e => {
                    if (e.key === 'Backspace') real = real.slice(0, -1);
                    else if (e.key.length === 1) real += e.key;
                    else return;
                    e.preventDefault(); box.value = '•'.repeat(real.length);
                  });
                  box.addEventListener('input', () => { if (box.value === '') real = ''; });`
               : `box.addEventListener('input', () => { real = box.value; });`}
          document.getElementById('login').addEventListener('click', () => {
            // A slow server: the code screen arrives seconds after Login is pressed.
            if (real === 'secret' && document.getElementById('_r_u_').value === 'tester') setTimeout(() => { location.href = '/auto-otp?kind=single'; }, ${slow});
            else document.getElementById('err').hidden = false;
          });
        </script>`));
    }
    if (url.pathname === '/login') {
      const style = url.searchParams.get('style') ?? 'single';
      return send(page(`<form action="/otp" method="get"><input type="hidden" name="style" value="${style}">
        <label>Username <input name="username"></label><label>Password <input type="password" name="password"></label>
        <button>Sign in</button></form>`));
    }
    if (url.pathname === '/otp') {
      const digits = url.searchParams.get('style') === 'digits';
      const error = url.searchParams.has('wrong') ? '<p role="alert">That code is not right.</p>' : '';
      return send(page(`<h1>Enter the code</h1>${error}<form action="/verify" method="get">
        <input type="hidden" name="style" value="${url.searchParams.get('style') ?? 'single'}">
        ${digits ? [1, 2, 3, 4, 5, 6].map(i => `<input name="d${i}" maxlength="1" inputmode="numeric">`).join('')
                 : '<label>Verification code <input name="code" autocomplete="one-time-code" inputmode="numeric"></label>'}
        <button>Verify</button></form>`));
    }
    if (url.pathname === '/verify') {
      if (code() !== expected) { response.writeHead(302, { location: `/otp?style=${url.searchParams.get('style')}&wrong=1` }); return response.end(); }
      return send(page('<h1>Dashboard</h1>'));
    }
    response.writeHead(404); response.end();
  });
}

describe('sign-in with a one-time code', () => {
  let server: Server;
  let base: string;
  let pool: BrowserPool;
  let context: BrowserContext;
  const options = { navigationTimeoutMs: 10_000, actionTimeoutMs: 5_000 };

  beforeAll(async () => {
    server = otpSite();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    pool = new BrowserPool(true, new Logger('error', {}, () => {}));
    context = await pool.createContext('chromium', { defaultTimeoutMs: 5_000, navigationTimeoutMs: 10_000 });
  }, 60_000);

  afterAll(async () => {
    await context?.close().catch(() => undefined);
    await pool?.close();
    await new Promise(resolve => server?.close(resolve));
  });

  const login = async (style: string, otp: { otpMode?: 'none' | 'fixed' | 'totp'; otpValue?: string }) => {
    const page = await context.newPage();
    try {
      const result = await performLogin(page, {
        strategy: 'formLogin', loginUrl: `${base}/login?style=${style}`,
        username: 'tester', password: 'secret', ...otp
      }, options);
      return { result, heading: await page.locator('h1').textContent().catch(() => null) };
    } finally {
      await page.close();
    }
  };

  const loginAt = async (path: string, extra: Record<string, unknown> = {}) => {
    const page = await context.newPage();
    try {
      const result = await performLogin(page, {
        strategy: 'formLogin', loginUrl: `${base}${path}`,
        username: 'tester', password: 'secret', otpMode: 'fixed', otpValue: '246810', ...extra
      }, options);
      const headings = await Promise.all(page.frames().map(frame => frame.locator('h1').allTextContents().catch(() => [])));
      return { result, headings: headings.flat() };
    } finally {
      await page.close();
    }
  };

  test('a form that renders seconds after the page loads is waited for', async () => {
    const { result, headings } = await loginAt('/spa-login');
    expect(result.message).toBe('Signed in.');
    expect(headings).toContain('Dashboard');
  }, 30_000);

  test('a user id first and the password on the next screen is signed into', async () => {
    const { result, headings } = await loginAt('/two-step');
    expect(result.message).toBe('Signed in.');
    expect(headings).toContain('Dashboard');
  }, 30_000);

  test('a sign-in form inside an iframe is found and used', async () => {
    const { result, headings } = await loginAt('/framed');
    expect(result.message).toBe('Signed in.');
    expect(headings).toContain('Dashboard');
  }, 30_000);

  test('a mobile number and a code, with no password, is signed into', async () => {
    const { result, headings } = await loginAt('/mobile-login', { password: undefined });
    expect(result.message).toBe('Signed in.');
    expect(headings).toContain('Dashboard');
  }, 30_000);

  test('a bank login with a header of buttons and a disabled Login tab presses Continue', async () => {
    const { result, headings } = await loginAt('/bank-login');
    expect(result.message).toBe('Signed in.');
    expect(headings).toContain('Dashboard');
  }, 40_000);

  test('a Continue button that listens for keystrokes is enabled by typing', async () => {
    const { result, headings } = await loginAt('/bank-login?on=keyup');
    expect(result.message).toBe('Signed in.');
    expect(headings).toContain('Dashboard');
  }, 40_000);

  test('a button that stays disabled is named rather than waited on', async () => {
    const started = Date.now();
    const { result } = await loginAt('/bank-login', { username: 'ab' });
    expect(result.succeeded).toBe(false);
    expect(result.message).toMatch(/"Continue" button stayed disabled/);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 40_000);

  test('a code screen with no button, which submits itself, is signed into', async () => {
    const { result, headings } = await loginAt('/auto-login?kind=single');
    expect(result.message).toBe('Signed in.');
    expect(headings).toContain('Dashboard');
  }, 40_000);

  test('six digit boxes with no button, submitting after the last digit, are signed into', async () => {
    const { result, headings } = await loginAt('/auto-login?kind=boxes');
    expect(result.message).toBe('Signed in.');
    expect(headings).toContain('Dashboard');
  }, 40_000);

  test('a wrong code on a screen with no button is a failure, not a sign-in', async () => {
    const { result } = await loginAt('/auto-login?kind=single', { otpValue: '000000' });
    expect(result.succeeded).toBe(false);
    expect(result.message).toMatch(/did not accept the fixed one-time code/);
  }, 40_000);

  test('a password box that is a text input the page masks itself is found and filled', async () => {
    const { result, headings } = await loginAt('/hfc-login?mask=css');
    expect(result.message).toBe('Signed in.');
    expect(headings).toContain('Dashboard');
  }, 40_000);

  test('a password box that keeps the real value from keystrokes and shows dots is typed into', async () => {
    const { result, headings } = await loginAt('/hfc-login?mask=js');
    expect(result.message).toBe('Signed in.');
    expect(headings).toContain('Dashboard');
  }, 40_000);

  test('a code screen the server shows seconds after Login is still answered, past a standing warning', async () => {
    const { result, headings } = await loginAt('/hfc-login?mask=css&slow=4000', { successUrlContains: '/verify' });
    expect(result.message).toBe('Signed in.');
    expect(headings).toContain('Dashboard');
  }, 60_000);

  test('a refused password fails at once and quotes what the application said', async () => {
    const started = Date.now();
    const { result } = await loginAt('/hfc-login?mask=css', { password: 'not-it', successUrlContains: '/verify' });
    expect(result.succeeded).toBe(false);
    expect(result.message).toMatch(/turned the sign-in down: "Wrong password"/);
    expect(result.message).not.toContain('not-it');
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 60_000);

  test('the same page opened directly signs in in one step', async () => {
    const { result, headings } = await loginAt('/hfc-login2?mask=css&user=');
    expect(result.message).toBe('Signed in.');
    expect(headings).toContain('Dashboard');
  }, 40_000);

  test('selectors configured for the application are used as given', async () => {
    const { result, headings } = await loginAt('/spa-login', {
      usernameLocator: { strategy: 'css', value: 'input[name="j_uid"]' },
      passwordLocator: { strategy: 'css', value: 'input[name="pw"]' },
      submitLocator: { strategy: 'css', value: 'button[type="submit"]' }
    });
    expect(result.message).toBe('Signed in.');
    expect(headings).toContain('Dashboard');
  }, 30_000);

  test('a page with no sign-in form says what it did see, without values', async () => {
    const { result } = await loginAt('/not-a-login');
    expect(result.succeeded).toBe(false);
    expect(result.message).toMatch(/showed: .*type=search.*name="q"/);
    expect(result.message).not.toContain('secret');
  }, 30_000);

  test('a fixed test code is entered and the application is reached', async () => {
    const { result, heading } = await login('single', { otpMode: 'fixed', otpValue: '246810' });
    expect(result.message).toBe('Signed in.');
    expect(result.succeeded).toBe(true);
    expect(heading).toBe('Dashboard');
  }, 30_000);

  test('an authenticator secret produces the current code', async () => {
    const { result, heading } = await login('totp', { otpMode: 'totp', otpValue: RFC_SECRET });
    expect(result.succeeded).toBe(true);
    expect(heading).toBe('Dashboard');
  }, 40_000);

  test('a code split across one box per digit is filled box by box', async () => {
    const { result, heading } = await login('digits', { otpMode: 'fixed', otpValue: '246810' });
    expect(result.succeeded).toBe(true);
    expect(heading).toBe('Dashboard');
  }, 30_000);

  test('a code that is asked for but not configured fails and says what to configure', async () => {
    const { result } = await login('single', {});
    expect(result.succeeded).toBe(false);
    expect(result.message).toMatch(/asked for a one-time code.*none is configured/);
  }, 30_000);

  test('a wrong code is a failure, not a sign-in', async () => {
    const { result } = await login('single', { otpMode: 'fixed', otpValue: '000000' });
    expect(result.succeeded).toBe(false);
    expect(result.message).toMatch(/did not accept the fixed one-time code/);
  }, 30_000);
});
