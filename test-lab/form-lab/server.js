/**
 * The golden form lab.
 *
 * Twenty forms, one per kind a professional QA team meets, each validated on the server by
 * rules derived from the same declarations the ground truth is generated from (forms.js).
 * Fourteen deliberate defects, each declared on its form with the testing categories that
 * should catch it.
 *
 * Correct behaviour is the default and the defects are the exceptions, so that a test
 * failing here means something: a platform that fails every form is as broken as one that
 * passes every form, and the lab has to be able to show the difference.
 */
import { createLabApp, escapeHtml } from '../shared/http.js';
import { createFaultEngine } from '../shared/faults.js';
import { layout } from '../shared/render.js';
import { FORMS, REGIONS, groundTruth } from './forms.js';

const PORT = Number(process.env.FORM_LAB_PORT ?? 4370);
const APPLICATION = 'QA NXT Golden Form Lab';
const CSRF_TOKEN = 'fl-csrf-7c1e9a';
const MAX_UPLOAD_BYTES = 1024 * 1024;

const faults = createFaultEngine([], {});
const app = createLabApp({ name: APPLICATION, version: '1.0.0', faults });

// What the lab has received, so a verification can check data integrity through the
// application's own read API rather than trusting a success banner.
let records = [];
let loginFailures = 0;
let counter = 0;

const nav = [['/', 'All forms', 'nav-home']];

// ---------------------------------------------------------------------------
// Validation, from the declarations
// ---------------------------------------------------------------------------

const isVisible = (field, body) => {
  if (!field.dependsOn) return true;
  return String(body[field.dependsOn.field] ?? '') === field.dependsOn.equals;
};

const textOf = (value) => (typeof value === 'string' ? value : '');

function validateField(form, field, body) {
  const raw = body[field.name];
  const attrs = field.attrs ?? {};
  const label = field.label ?? field.placeholder ?? field.name;
  const defect = (key) => form.defects.some(d => d[key] === field.name);

  if (field.type === 'file') {
    const file = raw && typeof raw === 'object' ? raw : null;
    if (!file || !file.filename) return field.required ? `Choose a file for ${label}.` : null;
    if (attrs.accept) {
      const allowed = attrs.accept.split(',').map(s => s.trim().toLowerCase());
      const extension = `.${file.filename.split('.').pop()?.toLowerCase()}`;
      if (!allowed.includes(extension)) return `${label} must be one of: ${attrs.accept}.`;
    }
    if (file.size > MAX_UPLOAD_BYTES) return `${label} must be no larger than 1 MB.`;
    return null;
  }

  if (field.type === 'checkbox' || field.type === 'switch') {
    if (field.required && !raw) return `${label} is required.`;
    return null;
  }

  const text = textOf(raw);
  const value = defect('noTrim') ? text : text.trim();
  const conditionalNotEnforced = field.dependsOn && defect('skipsConditional');

  if (value.length === 0) {
    return field.required && !conditionalNotEnforced ? `Enter ${label.toLowerCase()}.` : null;
  }

  if (field.type === 'select' || field.type === 'radio') {
    return (field.options ?? []).includes(value) || form.dependentOptions?.child === field.name
      ? null : `Choose a valid ${label.toLowerCase()}.`;
  }

  if (attrs.minlength !== undefined && value.length < Number(attrs.minlength)) {
    return `${label} must be at least ${attrs.minlength} characters.`;
  }
  if (attrs.maxlength !== undefined && value.length > Number(attrs.maxlength)) {
    return `${label} must be at most ${attrs.maxlength} characters.`;
  }
  if (attrs.pattern && !new RegExp(`^(?:${attrs.pattern})$`).test(value)) {
    return `${label} is not in the right format.`;
  }

  switch (field.type) {
    case 'email':
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return `Enter a valid email address.`;
      break;
    case 'url':
      try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol)) return `Enter a web address starting http or https.`;
      } catch { return `Enter a valid web address.`; }
      break;
    case 'number': {
      const number = Number(value);
      if (!Number.isFinite(number)) return `${label} must be a number.`;
      if (attrs.min !== undefined && number < Number(attrs.min) && !defect('skipsMin')) return `${label} must be at least ${attrs.min}.`;
      if (attrs.max !== undefined && number > Number(attrs.max)) return `${label} must be at most ${attrs.max}.`;
      if (attrs.step !== undefined) {
        const base = attrs.min !== undefined ? Number(attrs.min) : 0;
        const steps = (number - base) / Number(attrs.step);
        if (Math.abs(steps - Math.round(steps)) > 1e-6) return `${label} must be in steps of ${attrs.step}.`;
      }
      break;
    }
    case 'date':
    case 'month':
      if (!(field.type === 'date' ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}$/).test(value)) return `Enter a valid ${label.toLowerCase()}.`;
      if (attrs.min !== undefined && value < attrs.min) return `${label} must be on or after ${attrs.min}.`;
      if (attrs.max !== undefined && value > attrs.max) return `${label} must be on or before ${attrs.max}.`;
      break;
    case 'time':
      if (!/^\d{2}:\d{2}(:\d{2})?$/.test(value)) return `Enter a valid time.`;
      break;
    case 'datetime-local':
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return `Enter a valid date and time.`;
      break;
    default:
      break;
  }
  return null;
}

