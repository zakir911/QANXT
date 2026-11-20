import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carriesData } from '../src/checks-authz.mjs';

/**
 * Whether a response served anything — the question an authorization finding rests on, and
 * the one the check did not ask.
 *
 * The first case is the exact document that produced three critical "protected data is
 * served to an unauthenticated caller" findings on a three-screen clinical scheduler. On a
 * real application with fifty routes it would have produced fifty, and a tool that does
 * that is not used twice.
 */
const SHELL = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Clinic Scheduler</title></head>
<body><div id="root"></div><script src="/app.js"></script></body></html>`;

const html = (text) => ({ responseText: text, responseHeaders: { 'content-type': 'text/html; charset=utf-8' } });

test('a client-rendered shell carries no data', () => {
  const verdict = carriesData(html(SHELL));
  assert.equal(verdict.hasData, false);
  assert.match(verdict.why, /application shell/);
});

test('a server-rendered page carries data', () => {
  const page = html(`<html><body><h1>Permit register</h1>
    <table><tr><td>BP-2026-0001</td><td>H. Devi</td><td>14 Mill Lane</td><td>submitted</td></tr>
    <tr><td>BP-2026-0002</td><td>R. Osei</td><td>2 Quarry Road</td><td>approved</td></tr></table>
    </body></html>`);
  const verdict = carriesData(page);
  assert.equal(verdict.hasData, true);
  assert.match(verdict.why, /characters of visible text/);
});

test('a shell whose script is long is still a shell', () => {
  // The guard that matters: a bundled SPA ships kilobytes of script and no content.
  const withBundle = html(`<html><head><title>App</title></head><body><div id="root"></div>
    <script>${'const x=1;'.repeat(4000)}</script></body></html>`);
  assert.equal(carriesData(withBundle).hasData, false);
});

test('a JSON body with fields is data', () => {
  const verdict = carriesData({ responseBody: { id: 'pat-1', name: 'A. Mensah', nhsNumber: '401 023 1199' } });
  assert.equal(verdict.hasData, true);
});

test('a JSON list with items is data, and an empty one is not', () => {
  assert.equal(carriesData({ responseBody: [{ id: 1 }] }).hasData, true);
  assert.equal(carriesData({ responseBody: [] }).hasData, false);
  assert.equal(carriesData({ responseBody: {} }).hasData, false);
});

/**
 * An error envelope answers 200 on plenty of APIs. It is the application declining, not
 * data, and reading it as an exposure is the same mistake in a different wrapper.
 */
test('a JSON error envelope is not data', () => {
  assert.equal(carriesData({ responseBody: { error: 'unauthenticated' } }).hasData, false);
  assert.equal(carriesData({ responseBody: { message: 'Not found', detail: 'no such patient' } }).hasData, false);
});

test('a body carrying a record alongside a message is data', () => {
  const verdict = carriesData({ responseBody: { message: 'ok', id: 'pat-1', name: 'A. Mensah', nhsNumber: 'x' } });
  assert.equal(verdict.hasData, true, 'four fields including a record is not an error envelope');
});

test('an empty body is not data', () => {
  assert.equal(carriesData({ responseText: '' }).hasData, false);
  assert.equal(carriesData({ responseText: '   \n ' }).hasData, false);
  assert.equal(carriesData({}).hasData, false);
});

test('a non-markup body is taken at face value', () => {
  const csv = { responseText: 'ref,applicant\nBP-0001,H. Devi\nBP-0002,R. Osei\n',
                responseHeaders: { 'content-type': 'text/csv' } };
  assert.equal(carriesData(csv).hasData, true);
});
