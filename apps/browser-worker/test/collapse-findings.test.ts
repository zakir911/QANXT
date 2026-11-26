import { describe, expect, test } from 'vitest';
import { alsoSeenAt, collapseFindings, routeTemplate } from '../src/security/collapse-findings.js';
import type { SecurityFinding } from '@qa-nxt/security-engine';

/**
 * One fact, reported once.
 *
 * Measured on a 137-screen application: **173 findings, 17 distinct facts.** 135 said
 * `x-content-type-options is not set` and 16 said one cookie is missing HttpOnly. Three
 * privilege escalations and a real missing-token hole were in the remaining twenty-two rows,
 * behind 151 rows of the same two sentences.
 *
 * Every run this session published that number without questioning it.
 */
const finding = (over: Partial<SecurityFinding> & { subject?: string } = {}) => ({
  category: 'MissingSecurityHeader',
  title: 'x-content-type-options is not set',
  endpoint: '/dashboard',
  description: 'The response carries no header.',
  impact: 'x', remediation: 'y',
  ...over
}) as unknown as SecurityFinding;

describe('routeTemplate', () => {
  test('an identifier segment becomes a placeholder, so instances of one route group', () => {
    expect(routeTemplate('/api/shipments/shp-0001')).toBe('/api/shipments/{id}');
    expect(routeTemplate('/api/shipments/shp-0002')).toBe('/api/shipments/{id}');
    expect(routeTemplate('/orders/12345/lines')).toBe('/orders/{id}/lines');
    expect(routeTemplate('/users/3f2504e0-4f89-11d3-9a0c-0305e82c3301'))
      .toBe('/users/{id}');
  });

  test('a word is left alone, because two route names are two routes', () => {
    // Merging these would hide one of them, which is the opposite of the problem being fixed.
    expect(routeTemplate('/orders/sales/new')).toBe('/orders/sales/new');
    expect(routeTemplate('/orders/sales/approve')).toBe('/orders/sales/approve');
    expect(routeTemplate('/orders/sales/new')).not.toBe(routeTemplate('/orders/sales/approve'));
  });

  test('the same address spelled absolutely and relatively is one address', () => {
    expect(routeTemplate('http://127.0.0.1:4400/auth/sign-in')).toBe(routeTemplate('/auth/sign-in'));
  });

  test('a query string does not split one route into many', () => {
    expect(routeTemplate('/shipments/new?step=1')).toBe(routeTemplate('/shipments/new?step=2'));
  });
});

describe('collapseFindings', () => {
  test('a declared subject collapses across every address it was seen at', () => {
    const many = ['/a', '/b', '/c', '/d'].map(endpoint =>
      finding({ endpoint, subject: 'header:x-content-type-options' }));

    const collapsed = collapseFindings(many);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.occurrences).toBe(4);
    expect(collapsed[0]!.seenAt).toEqual(['/a', '/b', '/c', '/d']);
  });

  test('instances of one route collapse without needing a subject', () => {
    const many = ['shp-0001', 'shp-0002', 'shp-0003'].map(id =>
      finding({ category: 'MissingAuthorization', title: 'Protected data is served',
                endpoint: `/api/shipments/${id}` }));

    expect(collapseFindings(many)).toHaveLength(1);
  });

  test('the same fact on two spellings of one address collapses', () => {
    const both = [
      finding({ category: 'NoAccountLockout', title: '6 failed sign-ins', endpoint: '/auth/sign-in' }),
      finding({ category: 'NoAccountLockout', title: '6 failed sign-ins',
                endpoint: 'http://127.0.0.1:4400/auth/sign-in' })
    ];

    expect(collapseFindings(both)).toHaveLength(1);
  });

  test('two routes with the same problem stay two findings, because they are two fixes', () => {
    const two = [
      finding({ category: 'PrivilegeEscalation', title: 'A read-only account can write',
                endpoint: '/reports/builder' }),
      finding({ category: 'PrivilegeEscalation', title: 'A read-only account can write',
                endpoint: '/warehouse/transfers/new' })
    ];

    // Merging these would hide one endpoint that needs fixing. That is the failure mode in
    // the other direction and it is worse.
    expect(collapseFindings(two)).toHaveLength(2);
  });

  test('two different headers are two facts', () => {
    const two = [
      finding({ subject: 'header:x-content-type-options' }),
      finding({ title: 'content-security-policy is not set',
                subject: 'header:content-security-policy' })
    ];

    expect(collapseFindings(two)).toHaveLength(2);
  });

  test('two different parameters on one route stay separate', () => {
    const two = [
      finding({ category: 'ReflectedXSS', title: 'Reflected', endpoint: '/search', parameter: 'q' }),
      finding({ category: 'ReflectedXSS', title: 'Reflected', endpoint: '/search', parameter: 'sort' })
    ];

    expect(collapseFindings(two)).toHaveLength(2);
  });

  test('the same route seen as two roles stays separate', () => {
    const two = [
      finding({ category: 'MissingAuthorization', title: 'Served', endpoint: '/x',
                observedAsRole: 'viewer' }),
      finding({ category: 'MissingAuthorization', title: 'Served', endpoint: '/x',
                observedAsRole: 'anonymous' })
    ];

    expect(collapseFindings(two)).toHaveLength(2);
  });

  test('the first of each fact survives, so a severity ordering is not disturbed', () => {
    const collapsed = collapseFindings([
      finding({ endpoint: '/first', subject: 'header:x' }),
      finding({ endpoint: '/second', subject: 'header:x' })
    ]);

    expect(collapsed[0]!.endpoint).toBe('/first');
  });

  test('addresses are capped so a report of 135 pages stays readable', () => {
    const many = Array.from({ length: 135 }, (_, i) =>
      finding({ endpoint: `/page-${i}`, subject: 'header:x-content-type-options' }));

    const collapsed = collapseFindings(many);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.occurrences).toBe(135);
    expect(collapsed[0]!.seenAt.length).toBeLessThanOrEqual(8);
    expect(collapsed[0]!.moreAddresses).toBe(true);
  });

  test('a single finding is unchanged and says nothing extra', () => {
    const collapsed = collapseFindings([finding()]);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.occurrences).toBe(1);
    expect(alsoSeenAt(collapsed[0]!)).toBeNull();
  });

  test('nothing collapses to nothing', () => {
    expect(collapseFindings([])).toEqual([]);
  });
});

describe('alsoSeenAt', () => {
  test('says how many other addresses, so the count is not silently dropped', () => {
    const many = Array.from({ length: 135 }, (_, i) =>
      finding({ endpoint: `/page-${i}`, subject: 'header:x' }));

    const sentence = alsoSeenAt(collapseFindings(many)[0]!)!;

    // A collapsed report that quietly discarded 134 addresses would be a different kind of
    // dishonesty from the one this fixes.
    expect(sentence).toContain('134 other address(es)');
    expect(sentence).toContain('/page-1');
  });

  test('names them all when there are few', () => {
    const sentence = alsoSeenAt(collapseFindings([
      finding({ endpoint: '/a', subject: 'header:x' }),
      finding({ endpoint: '/b', subject: 'header:x' })
    ])[0]!)!;

    expect(sentence).toContain('/b');
    expect(sentence).toContain('1 other address(es)');
  });
});