function validate(form, body) {
  const errors = {};
  for (const field of form.fields) {
    if (!isVisible(field, body)) continue;
    const error = validateField(form, field, body);
    if (error) errors[field.name] = error;
  }

  if (form.dependentOptions) {
    const { parent, child, map } = form.dependentOptions;
    const options = map[body[parent]] ?? [];
    if (body[child] && !options.includes(body[child])) errors[child] = 'Choose a region in the selected country.';
  }

  for (const rule of form.crossRules ?? []) {
    if (form.defects.some(d => d.skipsRule === rule.id)) continue;
    const [a, b] = rule.fields.map(name => textOf(body[name]));
    if (!a || !b || errors[rule.fields[0]] || errors[rule.fields[1]]) continue;
    if (rule.kind === 'equals' && a !== b) errors[rule.fields[1]] = rule.message;
    if (rule.kind === 'notBefore' && b < a) errors[rule.fields[1]] = rule.message;
  }

  if (form.csrf !== false && !form.api && body._csrf !== CSRF_TOKEN) {
    errors._form = 'This form has expired. Reload the page and try again.';
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Rendering, from the declarations
// ---------------------------------------------------------------------------

const fieldId = (form, field) => `${form.id}-${field.name}`;

function renderField(form, field, values, errors) {
  const id = fieldId(form, field);
  const error = errors[field.name];
  const broken = form.a11yBroken && !field.label;
  const value = values[field.name];
  const attrs = field.attrs ?? {};
  const describedBy = [field.help ? `${id}-help` : null, error && !broken ? `${id}-error` : null].filter(Boolean).join(' ');
  const common = [
    `id="${id}"`, `name="${field.name}"`, `data-testid="${id}"`,
    field.required ? 'required' : '',
    describedBy ? `aria-describedby="${describedBy}"` : '',
    error && !broken ? 'aria-invalid="true"' : ''
  ].filter(Boolean).join(' ');
  const attributeText = Object.entries(attrs).map(([key, val]) => `${key}="${escapeHtml(val)}"`).join(' ');
  const required = field.required ? ' <span class="required" aria-hidden="true">*</span>' : '';
  const label = field.label ? `<label for="${id}">${escapeHtml(field.label)}${required}</label>` : '';
  const help = field.help ? `<p class="help" id="${id}-help">${escapeHtml(field.help)}</p>` : '';
  const errorText = error
    ? (broken ? `<p class="error">${escapeHtml(error)}</p>` : `<p class="error" id="${id}-error">${escapeHtml(error)}</p>`)
    : '';
  const hiddenAttr = field.dependsOn && !isVisible(field, values) ? ' hidden' : '';
  const dependency = field.dependsOn ? ` data-depends-on="${field.dependsOn.field}" data-depends-value="${escapeHtml(field.dependsOn.equals)}"` : '';
  const step = field.step ? ` data-step-field="${field.step}"` : '';
  const wrap = inner => `<div class="field" data-field="${field.name}"${dependency}${step}${hiddenAttr}>${inner}</div>`;

  switch (field.type) {
    case 'textarea':
      return wrap(`${label}${help}<textarea ${common} ${attributeText} rows="3">${escapeHtml(textOf(value))}</textarea>${errorText}`);
    case 'select': {
      const options = form.dependentOptions?.child === field.name
        ? (REGIONS[values[form.dependentOptions.parent]] ?? field.options)
        : field.options;
      return wrap(`${label}${help}<select ${common}>
        <option value="">Choose…</option>
        ${options.map(option => `<option${option === value ? ' selected' : ''}>${escapeHtml(option)}</option>`).join('')}
      </select>${errorText}`);
    }
    case 'radio':
      return wrap(`<fieldset${error ? ' aria-invalid="true"' : ''}${error ? ` aria-describedby="${id}-error"` : ''}><legend>${escapeHtml(field.label)}${required}</legend>
        ${field.options.map((option, index) => `<label class="inline"><input type="radio" id="${id}-${index}" name="${field.name}" value="${escapeHtml(option)}" data-testid="${id}-${index}"${field.required && index === 0 ? ' required' : ''}${option === value ? ' checked' : ''} /> ${escapeHtml(option)}</label>`).join('')}
      </fieldset>${errorText}`);
    case 'checkbox':
    case 'switch':
      return wrap(`<label class="inline" for="${id}"><input type="checkbox" ${common}${field.type === 'switch' ? ' role="switch"' : ''}${value ? ' checked' : ''} /> ${escapeHtml(field.label)}${required}</label>${errorText}`);
    case 'file':
      return wrap(`${label}${help}<input type="file" ${common} ${attributeText} />${errorText}`);
    default: {
      const placeholder = field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : '';
      // A password is never echoed back into the page.
      const echoed = field.type === 'password' ? '' : ` value="${escapeHtml(textOf(value))}"`;
      return wrap(`${label}${help}<input type="${field.type}" ${common} ${attributeText}${placeholder}${echoed} />${errorText}`);
    }
  }
}

function renderForm(ctx, form, values = {}, errors = {}, status = 200) {
  const errorList = Object.entries(errors);
  const summary = errorList.length === 0 ? '' : form.a11yBroken
    ? `<div class="error-summary"><p>Please correct the form.</p></div>`
    : `<div class="error-summary" role="alert" data-testid="${form.id}-errors"><h2>There is a problem</h2><ul>${errorList.map(([name, message]) =>
        `<li>${name === '_form' ? escapeHtml(message) : `<a href="#${form.id}-${name}">${escapeHtml(message)}</a>`}</li>`).join('')}</ul></div>`;

  const method = form.method ?? 'post';
  const action = form.api ? '' : ` action="${form.action ?? form.route}"`;
  const enctype = form.multipart ? ' enctype="multipart/form-data"' : '';
  const novalidate = form.native ? '' : ' novalidate';
  const width = form.fixedWidth ? ' style="width:900px;min-width:900px"' : '';
  const csrf = form.csrf === false || form.api ? '' : `<input type="hidden" name="_csrf" value="${CSRF_TOKEN}" />`;

  let fieldsMarkup;
  if (form.multiStep) {
    const steps = [...new Set(form.fields.map(f => f.step))];
    const current = Number(values.__step ?? 1);
    fieldsMarkup = steps.map(step => `<fieldset class="step" data-step="${step}"${step === current ? '' : ' hidden'}>
      <legend>Step ${step} of ${steps.length}</legend>
      ${form.fields.filter(f => f.step === step).map(f => renderField(form, f, values, errors)).join('')}
    </fieldset>`).join('') + `<p class="step-indicator" aria-live="polite" data-testid="${form.id}-step">Step ${current} of ${steps.length}</p>
    <div class="actions">
      <button type="button" data-testid="${form.id}-previous" data-action="previous"${current === 1 ? ' hidden' : ''}>Previous</button>
      <button type="button" data-testid="${form.id}-next" data-action="next"${current === steps.length ? ' hidden' : ''}>Next</button>
      <button type="submit" data-testid="${form.id}-submit"${current === steps.length ? '' : ' hidden'}>${escapeHtml(form.submitLabel)}</button>
    </div>`;
  } else {
    fieldsMarkup = form.fields.map(f => renderField(form, f, values, errors)).join('')
      + `<div class="actions"><button type="submit" data-testid="${form.id}-submit">${escapeHtml(form.submitLabel)}</button></div>`;
  }

  const lowContrast = form.a11yBroken ? '<p style="color:#bbb;background:#fff">Optional: tell us anything else.</p>' : '';

  return ctx.html(status, layout({
    title: form.title, application: APPLICATION, nav,
    head: `<style>.error{color:#b00020}.error-summary{border:2px solid #b00020;padding:8px;margin-bottom:12px}.field{margin:10px 0}.inline{display:inline-flex;gap:6px;align-items:center;margin-right:12px}fieldset{border:1px solid #ccc;padding:8px}</style>`,
    body: `<h1 data-testid="page-title">${escapeHtml(form.title)}</h1>
<p class="muted">${escapeHtml(form.purpose)}</p>
${summary}
<form id="${form.id}" name="${form.id}" method="${method}"${action}${enctype}${novalidate}${width} data-testid="${form.id}-form" aria-label="${escapeHtml(form.title)}">
${csrf}
${fieldsMarkup}
</form>
<p class="status" role="status" data-testid="${form.id}-result" hidden></p>
${lowContrast}`,
    script: scriptFor(form)
  }));
}

function scriptFor(form) {
  const parts = [];

  if (form.fields.some(f => f.dependsOn)) {
    parts.push(`
      const form = document.getElementById('${form.id}');
      const sync = () => {
        for (const wrapper of form.querySelectorAll('[data-depends-on]')) {
          const control = form.elements.namedItem(wrapper.dataset.dependsOn);
          const value = control.type === 'checkbox' ? (control.checked ? 'on' : '') : control.value;
          wrapper.hidden = value !== wrapper.dataset.dependsValue;
        }
      };
      form.addEventListener('change', sync);
      sync();`);
  }

  if (form.dependentOptions) {
    const { parent, child } = form.dependentOptions;
    parts.push(`
      const map = ${JSON.stringify(form.dependentOptions.map)};
      const parentControl = document.getElementById('${form.id}-${parent}');
      const childControl = document.getElementById('${form.id}-${child}');
      parentControl.addEventListener('change', () => {
        const options = map[parentControl.value] ?? [];
        childControl.innerHTML = '<option value="">Choose…</option>' + options.map(o => '<option>' + o + '</option>').join('');
      });`);
  }

  if (form.guardDuplicate) {
    parts.push(`
      const guarded = document.getElementById('${form.id}');
      guarded.addEventListener('submit', () => {
        const button = guarded.querySelector('button[type=submit]');
        setTimeout(() => { button.disabled = true; button.setAttribute('aria-busy', 'true'); button.textContent = 'Placing order…'; }, 0);
      });`);
  }

  if (form.multiStep) {
    parts.push(`
      const wizard = document.getElementById('${form.id}');
      const steps = [...wizard.querySelectorAll('fieldset.step')];
      let current = steps.findIndex(s => !s.hidden);
      const indicator = document.querySelector('[data-testid="${form.id}-step"]');
      const show = (index) => {
        current = index;
        steps.forEach((s, i) => { s.hidden = i !== index; });
        wizard.querySelector('[data-action=previous]').hidden = index === 0;
        wizard.querySelector('[data-action=next]').hidden = index === steps.length - 1;
        wizard.querySelector('button[type=submit]').hidden = index !== steps.length - 1;
        indicator.textContent = 'Step ' + (index + 1) + ' of ' + steps.length;
      };
      const stepValid = (index) => {
        let ok = true;
        for (const control of steps[index].querySelectorAll('input, select, textarea')) {
          const errorId = control.id + '-error';
          document.getElementById(errorId)?.remove();
          control.removeAttribute('aria-invalid');
          const empty = control.type === 'checkbox' ? !control.checked : control.value.trim() === '';
          if (control.required && empty) {
            ok = false;
            control.setAttribute('aria-invalid', 'true');
            control.setAttribute('aria-describedby', errorId);
            const message = document.createElement('p');
            message.className = 'error'; message.id = errorId; message.textContent = 'This field is required.';
            control.closest('.field').appendChild(message);
          }
        }
        return ok;
      };
      wizard.querySelector('[data-action=next]').addEventListener('click', () => {
        if (stepValid(current)) show(current + 1);
        else steps[current].querySelector('[aria-invalid=true]')?.focus();
      });
      wizard.querySelector('[data-action=previous]').addEventListener('click', () => {
        // FL-D11: going back empties the first step.
        if (current === 1) steps[0].querySelectorAll('input').forEach(i => { i.value = ''; });
        show(current - 1);
      });`);
  }

  if (form.api) {
    parts.push(`
      const apiForm = document.getElementById('${form.id}');
      const result = document.querySelector('[data-testid="${form.id}-result"]');
      apiForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        apiForm.querySelectorAll('.error').forEach(e => e.remove());
        apiForm.querySelectorAll('[aria-invalid]').forEach(e => e.removeAttribute('aria-invalid'));
        document.querySelector('[data-testid="${form.id}-errors"]')?.remove();
        result.hidden = true;
        const body = Object.fromEntries(new FormData(apiForm).entries());
        const response = await fetch('${form.api}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const payload = await response.json();
        if (response.ok) {
          result.textContent = 'Received. Reference ' + payload.reference + '.';
          result.hidden = false;
          apiForm.reset();
          return;
        }
        const summary = document.createElement('div');
        summary.setAttribute('role', 'alert'); summary.className = 'error-summary';
        summary.dataset.testid = '${form.id}-errors';
        summary.textContent = 'There is a problem with ' + Object.keys(payload.errors).length + ' field(s).';
        apiForm.before(summary);
        for (const [name, message] of Object.entries(payload.errors)) {
          const control = apiForm.elements.namedItem(name);
          if (!control) continue;
          control.setAttribute('aria-invalid', 'true');
          const error = document.createElement('p');
          error.className = 'error'; error.id = control.id + '-error'; error.textContent = message;
          control.setAttribute('aria-describedby', error.id);
          control.closest('.field').appendChild(error);
        }
      });`);
  }

  return parts.join('\n');
}

function renderDone(ctx, form) {
  const reference = escapeHtml(ctx.query.ref ?? '');
  return ctx.html(200, layout({
    title: `${form.title} received`, application: APPLICATION, nav,
    body: `<h1 data-testid="page-title">${escapeHtml(form.title)} — done</h1>
<p class="confirmation" role="status" data-testid="${form.id}-confirmation">Thank you. We received it. Reference ${reference}.</p>
<p><a href="${form.route}" data-testid="${form.id}-again">Start again</a></p>`
  }));
}

function crash(ctx, where) {
  // FL-D05 / FL-D13: the kind of page a framework shows when nobody configured it not to.
  return ctx.html(500, `<!doctype html><html lang="en"><head><title>Internal Server Error</title></head><body>
<h1>500 Internal Server Error</h1>
<pre>TypeError: Cannot read properties of null (reading 'trim')
    at ${where} (/srv/form-lab/handlers.js:42:17)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)</pre></body></html>`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/', ctx => ctx.html(200, layout({
  title: 'All forms', application: APPLICATION, nav,
  body: `<h1 data-testid="page-title">Golden form lab</h1>
<p class="muted">Every kind of form, with known rules and known defects.</p>
<ul data-testid="form-index">
${FORMS.map(form => `<li><a href="${form.route}" data-testid="link-${form.id}">${escapeHtml(form.title)}</a> — ${escapeHtml(form.purpose)}</li>`).join('\n')}
</ul>`
})));

