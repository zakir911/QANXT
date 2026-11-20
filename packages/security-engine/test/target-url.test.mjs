import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, pathOf } from '../src/target-url.mjs';

/**
 * Where a probe goes, which until now was wherever string concatenation put it.
 *
 * Forty-one call sites built `${baseUrl}${path}`. Against a base URL with no path that is
 * right, and every target in the lab had one, so nothing caught it. Against
 * `http://host/schedule` it produced `http://host/schedule/api/session`, and a scan of a
 * client-rendered application reported twelve header findings measured on its 404 page.
 *
 * The first three cases are the exact URLs that run produced.
 */
test('an absolute path resolves against the origin, not the base path', () => {
  assert.equal(at('http://127.0.0.1:4600/schedule', '/api/session'),
    'http://127.0.0.1:4600/api/session');
  assert.equal(at('http://127.0.0.1:4600/schedule', '/schedule'),
    'http://127.0.0.1:4600/schedule');
  assert.equal(at('http://127.0.0.1:4700/default.asp', '/list.asp'),
    'http://127.0.0.1:4700/list.asp');
});

test('a base URL with no path of its own is unchanged in behaviour', () => {
  assert.equal(at('http://127.0.0.1:4400', '/api/orders'), 'http://127.0.0.1:4400/api/orders');
  assert.equal(at('http://127.0.0.1:4400/', '/api/orders'), 'http://127.0.0.1:4400/api/orders');
});

test('a query string the caller already built is carried through', () => {
  assert.equal(at('http://host/app/', '/search?q=a+b'), 'http://host/search?q=a+b');
  assert.equal(at('http://host/app', "/x?p=%3Cscript%3E"), 'http://host/x?p=%3Cscript%3E');
});

test('a port, a scheme and a deep base path are all preserved', () => {
  assert.equal(at('https://host:8443/a/b/c', '/api/v1/orders/9'),
    'https://host:8443/api/v1/orders/9');
});

/**
 * A malformed probe must fail as a refused request with a reason the scanner reports, not
 * as an exception that loses the whole scan.
 */
test('an unparseable base URL comes back joined rather than throwing', () => {
  assert.equal(at('not a url', '/x'), 'not a url/x');
});

test('pathOf names the path a finding should carry', () => {
  assert.equal(pathOf('http://127.0.0.1:4600/api/session'), '/api/session');
  assert.equal(pathOf('http://host/search?q=delete'), '/search');
  assert.equal(pathOf('/already/a/path'), '/already/a/path');
});
