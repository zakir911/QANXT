import { describe, expect, it } from 'vitest';
import { normalizeUrl, visitKey } from '../src/security/url-guard.js';

/**
 * Telling "which page is this" apart from "which route shape is this".
 *
 * `normalizeUrl` answers the second. The crawler used it for both, so every record of
 * every route after the first was skipped as already visited — and the cost was not the
 * page count. A page-level data check runs against the pages discovery recorded, so
 * "every total equals the sum of its lines" ran on permit 1, whose fees add up, passed,
 * and never opened permit 2, where the mismatch was planted.
 */
describe('visitKey', () => {
  it('tells two records of the same route apart', () => {
    const one = visitKey('http://127.0.0.1:4700/view.asp?id=1');
    const two = visitKey('http://127.0.0.1:4700/view.asp?id=2');
    expect(one).not.toBe(two);
    // The shape, which is what the route-shape cap is for, still collapses them.
    expect(normalizeUrl('http://127.0.0.1:4700/view.asp?id=1'))
      .toBe(normalizeUrl('http://127.0.0.1:4700/view.asp?id=2'));
  });

  it('tells two records keyed in the path apart', () => {
    expect(visitKey('http://host/orders/1')).not.toBe(visitKey('http://host/orders/2'));
    expect(normalizeUrl('http://host/orders/1')).toBe(normalizeUrl('http://host/orders/2'));
  });

  it('treats the same page written two ways as one page', () => {
    // Only what is incidental is normalised, so a crawl does not spend its budget twice on
    // one screen because a link spelled the host or the parameter order differently.
    expect(visitKey('http://HOST/Orders?b=2&a=1')).toBe(visitKey('http://host/Orders?a=1&b=2'));
    expect(visitKey('http://host/orders/')).toBe(visitKey('http://host/orders'));
    expect(visitKey('http://host:80/orders')).toBe(visitKey('http://host/orders'));
    expect(visitKey('https://host:443/orders')).toBe(visitKey('https://host/orders'));
  });

  it('keeps the path case, which some applications are sensitive to', () => {
    expect(visitKey('http://host/Orders')).not.toBe(visitKey('http://host/orders'));
  });

  it('keeps a value that only differs in case, because an id may', () => {
    expect(visitKey('http://host/view?id=AB')).not.toBe(visitKey('http://host/view?id=ab'));
  });

  it('ignores the fragment, which names a position rather than a page', () => {
    expect(visitKey('http://host/orders#row-4')).toBe(visitKey('http://host/orders'));
  });

  it('hands back something unparseable unchanged rather than throwing', () => {
    expect(visitKey('javascript:void(0)')).toBe('javascript:void(0)');
    expect(visitKey('')).toBe('');
  });

  it('keeps an empty parameter distinct from an absent one', () => {
    expect(visitKey('http://host/search?q=')).not.toBe(visitKey('http://host/search'));
  });
});
