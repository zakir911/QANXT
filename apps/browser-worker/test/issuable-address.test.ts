import { describe, expect, it } from 'vitest';
import { issuableAddress } from '../src/security/issuable-address';
import type { SecurityTarget } from '@qa-nxt/shared-types';

/**
 * Which address a check sends its request to.
 *
 * The surface groups endpoints by a template with the query stripped, so /view.asp?id=1 and
 * /view.asp?id=2 are one endpoint. Issue a request to that template against an application
 * that identifies a record in the query string and you reach a page that does not exist.
 *
 * Measured on permits-legacy: authz.missing, authz.vertical and api.excessive-data were all
 * pointed at /approve.asp with no id, all three received 404, and all three reported honestly
 * that they could not tell whether the route was reachable. Nothing was broken, nothing was
 * tested, and the scan looked fine.
 */
const target = (over: Partial<SecurityTarget>): SecurityTarget => ({
  kind: 'endpoint',
  identifier: '/approve.asp',
  requiresAuthentication: true,
  parameters: [],
  checks: [],
  ...over
});

describe('issuableAddress', () => {
  it('prefers the sample when the template dropped the query', () => {
    expect(issuableAddress(target({
      identifier: 'http://app.test/approve.asp',
      sampleUrl: 'http://app.test/approve.asp?id=1'
    }))).toBe('http://app.test/approve.asp?id=1');
  });

  it('leaves a template carrying a placeholder alone', () => {
    // The check substitutes into it itself, with an identifier it owns. Replacing it with a
    // sample would point the check at one particular record instead.
    expect(issuableAddress(target({
      identifier: '/api/orders/{id}',
      sampleUrl: 'http://app.test/api/orders/ord-1'
    }))).toBe('/api/orders/{id}');
  });

  it('keeps the identifier when it already carries a query', () => {
    expect(issuableAddress(target({
      identifier: 'http://app.test/report?view=all',
      sampleUrl: 'http://app.test/report?view=mine'
    }))).toBe('http://app.test/report?view=all');
  });

  it('keeps the identifier when the sample adds nothing', () => {
    expect(issuableAddress(target({
      identifier: 'http://app.test/api/accounts',
      sampleUrl: 'http://app.test/api/accounts'
    }))).toBe('http://app.test/api/accounts');
  });

  it('keeps the identifier when there is no sample', () => {
    expect(issuableAddress(target({ identifier: '/api/accounts' }))).toBe('/api/accounts');
    expect(issuableAddress(target({ identifier: '/api/accounts', sampleUrl: null })))
      .toBe('/api/accounts');
  });

  it('is unchanged for a page target', () => {
    expect(issuableAddress(target({ kind: 'page', identifier: '/list.asp' }))).toBe('/list.asp');
  });
});
