/**
 * The form laboratory.
 *
 * One application containing every input type a generated test is likely to meet, with
 * real server-side validation behind real client-side behaviour: dependent fields that
 * appear and vanish, a character counter, a cross-field date rule, a file upload, and a
 * multi-select. Valid and invalid paths are both reachable for every field.
 *
 * This is the target for measuring AI test generation. A generator that only ever produces
 * "fill the text box and press the button" looks fine against a simple form; here it has
 * to notice that the business path needs a company name, that the end date cannot precede
 * the start date, and that the terms box is not optional.
 */
import { createLabApp, escapeHtml } from '../shared/http.js';
import { createFaultEngine } from '../shared/faults.js';
import { layout } from '../shared/render.js';

const PORT = Number(process.env.FORMS_PORT ?? 4320);
const APPLICATION = 'AIRA Forms Lab';

const FAULTS = [
  { id: 'FAULT_INVALID_VALIDATION', description: 'The quantity field states a rule the server does not apply.' },
  { id: 'FAULT_SLOW_ELEMENT', description: 'The submit control is rendered after a delay.' },
  { id: 'FAULT_DYNAMIC_LOCATOR', description: 'Test ids carry a per-request suffix.' },
  { id: 'FAULT_JS_ERROR', description: 'The dependent-field script throws.' },
  { id: 'FAULT_ACCEPT_INVALID', description: 'The server accepts a submission it should reject.' }
];

const faults = createFaultEngine(FAULTS, { parameters: { slowElementMs: 4000 } });
const app = createLabApp({ name: APPLICATION, version: '1.0.0', faults });

const COUNTRIES = ['', 'United Kingdom', 'United States', 'Germany', 'Japan'];
const INTERESTS = ['Savings', 'Investments', 'Mortgages', 'Insurance', 'Business banking'];
const US_STATES = ['California', 'New York', 'Texas', 'Washington'];

let submissions = [];
let counter = 0;

/** Test ids gain a suffix only under the dynamic-locator fault. */
const tid = (name) => `data-testid="${faults.on('FAULT_DYNAMIC_LOCATOR') ? `${name}--${counter % 97}` : name}"`;

const nav = [['/', 'Application form', 'nav-form'], ['/submissions', 'Submissions', 'nav-submissions']];

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

app.get('/', ctx => renderForm(ctx, {}, {}));

