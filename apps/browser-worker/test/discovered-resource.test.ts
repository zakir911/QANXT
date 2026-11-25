import { describe, expect, it } from 'vitest';
import { identifierFromSample } from '../src/security/discovered-resource.js';

/**
 * Reading a concrete record identifier off an address discovery reached.
 *
 * This exists so authz.bola can run at all. It had never run: no driver in this project
 * declares a resourceId, so the check that finds an IDOR reported "give the identity a
 * resourceId it owns" on every target of every scan while a planted IDOR sat untested.
 *
 * The matching is per path segment rather than by regex over the whole string, because the
 * failure that matters is a wrong identifier rather than a missing one. A check pointed at
 * the wrong record produces a finding or a clean result that means nothing.
 */
describe('identifierFromSample', () => {
  it('reads the identifier a brace placeholder stood for', () => {
    expect(identifierFromSample('/api/shipments/{id}', 'http://host/api/shipments/shp-0008'))
      .toBe('shp-0008');
  });

  it('reads a colon placeholder too', () => {
    expect(identifierFromSample('/shipments/:id', 'http://host/shipments/shp-0017'))
      .toBe('shp-0017');
  });

  it('accepts a bare path as the sample', () => {
    expect(identifierFromSample('/orders/{id}', '/orders/so-0002')).toBe('so-0002');
  });

  it('ignores the query when reading the path', () => {
    expect(identifierFromSample('/orders/{id}', '/orders/so-0002?tab=lines')).toBe('so-0002');
  });

  it('refuses a sample of a different shape', () => {
    // Not an instance of this template, so anything read off it would be the wrong record.
    expect(identifierFromSample('/api/shipments/{id}', '/api/shipments/shp-1/events')).toBeNull();
    expect(identifierFromSample('/api/shipments/{id}', '/api/orders/shp-0008')).toBeNull();
  });

  it('refuses a template with two placeholders', () => {
    expect(identifierFromSample('/customers/{id}/orders/{orderId}', '/customers/c-1/orders/o-2'))
      .toBeNull();
  });

  it('refuses a template with no placeholder at all', () => {
    expect(identifierFromSample('/api/shipments', '/api/shipments')).toBeNull();
  });

  it('refuses a sample that is itself still a template', () => {
    expect(identifierFromSample('/api/shipments/{id}', '/api/shipments/{id}')).toBeNull();
  });

  it('refuses an empty segment where the identifier should be', () => {
    expect(identifierFromSample('/api/shipments/{id}', '/api/shipments/')).toBeNull();
  });

  it('is unbothered by a case difference in the literal segments', () => {
    expect(identifierFromSample('/API/Shipments/{id}', '/api/shipments/shp-3')).toBe('shp-3');
  });

  it('returns nothing when there is no sample', () => {
    expect(identifierFromSample('/api/shipments/{id}', null)).toBeNull();
    expect(identifierFromSample('/api/shipments/{id}', undefined)).toBeNull();
  });
});
