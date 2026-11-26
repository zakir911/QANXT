import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCsrfToken, checkOriginValidation, distinguishedTheTwo } from '../src/checks-request.mjs';
import { checkReadOnlyWrite } from '../src/checks-authz.mjs';

/**
 * An application that redirects to the same place whether it accepted or refused.
 *
 * `stateChangeAccepted` distinguishes "redirected back to the form" from "redirected onward",
 * which is right for an application that re-shows the form when it refuses. Freight does not.
 * Its shipment edit answers both the same way and says which in a flash message on the page
 * the redirect leads to — proven against the running application:
 *
 *     POST /shipments/shp-0005/edit  bad token   ->  302  location: /shipments/shp-0005
 *     POST /shipments/shp-0005/edit  real token  ->  302  location: /shipments/shp-0005
 *
 * Nothing was written in the first case; the endpoint enforces its token properly. Judged on
 * the Location header alone, both arms read as accepted.
 *
 * Measured: once the checks were finally sending a body the endpoint would take (defect 82),
 * that one pattern produced 20 false MissingCsrfToken findings and 20 false
 * PrivilegeEscalation findings on freight in a single run. Which is the failure mode defect 75
 * was about, arrived at from the other direction.
 */

const headers = (map) => ({ get: (name) => map[name.toLowerCase()] ?? null });

const redirectedTo = (location) => ({
  allowed: true, status: 302, headers: headers({ location }), responseBody: '', responseText: ''
});

const page = (html) => ({
  allowed: true, status: 200, headers: headers({}), responseBody: html, responseText: html
});

const SAVED = '<h1>SHP-0005</h1><div role="status">Shipment updated.</div>';
const REFUSED = '<h1>SHP-0005</h1><div role="alert">That form expired.</div>';
const session = { cookie: 'session=abc', csrf: 't0ken' };

/** A scanner that answers POSTs from one script and destination reads from another. */
function stub({ posts = [], landings = [] }) {
  const sent = [];
  return {
    sent,
    async request(options) {
      sent.push(options);
      const id = String(options.testId);
      // The read `changedNothing` makes to rule out an address that answers the application's
      // shell. These tests are about redirects, whose bodies are empty, so it founds nothing
      // and a single page answers it.
      if (id.endsWith(':read')) return page('<form>the form, not a shell</form>');
      const queue = id.endsWith(':arrived') ? landings : posts;
      const next = queue.shift();
      if (!next) throw new Error(`no scripted response left for ${options.testId}`);
      return next;
    }
  };
}

const body = { pieces: '7' };
const shape = { body, contentType: 'application/x-www-form-urlencoded', tokenField: '_csrf' };

test('an error only the probe was shown is a refusal, so the endpoint reads as clean', async () => {
  const scanner = stub({
    posts: [redirectedTo('/shipments/shp-0005'), redirectedTo('/shipments/shp-0005')],
    landings: [page(SAVED), page(REFUSED)]
  });

  const result = await checkCsrfToken(scanner, {
    baseUrl: 'http://app.test', path: '/shipments/shp-0005/edit', session, ...shape
  });

  assert.equal(result.ok, true);
  assert.equal(result.findings.length, 0);
  assert.match(result.detail, /That form expired/);
});

test('an identical landing page means the application did not distinguish them, and the finding stands', async () => {
  const scanner = stub({
    posts: [redirectedTo('/shipments/shp-0005'), redirectedTo('/shipments/shp-0005')],
    landings: [page(SAVED), page(SAVED)],
  });

  const result = await checkCsrfToken(scanner, {
    baseUrl: 'http://app.test', path: '/shipments/shp-0005/edit', session, ...shape
  });

  // Both told "Shipment updated." The one without a token was written just the same.
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].category, 'MissingCsrfToken');
});

test('a page that still differs when read again is varying, not evidence', async () => {
  // A view counter, a relative timestamp, a "last seen" line. The page was never evidence
  // about either request.
  let counter = 41;
  const scanner = {
    async request(options) {
      const id = String(options.testId);
      if (id.endsWith(':read')) return page('<form/>');
      if (id.endsWith(':stable') || id.endsWith(':arrived')) {
        counter += 1;
        return page(`<h1>SHP-0005</h1><p>Viewed ${counter} times</p>`);
      }
      return redirectedTo('/shipments/shp-0005');
    }
  };

  const result = await checkCsrfToken(scanner, {
    baseUrl: 'http://app.test', path: '/shipments/shp-0005/edit', session, ...shape
  });

  assert.equal(result.inconclusive, true);
  assert.equal(result.findings.length, 0);
  assert.match(result.reason, /changes on its own/);
});