function renderForm(ctx, values, errors, notice = '') {
  counter++;
  const error = (field) => errors[field]
    ? `<p class="error" ${tid(`error-${field}`)}>${escapeHtml(errors[field])}</p>` : '';
  const value = (field) => escapeHtml(values[field] ?? '');

  ctx.html(Object.keys(errors).length ? 422 : 200, layout({
    title: 'Application form',
    application: APPLICATION,
    nav, active: 'nav-form',
    body: `
<h1 ${tid('page-title')}>Open an account</h1>
${notice ? `<p class="confirmation" role="status" ${tid('form-notice')}>${escapeHtml(notice)}</p>` : ''}
${Object.keys(errors).length ? `<p class="notice" role="alert" ${tid('form-errors')}>${Object.keys(errors).length} field(s) need attention.</p>` : ''}

<form method="post" action="/submit" enctype="multipart/form-data" class="card" novalidate ${tid('application-form')}>
  <h2>About you</h2>
  <div class="field">
    <label for="fullName">Full name</label>
    <input id="fullName" name="fullName" value="${value('fullName')}" ${tid('full-name')} />
    ${error('fullName')}
  </div>
  <div class="field">
    <label for="email">Email address</label>
    <input id="email" name="email" type="email" value="${value('email')}" ${tid('email')} />
    ${error('email')}
  </div>
  <div class="field">
    <label for="quantity">Number of cards</label>
    <input id="quantity" name="quantity" type="number" min="1" max="5" value="${value('quantity')}" ${tid('quantity')} />
    ${error('quantity')}
  </div>

  <h2>Account</h2>
  <fieldset class="field" ${tid('account-type')}>
    <legend>Account type</legend>
    <label><input type="radio" name="accountType" value="personal" ${values.accountType !== 'business' ? 'checked' : ''} ${tid('account-personal')} /> Personal</label>
    <label><input type="radio" name="accountType" value="business" ${values.accountType === 'business' ? 'checked' : ''} ${tid('account-business')} /> Business</label>
  </fieldset>

  <div class="field" id="business-only" ${values.accountType === 'business' ? '' : 'hidden'} ${tid('business-section')}>
    <label for="companyName">Company name</label>
    <input id="companyName" name="companyName" value="${value('companyName')}" ${tid('company-name')} />
    ${error('companyName')}
    <label for="vatNumber" style="margin-top:8px">VAT number (optional)</label>
    <input id="vatNumber" name="vatNumber" value="${value('vatNumber')}" ${tid('vat-number')} />
  </div>

  <div class="field">
    <label for="country">Country</label>
    <select id="country" name="country" ${tid('country')}>
      ${COUNTRIES.map(country => `<option value="${escapeHtml(country)}"${values.country === country ? ' selected' : ''}>${country || 'Choose a country'}</option>`).join('')}
    </select>
    ${error('country')}
  </div>

  <div class="field" id="state-only" ${values.country === 'United States' ? '' : 'hidden'} ${tid('state-section')}>
    <label for="state">State</label>
    <select id="state" name="state" ${tid('state')}>
      <option value="">Choose a state</option>
      ${US_STATES.map(state => `<option value="${state}"${values.state === state ? ' selected' : ''}>${state}</option>`).join('')}
    </select>
    ${error('state')}
  </div>

  <div class="field">
    <label for="interests">Products you are interested in</label>
    <select id="interests" name="interests" multiple size="5" ${tid('interests')}>
      ${INTERESTS.map(interest => `<option value="${interest}"${(values.interests ?? '').includes(interest) ? ' selected' : ''}>${interest}</option>`).join('')}
    </select>
    ${error('interests')}
  </div>

  <h2>Dates</h2>
  <div class="row">
    <div class="field" style="flex:1">
      <label for="startDate">Start date</label>
      <input id="startDate" name="startDate" type="date" value="${value('startDate')}" ${tid('start-date')} />
      ${error('startDate')}
    </div>
    <div class="field" style="flex:1">
      <label for="endDate">End date</label>
      <input id="endDate" name="endDate" type="date" value="${value('endDate')}" ${tid('end-date')} />
      ${error('endDate')}
    </div>
  </div>

  <h2>Contact and documents</h2>
  <fieldset class="field" ${tid('contact-methods')}>
    <legend>How may we contact you?</legend>
    <label><input type="checkbox" name="contactEmail" value="yes" ${values.contactEmail ? 'checked' : ''} ${tid('contact-email')} /> Email</label>
    <label><input type="checkbox" name="contactPhone" value="yes" ${values.contactPhone ? 'checked' : ''} ${tid('contact-phone')} /> Phone</label>
    <label><input type="checkbox" name="contactPost" value="yes" ${values.contactPost ? 'checked' : ''} ${tid('contact-post')} /> Post</label>
    ${error('contact')}
  </fieldset>

  <div class="field">
    <label for="document">Proof of address (PDF or image, up to 1 MB)</label>
    <input id="document" name="document" type="file" ${tid('document')} />
    ${error('document')}
  </div>

  <div class="field">
    <label for="notes">Anything else? (200 characters)</label>
    <textarea id="notes" name="notes" rows="3" maxlength="200" ${tid('notes')}>${value('notes')}</textarea>
    <span class="muted" ${tid('notes-count')}>0 / 200</span>
    ${error('notes')}
  </div>

  <div class="field">
    <label><input type="checkbox" name="terms" value="yes" ${values.terms ? 'checked' : ''} ${tid('terms')} /> I accept the terms</label>
    ${error('terms')}
  </div>

  ${faults.on('FAULT_SLOW_ELEMENT')
    ? `<span class="muted" ${tid('submit-pending')}>Preparing…</span><span id="late"></span>`
    : `<button type="submit" class="primary" ${tid('submit')}>Submit application</button>`}
</form>`,
    script: CLIENT_SCRIPT(faults.on('FAULT_SLOW_ELEMENT') ? faults.parameter('slowElementMs') : 0,
      faults.on('FAULT_JS_ERROR'), faults.on('FAULT_DYNAMIC_LOCATOR') ? `--${counter % 97}` : '')
  }));
}

const CLIENT_SCRIPT = (slowMs, jsError, suffix) => `
const byTestId = (name) => document.querySelector('[data-testid="' + name + '${suffix}"]');

${jsError ? `throw new Error('LAB_FAULT_JS_ERROR: the dependent-field script could not start');` : ''}

// Dependent fields: the business section follows the account type, the state select
// follows the country. Both are real conditional fields, not hidden-but-present inputs.
const businessSection = document.getElementById('business-only');
for (const radio of document.querySelectorAll('input[name="accountType"]')) {
  radio.addEventListener('change', () => { businessSection.hidden = radio.value !== 'business'; });
}

const country = byTestId('country');
const stateSection = document.getElementById('state-only');
country.addEventListener('change', () => { stateSection.hidden = country.value !== 'United States'; });

const notes = byTestId('notes');
const count = byTestId('notes-count');
const updateCount = () => { count.textContent = notes.value.length + ' / 200'; };
notes.addEventListener('input', updateCount);
updateCount();

${slowMs > 0 ? `
setTimeout(() => {
  document.getElementById('late').innerHTML =
    '<button type="submit" class="primary" data-testid="submit${suffix}">Submit application</button>';
  byTestId('submit-pending')?.remove();
}, ${slowMs});` : ''}
`;