for (const form of FORMS) {
  app.get(form.route, ctx => {
    if (form.session && !ctx.cookies.fl_session) ctx.setCookie('fl_session', `s${Date.now().toString(36)}`);
    return renderForm(ctx, form);
  });
  app.get(`${form.route}/done`, ctx => renderDone(ctx, form));

  if (form.api) continue;
  if (form.method === 'get') continue;

  app.post(form.route, async (ctx) => {
    const body = await ctx.body();

    if (form.session && !ctx.cookies.fl_session) return crash(ctx, 'saveNote');
    if (form.id === 'error-handling') {
      const message = textOf(body.message);
      if (message.length > 1000 || message.trim().toLowerCase() === 'null') return crash(ctx, 'sendSupportMessage');
    }

    const errors = validate(form, body);

    if (form.id === 'login' && Object.keys(errors).length === 0) {
      if (loginFailures >= 5) errors._form = 'Too many attempts. Try again later.';
      else if (body.username !== form.credentials.username || body.password !== form.credentials.password) {
        loginFailures += 1;
        errors._form = 'The username or password is incorrect.';
      }
    }

    if (Object.keys(errors).length > 0) {
      const step = form.multiStep
        ? Math.min(...Object.keys(errors).map(name => form.fields.find(f => f.name === name)?.step ?? 1))
        : undefined;
      const values = { ...body, __step: step };
      for (const field of form.fields) {
        if (field.type === 'file') delete values[field.name];
      }
      return renderForm(ctx, form, values, errors, form.id === 'login' ? 401 : 422);
    }

    // A transaction takes as long as a transaction takes; it is what gives a second click
    // somewhere to land.
    if (form.latencyMs) await sleep(form.latencyMs);
    if (form.slowMs) await sleep(form.slowMs);
    if (form.id === 'login') loginFailures = 0;

    counter += 1;
    const reference = `${form.id.toUpperCase().slice(0, 3)}-${String(counter).padStart(4, '0')}`;
    records.push({
      reference, form: form.id, receivedAt: new Date().toISOString(),
      values: Object.fromEntries(form.fields
        .filter(f => f.type !== 'password' && f.type !== 'file')
        .map(f => [f.name, body[f.name] ?? null]))
    });
    return ctx.redirect(`${form.route}/done?ref=${reference}`, 303);
  });
}

