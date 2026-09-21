/**
 * The failure matrix.
 *
 * One page per failure class, each identical in shape: a heading, a button that performs
 * the work, and a single `outcome` element that reads `OK 42` when the work succeeds. The
 * uniform shape is the point — the *only* difference between a passing case and a failing
 * one is the failure itself, so a classifier's answer can be attributed to the failure and
 * nothing else.
 *
 * Classes: HTTP 400, 401, 403, 404 and 500; a request that never answers; a connection
 * destroyed mid-flight; an uncaught JavaScript error; a value that is wrong rather than
 * missing; and an element that is simply not there.
 */
import { createLabApp, escapeHtml } from '../shared/http.js';
import { createFaultEngine } from '../shared/faults.js';
import { layout } from '../shared/render.js';

const PORT = Number(process.env.FAILURE_PORT ?? 4340);
const APPLICATION = 'AIRA Failure Lab';
const CORRECT_ANSWER = 42;

const CASES = [
  { name: 'healthy', title: 'Everything works', expectation: 'The outcome reads "OK 42".', classification: null },
  { name: 'http-400', title: 'Bad request', expectation: 'The API answers 400 and the page says so.', classification: 'applicationError' },
  { name: 'http-401', title: 'Unauthorized', expectation: 'The API answers 401.', classification: 'authenticationFailure' },
  { name: 'http-403', title: 'Forbidden', expectation: 'The API answers 403.', classification: 'authorizationFailure' },
  { name: 'http-404', title: 'Not found', expectation: 'The API answers 404.', classification: 'applicationError' },
  { name: 'http-500', title: 'Server error', expectation: 'The API answers 500.', classification: 'applicationError' },
  { name: 'timeout', title: 'No answer', expectation: 'The API never answers.', classification: 'timeout' },
  { name: 'connection-reset', title: 'Connection destroyed', expectation: 'The connection is dropped mid-request.', classification: 'networkError' },
  { name: 'js-error', title: 'Uncaught JavaScript error', expectation: 'The handler throws before it can render.', classification: 'javascriptError' },
  { name: 'wrong-value', title: 'Wrong value', expectation: 'The outcome renders, but reads 99 instead of 42.', classification: 'assertionFailed' },
  { name: 'missing-element', title: 'Missing element', expectation: 'The outcome element is never rendered.', classification: 'elementNotFound' },
  { name: 'slow', title: 'Slow but correct', expectation: 'The outcome appears after a delay and is correct.', classification: null }
];

const FAULTS = [
  { id: 'FAULT_ALL_CASES_HEALTHY', description: 'Every case behaves like the healthy one. Used to prove a suite fails when it should pass, and passes when it should.' },
  { id: 'FAULT_SLOW_ELEMENT', description: 'The slow case takes even longer.' }
];

const faults = createFaultEngine(FAULTS, { parameters: { slowElementMs: 3000, timeoutMs: 60_000 } });
const app = createLabApp({ name: APPLICATION, version: '1.0.0', faults });

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

app.get('/', ctx => ctx.html(200, layout({
  title: 'Failure cases',
  application: APPLICATION,
  body: `
<h1 data-testid="page-title">Failure cases</h1>
<p class="muted">Each case is the same page with one thing wrong. The healthy case is first; it is what every other case is measured against.</p>
<table data-testid="case-table">
  <thead><tr><th>Case</th><th>What happens</th><th>Expected classification</th></tr></thead>
  <tbody>
    ${CASES.map(testCase => `
    <tr data-testid="case-row-${testCase.name}">
      <td><a href="/case/${testCase.name}" data-testid="open-case-${testCase.name}">${escapeHtml(testCase.title)}</a></td>
      <td>${escapeHtml(testCase.expectation)}</td>
      <td><code>${testCase.classification ?? 'passes'}</code></td>
    </tr>`).join('')}
  </tbody>
</table>`
})));