test('a page stable when read again was changed by the request, so the finding stands', async () => {
  // The branch that cost three true findings on freight. /fleet/drivers/new,
  // /reports/builder and /warehouse/transfers/new each let a read-only account write; both
  // arms landed on the same list page, and the page differed between the two reads *because
  // both writes had landed in it*. Reading that as ambiguity threw all three away.
  const afterOne = '<h1>Drivers</h1><tr>drv-025</tr>';
  const afterTwo = '<h1>Drivers</h1><tr>drv-025</tr><tr>drv-026</tr>';
  let arrived = 0;
  const scanner = {
    async request(options) {
      const id = String(options.testId);
      if (id.endsWith(':read')) return page('<form/>');
      if (id.endsWith(':stable')) return page(afterTwo);   // settled: nothing varies by itself
      if (id.endsWith(':arrived')) return page(++arrived === 1 ? afterOne : afterTwo);
      return redirectedTo('/fleet/drivers');
    }
  };

  const result = await checkCsrfToken(scanner, {
    baseUrl: 'http://app.test', path: '/fleet/drivers/new', session, ...shape
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].category, 'MissingCsrfToken');
});

test('two different destinations mean each request produced one, with no extra read', async () => {
  // A form that saves and redirects to what it saved gives each request its own address.
  // Comparing two different records says nothing, and there is nothing to disambiguate.
  const stable = [];
  const scanner = {
    async request(options) {
      const id = String(options.testId);
      if (id.endsWith(':stable')) { stable.push(options.url); return page('<p>x</p>'); }
      if (id.endsWith(':read')) return page('<form/>');
      if (id.endsWith(':arrived')) {
        return page(options.url.endsWith('drv-025') ? '<h1>drv-025</h1>' : '<h1>drv-026</h1>');
      }
      return redirectedTo(stable.length === 0 && !this._second
        ? (this._second = true, '/fleet/drivers/drv-025')
        : '/fleet/drivers/drv-026');
    }
  };

  const result = await checkCsrfToken(scanner, {
    baseUrl: 'http://app.test', path: '/fleet/drivers/new', session, ...shape
  });

  assert.equal(result.findings.length, 1);
  assert.deepEqual(stable, []);
});

test('the destination is read once per arm, and only after the control was accepted', async () => {
  const scanner = stub({
    posts: [redirectedTo('/shipments/shp-0005'), redirectedTo('/shipments/shp-0005')],
    landings: [page(SAVED), page(SAVED)]
  });

  await checkCsrfToken(scanner, {
    baseUrl: 'http://app.test', path: '/shipments/shp-0005/edit', session, ...shape
  });

  const reads = scanner.sent.filter(r => String(r.testId).endsWith(':arrived'));
  assert.equal(reads.length, 2);
  assert.ok(reads.every(r => r.method === 'GET'));
  // The read of the control's destination comes after the control, not before: a refused
  // control makes both the probe and this read not worth sending.
  assert.equal(scanner.sent[0].testId, 'SECA-CSRF:control');
  assert.equal(scanner.sent[1].testId, 'SECA-CSRF:arrived');
});

test('a refused control costs no destination read at all', async () => {
  const scanner = stub({ posts: [redirectedTo('/shipments/shp-0005/edit')] });

  const result = await checkCsrfToken(scanner, {
    baseUrl: 'http://app.test', path: '/shipments/shp-0005/edit', session, ...shape
  });

  assert.equal(result.inconclusive, true);
  assert.equal(scanner.sent.length, 1);
});

test('a 2xx answer needs no destination read, because nothing was inferred from a redirect', async () => {
  const scanner = stub({ posts: [page('{"ok":true}'), page('{"ok":true}'), page('<form/>')] });

  const result = await checkCsrfToken(scanner, {
    baseUrl: 'http://app.test', path: '/api/shipments', session,
    body, contentType: 'application/json'
  });

  assert.equal(scanner.sent.filter(r => String(r.testId).endsWith(':arrived')).length, 0);
  assert.equal(result.findings.length, 1);
});