// The search results page: FL-D06, the query is written into the page as markup.
app.get('/search/results', ctx => {
  const q = ctx.query.q ?? '';
  return ctx.html(200, layout({
    title: 'Search results', application: APPLICATION, nav,
    body: `<h1 data-testid="page-title">Search results</h1>
<p role="status" data-testid="search-confirmation">Results for ${q} in ${escapeHtml(ctx.query.category ?? 'All')}</p>
<p data-testid="search-count">No matching items.</p>
<p><a href="/search">Search again</a></p>`
  }));
});

for (const apiForm of FORMS.filter(form => form.api)) {
  app.post(apiForm.api, async (ctx) => {
    const body = await ctx.body();
    const errors = validate(apiForm, body);
    if (Object.keys(errors).length > 0) return ctx.json(422, { errors });
    if (apiForm.latencyMs) await sleep(apiForm.latencyMs);
    counter += 1;
    const reference = `${apiForm.id.toUpperCase().slice(0, 3)}-${String(counter).padStart(4, '0')}`;
    records.push({
      reference, form: apiForm.id, receivedAt: new Date().toISOString(),
      values: Object.fromEntries(apiForm.fields.map(f => [f.name, body[f.name] ?? null]))
    });
    return ctx.json(201, { reference });
  });
}

app.get('/api/records', ctx => ctx.json(200, {
  records: ctx.query.form ? records.filter(r => r.form === ctx.query.form) : records
}));

app.get('/__ground-truth', ctx => ctx.json(200, groundTruth(`http://127.0.0.1:${PORT}`)));

app.post('/__reset', ctx => {
  records = [];
  loginFailures = 0;
  counter = 0;
  return ctx.json(200, { reset: true });
});

await app.listen(PORT);
