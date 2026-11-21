import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksPrivileged } from '../src/checks-authz.mjs';

/**
 * Whether "both roles reached this route" is a defect.
 *
 * The check concluded it was, from that alone, at high severity with "confirmed" CWE
 * confidence and both corroborated and unambiguous set. On any real application most
 * authenticated collections are reachable by every role — that is what a collection is —
 * so a scan would raise one finding per collection, each titled "a route intended for the
 * administrator" about a route intended for everybody. A permit register raised it on the
 * form clerks use to file applications.
 *
 * The route's own name is the only evidence available without discovering the application
 * separately as each role, which this engine does not do. It is a convention rather than
 * proof, which is why the finding that rests on it is reported as likely and not confirmed,
 * and why everything else is inconclusive with the reason stated.
 */
test('a route that names itself administrative is recognised', () => {
  for (const path of ['/admin', '/admin/users', '/api/v1/users', '/settings',
                      '/audit-log', '/back-office/reports', '/system/config',
                      '/manage/roles', '/internal/console']) {
    assert.equal(looksPrivileged(path), true, path);
  }
});

test('an ordinary route is not mistaken for an administrative one', () => {
  for (const path of ['/new.asp', '/list.asp', '/view.asp', '/schedule', '/patients',
                      '/api/appointments', '/shipments', '/orders/99', '/search']) {
    assert.equal(looksPrivileged(path), false, path);
  }
});

/**
 * Matched on whole path segments, which is what keeps the list from catching ordinary
 * routes that merely contain those letters.
 */
test('a segment that merely contains the word does not count', () => {
  assert.equal(looksPrivileged('/user-preferences'), false);
  assert.equal(looksPrivileged('/administrative-area-lookup'), false);
  assert.equal(looksPrivileged('/reporting'), false);
  assert.equal(looksPrivileged('/systemic-risk'), false);
});

test('a hyphenated or dotted administrative route still counts', () => {
  assert.equal(looksPrivileged('/audit_log'), true);
  assert.equal(looksPrivileged('/admin.aspx'), true);
  assert.equal(looksPrivileged('/back-office'), true);
});

test('an absolute URL and a query string are both handled', () => {
  assert.equal(looksPrivileged('http://host/admin/users?page=2'), true);
  assert.equal(looksPrivileged('http://host/orders?status=admin'), false,
    'a query value is not the route');
});

test('nothing usable reads as not administrative rather than throwing', () => {
  assert.equal(looksPrivileged(''), false);
  assert.equal(looksPrivileged(undefined), false);
  assert.equal(looksPrivileged(null), false);
});
