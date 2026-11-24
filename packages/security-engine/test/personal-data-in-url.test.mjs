import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkPersonalDataInUrl, formsSubmittingPersonalDataByGet, personalParameterName
} from '../src/checks-passive.mjs';

/**
 * Personal data in a URL.
 *
 * The sensitive-data check deliberately ignores email addresses and telephone numbers,
 * because a support address in a footer is not a leak. That holds for a response body and
 * does not transfer to a query string, which is written to access logs, proxy logs, browser
 * history and the Referer header. Same data, different exposure, and the scanner could not
 * see this one at all.
 *
 * Most of these tests are about not crying wolf. A check reporting every `?name=` and
 * `?id=` on a large application would be read once and then skipped, which costs more than
 * the finding is worth — so the names are few and the ordinary ones must stay quiet.
 */

const page = (html, url = 'http://app.test/customers') => ({ html, url });

const run = async ({ html = '', url = 'http://app.test/customers' }) => {
  const scanner = {
    async request() {
      return { allowed: true, status: 200, responseBody: html, headers: { getSetCookie: () => [] } };
    }
  };
  return checkPersonalDataInUrl(scanner, url, 'passive.pii-in-url');
};

const GET_FORM = '<form method="get" action="/customers">'
  + '<input name="contactEmail" type="email" /><button>Find</button></form>';

test('a form submitting an email field by GET is a finding', async () => {
  const result = await run(page(GET_FORM));

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].cwe, 'CWE-598');
  assert.equal(result.findings[0].category, 'PersonalDataInUrl');
  assert.match(result.findings[0].title, /submits contactEmail by GET/);
});

test('a form with no method at all is caught, because HTML submits by GET', async () => {
  // The common way this arrives: nobody chose GET.
  const result = await run(page('<form action="/search"><input name="email" type="email" /></form>'));

  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].description, /declares no method at all and GET is what HTML does/);
});

test('the same form posting is not a finding', async () => {
  const result = await run(page(GET_FORM.replace('method="get"', 'method="post"')));

  assert.deepEqual(result.findings, []);
});

test('an email in the query string of the address under test is a finding', async () => {
  const result = await run({ url: 'http://app.test/customers?contactEmail=someone%40example.test' });

  const parameter = result.findings.find(f => f.parameter === 'contactEmail');
  assert.ok(parameter);
  assert.equal(parameter.cwe, 'CWE-598');
  assert.match(parameter.description, /access log/);
});

test('a value that corroborates the name raises confidence, and its absence does not lower the finding', async () => {
  const withValue = await run({ url: 'http://app.test/customers?email=rowan%40meridian.test' });
  const empty = await run({ url: 'http://app.test/customers?email=' });

  assert.equal(withValue.findings.length, 1);
  assert.equal(empty.findings.length, 1, 'the parameter is the fault, whatever is in it today');
  assert.notEqual(withValue.findings[0].confidence, empty.findings[0].confidence);
});

test('the value itself is never written into the finding', async () => {
  const result = await run({ url: 'http://app.test/customers?email=rowan%40meridian.test' });

  const serialised = JSON.stringify(result.findings.map(f =>
    ({ title: f.title, description: f.description, remediation: f.remediation })));
  assert.equal(serialised.includes('rowan'), false);
});

test('ordinary parameters stay quiet', async () => {
  for (const name of ['q', 'id', 'name', 'page', 'tier', 'reference', 'account', 'sort',
                      'status', 'from', 'to', 'customerId', 'orderNumber', 'search']) {
    assert.equal(personalParameterName(name), null, `${name} must not be treated as personal`);
  }
});

test('a personal name is recognised whatever the spelling convention', () => {
  for (const name of ['contactEmail', 'contact_email', 'contact-email', 'CONTACTEMAIL']) {
    assert.equal(personalParameterName(name), 'contactemail');
  }
});

test('an ordinary search form is not a finding', async () => {
  const result = await run(page(
    '<form method="get" action="/shipments"><input name="q" type="search" /></form>'));

  assert.deepEqual(result.findings, []);
});

test('a tel input is personal even when its name is not', async () => {
  const result = await formsSubmittingPersonalDataByGet(
    '<form method="get"><input name="contact" type="tel" /></form>');

  assert.equal(result.length, 1);
  assert.deepEqual(result[0].fields, ['contact']);
});

test('a page with neither query nor form says so rather than reporting clean', async () => {
  const result = await run(page('<p>Nothing here.</p>', 'http://app.test/about'));

  assert.equal(result.inconclusive, true);
  assert.match(result.reason, /^Not evaluated:/);
  assert.match(result.reason, /nothing that could put personal data into a URL/);
});

test('a page with a form and no personal field is clean, not inconclusive', async () => {
  const result = await run(page('<form method="get"><input name="q" /></form>'));

  assert.deepEqual(result.findings, []);
  assert.notEqual(result.inconclusive, true);
});

test('several personal fields in one form are one finding naming them all', async () => {
  const result = await run(page(
    '<form method="get"><input name="email" type="email" /><input name="dob" /></form>'));

  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].title, /email, dob/);
});

test('a refused request is a refusal, not a clean page', async () => {
  const refusing = {
    async request() { return { allowed: false, decision: { reason: 'out of scope' } }; }
  };
  const result = await checkPersonalDataInUrl(refusing, 'http://app.test/x', 'passive.pii-in-url');

  assert.equal(result.skipped, true);
  assert.deepEqual(result.findings, []);
});
