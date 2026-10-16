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

describe('routeShapeOf', () => {
  test('pages under one prefix are different pages', async () => {
    const { routeShapeOf } = await import('../src/discovery/crawler.js');
    expect(routeShapeOf('https://bank.test/Retail/accounts')).not.toBe(routeShapeOf('https://bank.test/Retail/transfer'));
  });

  test('records of one page share a shape', async () => {
    const { routeShapeOf } = await import('../src/discovery/crawler.js');
    expect(routeShapeOf('https://shop.test/orders/8812')).toBe(routeShapeOf('https://shop.test/orders/9001'));
    expect(routeShapeOf('https://shop.test/orders/3f2a9c1e-1b2c-4d5e-8f90-123456789abc/items'))
      .toBe(routeShapeOf('https://shop.test/orders/0a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d/items'));
    expect(routeShapeOf('https://shop.test/orders/ORD-2024-0042')).toBe(routeShapeOf('https://shop.test/orders/ORD-2025-0107'));
  });
});