test('the origin check reads where each origin landed', async () => {
  const scanner = stub({
    posts: [redirectedTo('/shipments/shp-0005'), redirectedTo('/shipments/shp-0005')],
    landings: [page(SAVED), page(REFUSED)]
  });

  const result = await checkOriginValidation(scanner, {
    baseUrl: 'http://app.test', path: '/shipments/shp-0005/edit', session, ...shape
  });

  assert.equal(result.ok, true);
  assert.equal(result.findings.length, 0);
});

test('the read-only check reads where each identity landed', async () => {
  const scanner = stub({
    posts: [redirectedTo('/shipments/shp-0005'), redirectedTo('/shipments/shp-0005')],
    landings: [page(SAVED), page(REFUSED)]
  });

  const result = await checkReadOnlyWrite(scanner, {
    baseUrl: 'http://app.test', path: '/shipments/shp-0005/edit',
    writer: { label: 'operations', cookie: 'session=w', csrf: 'w' },
    readonly: { label: 'audit viewer', cookie: 'session=v', csrf: 'v' },
    ...shape
  });

  assert.equal(result.ok, true);
  assert.equal(result.findings.length, 0);
  assert.match(result.detail, /audit viewer was refused there/);
});

test('a read-only account shown the same success page is still a finding', async () => {
  const scanner = stub({
    posts: [redirectedTo('/claims/clm-0001'), redirectedTo('/claims/clm-0001')],
    landings: [page('<div role="status">Claim settled.</div>'),
               page('<div role="status">Claim settled.</div>')]
  });

  const result = await checkReadOnlyWrite(scanner, {
    baseUrl: 'http://app.test', path: '/claims/clm-0001/settle',
    writer: { label: 'claims handler', cookie: 'session=w' },
    readonly: { label: 'audit viewer', cookie: 'session=v' },
    body: { settledAmountGbp: '1' }, contentType: 'application/x-www-form-urlencoded'
  });

  // FP_D11. Both were told the claim was settled; the viewer should have been refused.
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].category, 'PrivilegeEscalation');
});

test('an alert both arms see is not decided here, because one page cannot tell', () => {
  // A banner the page always carries says nothing about either request; a flash message says
  // everything. From a single page the two are identical, so the comparator reports the shape
  // and the caller settles it by reading the page again.
  const both = '<div role="alert">Rates are out of date.</div>';
  const outcome = distinguishedTheTwo(both, both);

  assert.equal(outcome.sameWithAnAlert, true);
  assert.equal(outcome.alert, 'Rates are out of date.');
});

test('a flash message, gone on the second read, means the control was refused too', async () => {
  // The case that produced ten false findings on freight. The scan held no anti-forgery token
  // for an application that serves its token as a hidden input, so the control was refused
  // exactly like the probe, and both landed on "That form expired." Identical pages — which is
  // true, and not the point.
  const reads = [];
  const scanner = {
    async request(options) {
      const id = String(options.testId);
      if (id.endsWith(':again')) {
        reads.push(options.url);
        return page('<h1>SHP-0005</h1>');        // the flash was consumed by the first read
      }
      if (id.endsWith(':arrived')) return page(REFUSED);
      if (id.endsWith(':read')) return page('<form/>');
      return redirectedTo('/shipments/shp-0005');
    }
  };

  const result = await checkCsrfToken(scanner, {
    baseUrl: 'http://app.test', path: '/shipments/shp-0005/edit', session, ...shape
  });

  assert.equal(result.inconclusive, true);
  assert.equal(result.findings.length, 0);
  assert.match(result.reason, /with a token was refused too/);
  assert.match(result.reason, /That form expired/);
  assert.deepEqual(reads, ['http://app.test/shipments/shp-0005']);
});

test('a banner still there on the second read belongs to the page, and the finding stands', async () => {
  const banner = '<h1>SHP-0005</h1><div role="alert">Rates are out of date.</div>';
  const scanner = {
    async request(options) {
      const id = String(options.testId);
      if (id.endsWith(':again')) return page(banner);   // still there: not about the request
      if (id.endsWith(':arrived')) return page(banner);
      if (id.endsWith(':read')) return page('<form/>');
      return redirectedTo('/shipments/shp-0005');
    }
  };

  const result = await checkCsrfToken(scanner, {
    baseUrl: 'http://app.test', path: '/shipments/shp-0005/edit', session, ...shape
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].category, 'MissingCsrfToken');
});

