/**
 * Proves the form lab is what its ground truth says, before anything is measured with it.
 *
 *   node test-lab/form-lab/selftest.mjs [baseUrl]
 *
 * Every form must accept a valid submission and refuse an empty one, and every server-side
 * defect must actually happen. A lab whose defects do not manifest would make a platform
 * that misses them look correct, so this runs first in the verification script.
 *
 * The three defects that live in client script or layout (FL-D04, FL-D11, FL-D15) need a
 * browser; the verification suite checks those through the platform's own runs.
 */
import { FORMS } from './forms.js';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:4370').replace(/\/$/, '');
const CSRF = 'fl-csrf-7c1e9a';

/** A value each field accepts, chosen by hand: the lab's own oracle must not be inferred. */
const VALID = {
  name: 'Ada Lovelace', fullName: 'Ada Lovelace', email: 'ada@example.test',
  password: 'Str0ng-passphrase', confirmPassword: 'Str0ng-passphrase', terms: 'on',
  username: 'demo', quantity: '2', shipping: 'Standard', notes: 'Leave at door',
  cardholder: 'Ada Lovelace', cardNumber: '4111111111111111', expiry: '2028-05', cvv: '123', amount: '25.50',
  displayName: 'Ada', bio: 'Mathematician', website: 'https://example.test', phone: '0207 946 000',
  line1: '1 Main Street', city: 'London', postcode: 'SW1A 1AA', country: 'United Kingdom',
  applicant: 'Ada Lovelace', loanAmount: '5000', termMonths: '24', agree: 'on',
  accountType: 'Personal', title: 'Proof of address',
  startDate: '2026-01-10', endDate: '2026-01-12', startTime: '09:00',
  region: 'England', age: '30', subject: 'Help', message: 'Please call me back.',
  nickname: 'Ada', when: 'Morning', company: 'Acme', seats: '10', payee: 'Acme Ltd', note: 'Remember the milk',
  workEmail: 'ada@example.test', requirement: 'A demo for our team.'
};

let failures = 0;
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!ok) failures += 1;
};

async function submit(form, overrides = {}, { cookie = 'fl_session=s1', file } = {}) {
  const values = {};
  for (const field of form.fields) {
    if (field.type === 'file') continue;
    if (field.dependsOn) continue;
    if (field.type === 'checkbox' && !field.required) continue;
    if (field.type === 'switch') continue;
    values[field.name] = form.id === 'login' && field.name === 'password' ? 'demo-pass' : VALID[field.name];
    if (form.id === 'validation' && field.name === 'username') values.username = 'ada_99';
    if (form.id === 'validation' && field.name === 'amount') values.amount = '12.34';
    if (form.id === 'validation' && field.name === 'quantity') values.quantity = '5';
    if (form.id === 'checkout' && field.name === 'fullName') values.fullName = 'Ada Lovelace';
  }
  if (form.csrf !== false) values._csrf = CSRF;
  Object.assign(values, overrides);
  if ('_csrf' in overrides && overrides._csrf === undefined) delete values._csrf;
  for (const [key, value] of Object.entries(values)) if (value === undefined) delete values[key];

  if (form.api) {
    return fetch(`${BASE}${form.api}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) });
  }
  if (form.multipart) {
    const data = new FormData();
    for (const [key, value] of Object.entries(values)) data.append(key, value);
    if (file) data.append('document', new Blob([new Uint8Array(file.size)]), file.name);
    return fetch(`${BASE}${form.route}`, { method: 'POST', body: data, redirect: 'manual', headers: { cookie } });
  }
  if (form.method === 'get') {
    return fetch(`${BASE}${form.action}?${new URLSearchParams(values)}`, { redirect: 'manual' });
  }
  return fetch(`${BASE}${form.route}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams(values)
  });
}

const accepted = response => response.status === 303 || response.status === 201 || response.status === 200;
const byId = id => FORMS.find(form => form.id === id);

await fetch(`${BASE}/__reset`, { method: 'POST' });

for (const form of FORMS) {
  const page = await fetch(`${BASE}${form.route}`);
  check(page.status === 200, `${form.id}: page loads`);

  const ok = await submit(form, {}, { file: { name: 'proof.pdf', size: 2048 } });
  check(form.method === 'get' ? ok.status === 200 : (ok.status === 303 || ok.status === 201),
    `${form.id}: a valid submission is accepted (HTTP ${ok.status})`);

  const required = form.fields.filter(f => f.required && !f.dependsOn);
  if (required.length > 0) {
    const empty = await submit(form, Object.fromEntries(required.map(f => [f.name, undefined])));
    check(empty.status === 422 || empty.status === 401, `${form.id}: an empty submission is refused (HTTP ${empty.status})`);
  }
}