app.get('/case/:name', (ctx) => {
  const testCase = CASES.find(candidate => candidate.name === ctx.params.name);
  if (!testCase) return ctx.json(404, { error: 'unknown_case' });

  const effective = faults.on('FAULT_ALL_CASES_HEALTHY') ? 'healthy' : testCase.name;

  ctx.html(200, layout({
    title: testCase.title,
    application: APPLICATION,
    nav: [['/', 'All cases', 'nav-cases']],
    body: `
<h1 data-testid="page-title">${escapeHtml(testCase.title)}</h1>
<p class="muted" data-testid="case-expectation">${escapeHtml(testCase.expectation)}</p>

<div class="card">
  <button type="button" class="primary" data-testid="run-case">Calculate the answer</button>
  <p id="outcome-slot" data-testid="outcome-slot">
    ${effective === 'missing-element' ? '' : '<span data-testid="outcome">not calculated</span>'}
  </p>
  <p class="error" data-testid="failure-detail" hidden></p>
</div>`,
    script: clientScript(effective)
  }));
});

/**
 * The page's own behaviour for a case.
 *
 * Written as source rather than assembled from fragments so that what the browser runs is
 * legible in one piece — this application's job is to be understood when a test fails.
 */
function clientScript(name) {
  return `
const outcomeSlot = document.querySelector('[data-testid="outcome-slot"]');
const detail = document.querySelector('[data-testid="failure-detail"]');
const say = (text) => {
  const target = document.querySelector('[data-testid="outcome"]');
  if (target) target.textContent = text;
};
const fail = (text) => { detail.hidden = false; detail.textContent = text; };

document.querySelector('[data-testid="run-case"]').addEventListener('click', async () => {
  detail.hidden = true;
  say('calculating…');

  ${name === 'js-error' ? `
  // Thrown before anything is rendered: the page stays on screen, the work never happens.
  throw new Error('LAB_FAILURE_JS_ERROR: the calculator could not be initialised');
  ` : ''}

  ${name === 'wrong-value' ? `
  say('OK 99');
  return;
  ` : ''}

  ${name === 'missing-element' ? `
  outcomeSlot.textContent = 'The result element was not rendered.';
  return;
  ` : ''}

  try {
    const response = await fetch('/api/answer?case=${name}');
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      fail('The calculator failed with HTTP ' + response.status + (body.message ? ': ' + body.message : ''));
      say('failed');
      return;
    }
    const body = await response.json();
    say('OK ' + body.answer);
  } catch (error) {
    fail('The calculator could not be reached: ' + error.message);
    say('failed');
  }
});
`;
}

// ---------------------------------------------------------------------------
// The API each case calls
// ---------------------------------------------------------------------------

app.get('/api/answer', async (ctx) => {
  const name = faults.on('FAULT_ALL_CASES_HEALTHY') ? 'healthy' : (ctx.query.case ?? 'healthy');

  switch (name) {
    case 'http-400': return ctx.json(400, { error: 'bad_request', message: 'The request was not understood.' });
    case 'http-401': return ctx.json(401, { error: 'unauthenticated', message: 'Sign in to use the calculator.' });
    case 'http-403': return ctx.json(403, { error: 'forbidden', message: 'This account may not use the calculator.' });
    case 'http-404': return ctx.json(404, { error: 'not_found', message: 'No calculator by that name.' });
    case 'http-500': return ctx.json(500, { error: 'internal_error', message: 'The calculator crashed.' });
    case 'timeout':
      await sleep(faults.parameter('timeoutMs'));
      return ctx.json(200, { answer: CORRECT_ANSWER });
    case 'connection-reset':
      return ctx.destroy();
    case 'slow':
      await sleep(faults.on('FAULT_SLOW_ELEMENT') ? faults.parameter('slowElementMs') * 3 : faults.parameter('slowElementMs'));
      return ctx.json(200, { answer: CORRECT_ANSWER });
    default:
      return ctx.json(200, { answer: CORRECT_ANSWER });
  }
});

/** Status codes on a navigation rather than on a fetch: a page that itself fails to load. */
app.get('/direct/:code', (ctx) => {
  const code = Number(ctx.params.code);
  if (!Number.isInteger(code) || code < 400 || code > 599) return ctx.json(400, { error: 'bad_code' });
  ctx.buffer(code, { 'content-type': 'text/html; charset=utf-8' },
    Buffer.from(`<!doctype html><title>${code}</title><h1 data-testid="status-heading">HTTP ${code}</h1>`));
});

app.post('/__reset', ctx => ctx.json(200, { reset: true, faults: faults.reset() }));

await app.listen(PORT);
