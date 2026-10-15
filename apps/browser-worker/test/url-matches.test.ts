import { describe, expect, test } from 'vitest';
import { urlMatches } from '../src/execution/form-oracles.js';

describe('urlMatches', () => {
  test('an inventory address in lower case matches the mixed-case address the page used', () => {
    // The case that reported a working sign-in as "sent nothing".
    expect(urlMatches('https://identitysense.in/IDSenseAPI/api/v1/admin/auth/login',
      'https://identitysense.in/idsenseapi/api/v1/admin/auth/login')).toBe(true);
  });

  test('an {id} in the inventory matches one path segment, and only one', () => {
    expect(urlMatches('https://shop.test/api/orders/8812/items', '/api/orders/{id}/items')).toBe(true);
    expect(urlMatches('https://shop.test/api/orders/8812/x/items', '/api/orders/{id}/items')).toBe(false);
  });

  test('a different address does not match', () => {
    expect(urlMatches('https://shop.test/api/orders', '/api/payments')).toBe(false);
  });
});
