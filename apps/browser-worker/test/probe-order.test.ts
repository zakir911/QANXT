import { describe, expect, it } from 'vitest';
import { probeOrder } from '../src/security/probe-order';

/**
 * On an address that changes state, the first probe is the only one that sees the application
 * as it was.
 *
 * Measured on permits-legacy: request.safe-verb-state-change ran tenth of eleven against
 * /approve.asp?id=1, and the five probes ahead of it had each approved the permit — legitimate
 * authorization and injection probes, every one of them asking whether the server refuses, and
 * every one of them a real approval. The check that existed to observe the change reported
 * honestly that it had seen none.
 */
const CHECKS = [
  'api.excessive-data',
  'authz.missing',
  'authz.token',
  'authz.vertical',
  'injection.command',
  'injection.sql',
  'injection.template',
  'passive.cors',
  'passive.sensitive-data',
  'request.safe-verb-state-change',
  'xss.reflected'
];

describe('probeOrder', () => {
  it('puts the observing check first when the address changes state', () => {
    expect(probeOrder(CHECKS, true)[0]).toBe('request.safe-verb-state-change');
  });

  it('keeps every other check, in the order it arrived', () => {
    const ordered = probeOrder(CHECKS, true);
    expect(ordered).toHaveLength(CHECKS.length);
    expect([...ordered].sort()).toEqual([...CHECKS].sort());
    expect(ordered.slice(1)).toEqual(CHECKS.filter(c => c !== 'request.safe-verb-state-change'));
  });

  it('changes nothing when the address does not change state', () => {
    // Reads can be probed in any order, so there is no reason to reorder them and every
    // reason not to: an order nobody asked for is an order nobody can predict.
    expect(probeOrder(CHECKS, false)).toEqual(CHECKS);
    expect(probeOrder(CHECKS, undefined)).toEqual(CHECKS);
  });

  it('changes nothing when the observing check is not among them', () => {
    const reads = CHECKS.filter(c => c !== 'request.safe-verb-state-change');
    expect(probeOrder(reads, true)).toEqual(reads);
  });

  it('handles an empty list', () => {
    expect(probeOrder([], true)).toEqual([]);
  });

  it('returns a copy, so the caller\'s list is not reordered underneath it', () => {
    const given = [...CHECKS];
    probeOrder(given, true);
    expect(given).toEqual(CHECKS);
  });
});