// ---------------------------------------------------------------------------
// Validation — the rules a generated test has to discover
// ---------------------------------------------------------------------------

app.post('/submit', async (ctx) => {
  const body = await ctx.body();
  const values = {
    ...body,
    interests: Array.isArray(body.interests) ? body.interests.join(',') : (body.interests ?? '')
  };
  const errors = {};

  if (!String(body.fullName ?? '').trim()) errors.fullName = 'Enter your full name.';
  else if (String(body.fullName).trim().length < 2) errors.fullName = 'Your name must be at least 2 characters.';

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(body.email ?? ''))) errors.email = 'Enter a valid email address.';

  const quantity = Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 5) {
    errors.quantity = faults.on('FAULT_INVALID_VALIDATION')
      ? 'Enter a number between 1 and 50.'        // the server enforces 1–5
      : 'Enter a number between 1 and 5.';
  }

  if (body.accountType === 'business' && !String(body.companyName ?? '').trim()) {
    errors.companyName = 'A business account needs a company name.';
  }

  if (!String(body.country ?? '').trim()) errors.country = 'Choose a country.';
  if (body.country === 'United States' && !String(body.state ?? '').trim()) errors.state = 'Choose a state.';

  if (!values.interests) errors.interests = 'Choose at least one product.';

  if (!body.startDate) errors.startDate = 'Choose a start date.';
  if (!body.endDate) errors.endDate = 'Choose an end date.';
  if (body.startDate && body.endDate && body.endDate < body.startDate) {
    errors.endDate = 'The end date must be on or after the start date.';
  }

  if (!body.contactEmail && !body.contactPhone && !body.contactPost) {
    errors.contact = 'Choose at least one way for us to contact you.';
  }

  const document = body.document;
  if (!document || !document.filename) errors.document = 'Attach proof of address.';
  else if (document.size > 1024 * 1024) errors.document = 'That file is larger than 1 MB.';

  if (String(body.notes ?? '').length > 200) errors.notes = 'Keep notes to 200 characters.';
  if (!body.terms) errors.terms = 'You must accept the terms.';

  // The accept-invalid fault is the lab's own false-pass generator: the server takes a
  // submission it should have refused, so a test that only checks for a success banner
  // reports a pass while the rules were broken.
  if (Object.keys(errors).length > 0 && !faults.on('FAULT_ACCEPT_INVALID')) {
    return renderForm(ctx, values, errors);
  }

  const submission = {
    id: `sub-${(submissions.length + 1).toString().padStart(3, '0')}`,
    receivedAt: new Date().toISOString(),
    fullName: body.fullName ?? '',
    email: body.email ?? '',
    accountType: body.accountType ?? 'personal',
    country: body.country ?? '',
    interests: values.interests,
    quantity: body.quantity ?? '',
    document: document?.filename ?? null,
    acceptedDespiteErrors: Object.keys(errors)
  };
  submissions = [submission, ...submissions];
  return ctx.redirect(`/submissions?new=${submission.id}`, 303);
});

app.get('/submissions', ctx => ctx.html(200, layout({
  title: 'Submissions',
  application: APPLICATION,
  nav, active: 'nav-submissions',
  body: `
<h1 data-testid="page-title">Submissions</h1>
${ctx.query.new ? `<p class="confirmation" role="status" data-testid="submission-confirmation">Application ${escapeHtml(ctx.query.new)} received.</p>` : ''}
${submissions.length === 0 ? '<p class="muted" data-testid="submissions-empty">No applications yet.</p>' : `
<table data-testid="submissions-table">
  <thead><tr><th>Reference</th><th>Name</th><th>Type</th><th>Country</th><th>Cards</th><th>Document</th></tr></thead>
  <tbody>
    ${submissions.map(submission => `
    <tr data-testid="submission-row-${submission.id}">
      <td>${submission.id}</td><td>${escapeHtml(submission.fullName)}</td>
      <td>${escapeHtml(submission.accountType)}</td><td>${escapeHtml(submission.country)}</td>
      <td>${escapeHtml(submission.quantity)}</td><td>${escapeHtml(submission.document ?? '—')}</td>
    </tr>`).join('')}
  </tbody>
</table>`}`
})));

app.get('/api/submissions', ctx => ctx.json(200, { submissions }));

app.post('/__reset', (ctx) => {
  submissions = [];
  return ctx.json(200, { reset: true, faults: faults.reset() });
});

await app.listen(PORT);