// Correct rules that must hold, so a test that expects them is not chasing a lab bug.
check((await submit(byId('validation'), { age: '121' })).status === 422, 'validation: age above maximum refused');
check((await submit(byId('validation'), { username: 'ab' })).status === 422, 'validation: username below minimum length refused');
check((await submit(byId('validation'), { username: 'UPPER' })).status === 422, 'validation: username outside its pattern refused');
check((await submit(byId('validation'), { amount: '12.345' })).status === 422, 'validation: amount off its step refused');
check((await submit(byId('dynamic'), { hasReferral: 'on' })).status === 422, 'dynamic: a shown referral code is required');
check((await submit(byId('file-upload'), {}, { file: { name: 'tool.exe', size: 100 } })).status === 422, 'file-upload: a disallowed type is refused');
check((await submit(byId('file-upload'), {}, { file: { name: 'big.pdf', size: 1_100_000 } })).status === 422, 'file-upload: a file over 1 MB is refused');
check((await submit(byId('dependent-dropdown'), { country: 'Canada', region: 'England' })).status === 422, 'dependent-dropdown: a region from another country is refused');
check((await submit(byId('checkout'), { _csrf: 'wrong' })).status === 422, 'checkout: a wrong anti-forgery token is refused');

// The deliberate defects that live on the server.
check(accepted(await submit(byId('registration'), { confirmPassword: 'Different-passphrase1' })), 'FL-D01 manifests: mismatched confirmation accepted');
check(accepted(await submit(byId('validation'), { age: '17' })), 'FL-D02 manifests: age 17 accepted');
const results = await (await submit(byId('search'), { q: '<qanxt-probe></qanxt-probe>' })).text();
check(results.includes('<qanxt-probe>'), 'FL-D06 manifests: query reflected as markup');
check(accepted(await submit(byId('profile'), { displayName: '   ' })), 'FL-D08 manifests: whitespace display name accepted');
check(accepted(await submit(byId('date-form'), { startDate: '2026-02-10', endDate: '2026-02-01' })), 'FL-D09 manifests: end before start accepted');
check(accepted(await submit(byId('payment'), {})), 'FL-D10 manifests: payment accepted with no anti-forgery token');
check(accepted(await submit(byId('dynamic'), { accountType: 'Business' })), 'FL-D12 manifests: business account without company name accepted');
check((await submit(byId('error-handling'), { message: 'x'.repeat(1001) })).status === 500, 'FL-D05 manifests: long message crashes');
check((await submit(byId('error-handling'), { message: 'null' })).status === 500, 'FL-D05 manifests: "null" message crashes');
check((await submit(byId('session-expiry'), {}, { cookie: '' })).status === 500, 'FL-D13 manifests: submission without a session crashes');
// FL-D03: two quick submissions are two transfers; nothing de-duplicates them.
await fetch(`${BASE}/__reset`, { method: 'POST' });
await Promise.all([submit(byId('duplicate-submit')), submit(byId('duplicate-submit'))]);
const transfers = await (await fetch(`${BASE}/api/records?form=duplicate-submit`)).json();
check(transfers.records.length === 2, 'FL-D03 manifests: two submissions make two transfers');
const started = Date.now();
await submit(byId('slow-form'));
check(Date.now() - started >= 3400, 'FL-D07 manifests: submission takes at least 3.4 s');

// Every server-side defect can be fixed, and fixed means gone: the regression loop the
// verification runs depends on it.
await fetch(`${BASE}/__reset`, { method: 'POST' });
const fix = await fetch(`${BASE}/__fix`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ all: true }) });
check(fix.ok, 'all defects can be switched off');
check((await submit(byId('registration'), { confirmPassword: 'Different-passphrase1' })).status === 422, 'FL-D01 fixed: mismatched confirmation refused');
check((await submit(byId('validation'), { age: '17' })).status === 422, 'FL-D02 fixed: age 17 refused');
check(!(await (await submit(byId('search'), { q: '<qanxt-probe></qanxt-probe>' })).text()).includes('<qanxt-probe>'), 'FL-D06 fixed: query encoded');
check((await submit(byId('profile'), { displayName: '   ' })).status === 422, 'FL-D08 fixed: whitespace refused');
check((await submit(byId('date-form'), { startDate: '2026-02-10', endDate: '2026-02-01' })).status === 422, 'FL-D09 fixed: reversed dates refused');
check((await submit(byId('payment'), { _csrf: undefined })).status === 422, 'FL-D10 fixed: payment now requires its token');
check((await submit(byId('payment'), { _csrf: CSRF })).status === 303, 'FL-D10 fixed: payment accepted with its token');
check((await submit(byId('dynamic'), { accountType: 'Business' })).status === 422, 'FL-D12 fixed: company name required');
check((await submit(byId('error-handling'), { message: 'null' })).status === 303, 'FL-D05 fixed: "null" handled');
check((await submit(byId('session-expiry'), {}, { cookie: '' })).status === 401, 'FL-D13 fixed: expired session asks to sign in');
const quick = Date.now();
await submit(byId('slow-form'));
check(Date.now() - quick < 2000, 'FL-D07 fixed: submission under 2 s');

// A form can change shape, for impact selection.
await fetch(`${BASE}/__change`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ forms: ['simple-form'] }) });
check((await (await fetch(`${BASE}/simple-form`)).text()).includes('name="company"'), 'simple-form gains a field when changed');

await fetch(`${BASE}/__reset`, { method: 'POST' });
check(!(await (await fetch(`${BASE}/simple-form`)).text()).includes('name="company"'), 'reset restores the declared lab');
console.log(failures === 0 ? '\nForm lab self-test passed.' : `\nForm lab self-test: ${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