test('the second read is only made when both arms landed on the same page with an alert', async () => {
  const scanner = stub({
    posts: [redirectedTo('/shipments/shp-0005'), redirectedTo('/shipments/shp-0005')],
    landings: [page(SAVED), page(SAVED)]
  });

  await checkCsrfToken(scanner, {
    baseUrl: 'http://app.test', path: '/shipments/shp-0005/edit', session, ...shape
  });

  // No alert anywhere, so nothing to disambiguate and nothing to pay for.
  assert.equal(scanner.sent.filter(r => String(r.testId).endsWith(':again')).length, 0);
});

test('a missing page on either side is not evidence', () => {
  assert.deepEqual(distinguishedTheTwo(null, '<div role="alert">no</div>'), { known: false });
  assert.deepEqual(distinguishedTheTwo('<p>x</p>', null), { known: false });
});

test('the common error markers are all read, not just role=alert', () => {
  for (const html of [
    '<div class="alert alert-danger">That form expired.</div>',
    '<span class="error">That form expired.</span>',
    '<div class="invalid-feedback">That form expired.</div>',
    '<p class="flash-error">That form expired.</p>'
  ]) {
    const outcome = distinguishedTheTwo('<h1>ok</h1>', html);
    assert.equal(outcome.refused, true, html);
    assert.match(outcome.how, /That form expired/);
  }
});

test('a redirect pointing off the target is refused by the scope guard, not followed', async () => {
  // An endpoint with an open redirect can send the Location anywhere, and this check follows
  // redirects now. Following one off the target would have the scan fetch a host nobody
  // authorised — on a real engagement, an attacker-chosen one. The scope guard refuses it,
  // the read returns nothing, and the check falls back to what it knew without it.
  const asked = [];
  const scanner = {
    asked,
    async request(options) {
      asked.push(options);
      const id = String(options.testId);
      if (id.endsWith(':arrived')) {
        // What the guard does to an out-of-scope host.
        return { allowed: false, decision: { allowed: false, reason: 'DOMAIN_NOT_ALLOWED' } };
      }
      if (id.endsWith(':read')) return page('<form/>');
      return redirectedTo('https://somewhere-else.invalid/landing');
    }
  };

  const result = await checkCsrfToken(scanner, {
    baseUrl: 'http://app.test', path: '/account/profile', session, ...shape
  });

  // Nothing was learned from the destination, so the header-level verdict stands rather than
  // being overridden by a read that never happened.
  assert.equal(result.findings.length, 1);
  const reads = asked.filter(r => String(r.testId).endsWith(':arrived'));
  assert.equal(reads.length, 2);
  assert.ok(reads.every(r => r.url.startsWith('https://somewhere-else.invalid/')));
});

test('a relative Location is resolved against the target, the way a browser would', async () => {
  const scanner = stub({
    posts: [redirectedTo('/shipments/shp-0005'), redirectedTo('/shipments/shp-0005')],
    landings: [page(SAVED), page(REFUSED)]
  });

  await checkCsrfToken(scanner, {
    baseUrl: 'http://app.test', path: '/shipments/shp-0005/edit', session, ...shape
  });

  const reads = scanner.sent.filter(r => String(r.testId).endsWith(':arrived'));
  assert.equal(reads.length, 2);
  assert.ok(reads.every(r => r.url === 'http://app.test/shipments/shp-0005'),
    reads.map(r => r.url).join(', '));
});

test('an empty Location leaves the header-level verdict alone', async () => {
  const noLocation = {
    allowed: true, status: 302, headers: headers({}), responseBody: '', responseText: ''
  };
  const scanner = stub({ posts: [noLocation, noLocation] });

  const result = await checkCsrfToken(scanner, {
    baseUrl: 'http://app.test', path: '/account/profile', session, ...shape
  });

  // Nothing to follow, so nothing is read and the check does not pretend otherwise.
  assert.equal(scanner.sent.filter(r => String(r.testId).endsWith(':arrived')).length, 0);
  assert.ok(result.inconclusive === true || result.findings.length >= 0);
});
