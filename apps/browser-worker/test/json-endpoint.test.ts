import { describe, expect, it } from 'vitest';
import { apiSurfaceLooksUnwalked, identifiersIn, isJsonContentType, templateForInstance } from '../src/discovery/crawler.js';

/**
 * Reading a JSON API as an API.
 *
 * Endpoints were only recorded from XHR and fetch traffic, so an API opened directly was
 * filed as a page with no elements — and the attack surface, which is built from endpoints,
 * had none. Measured on a token-authenticated order API: three pages, zero endpoints, and
 * every authorization check inconclusive for want of a path with an identifier in it.
 */
describe('a JSON response', () => {
  it('is recognised by every spelling of the type in use', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
    expect(isJsonContentType('application/vnd.api+json')).toBe(true);
    expect(isJsonContentType('application/problem+json')).toBe(true);
    expect(isJsonContentType('text/json')).toBe(true);
  });

  it('is not confused with a page or a script', () => {
    expect(isJsonContentType('text/html; charset=utf-8')).toBe(false);
    expect(isJsonContentType('application/javascript')).toBe(false);
    expect(isJsonContentType(undefined)).toBe(false);
  });
});

describe('the identifiers a collection names', () => {
  it('reads them from a bare array, in order, without repeats', () => {
    const body = JSON.stringify([{ id: 'ord-1' }, { id: 'ord-2' }, { id: 'ord-1' }]);
    expect(identifiersIn(body)).toEqual(['ord-1', 'ord-2']);
  });

  it('reads them from the array inside a wrapper, which is the commoner shape', () => {
    const body = JSON.stringify({ page: 1, total: 2, orders: [{ orderId: 7 }, { orderId: 8 }] });
    expect(identifiersIn(body)).toEqual(['7', '8']);
  });

  /** An order carrying a customer's id does not mean the collection serves customers, so
   *  only a field directly on the record counts. */
  it('does not take an identifier out of a nested object', () => {
    const body = JSON.stringify([{ reference: 'INV-1', customer: { id: 'cus-9' } }]);
    expect(identifiersIn(body)).toEqual(['INV-1']);
  });

  it('takes one identifier per record, not every field that could be one', () => {
    const body = JSON.stringify([{ id: 'a', uuid: 'b', reference: 'c' }]);
    expect(identifiersIn(body)).toEqual(['a']);
  });

  it('is not fooled by a field whose name merely contains the letters', () => {
    const body = JSON.stringify([{ paid: true, idle: false, identity: 'x', name: 'Ada' }]);
    expect(identifiersIn(body)).toEqual([]);
  });

  it('ignores a value that could not go in a path', () => {
    const body = JSON.stringify([{ id: '' }, { id: 'x'.repeat(200) }, { id: { nested: 1 } }]);
    expect(identifiersIn(body)).toEqual([]);
  });

  it('says nothing about a body that is not a collection', () => {
    expect(identifiersIn(JSON.stringify({ id: 'ord-1', total: 10 }))).toEqual([]);
    expect(identifiersIn('not json at all')).toEqual([]);
    expect(identifiersIn('[]')).toEqual([]);
  });
});

/**
 * The endpoint template for a URL the crawler built itself.
 *
 * normalizeUrl turns a numeric path segment into {id} because a number there almost always
 * is one, and leaves "ord-1" alone because an opaque string there is as likely to be a route
 * name. When the crawler made the URL by taking an id out of a collection there is nothing to
 * infer, and the surface needs the parameter: every authorization check wants a path to
 * compare two identities against and reports inconclusive without one.
 */
describe('the template for an instance the crawler addressed', () => {
  it('parameterises the segment that holds the identifier, whatever it looks like', () => {
    expect(templateForInstance('http://api.test/api/orders/ord-1', 'ord-1'))
      .toBe('http://api.test/api/orders/{id}');
    expect(templateForInstance('http://api.test/v2/billing/invoices/INV-2026-5003', 'INV-2026-5003'))
      .toBe('http://api.test/v2/billing/invoices/{id}');
  });

  it('parameterises the last occurrence, not an earlier directory that matches', () => {
    expect(templateForInstance('http://api.test/orders/orders/orders', 'orders'))
      .toBe('http://api.test/orders/orders/{id}');
  });

  it('handles an identifier that had to be encoded to go in a path', () => {
    expect(templateForInstance('http://api.test/api/items/a%2Fb', 'a/b'))
      .toBe('http://api.test/api/items/{id}');
  });

  it('says nothing when the identifier is not in the path at all', () => {
    expect(templateForInstance('http://api.test/api/orders?id=ord-1', 'ord-1')).toBeNull();
    expect(templateForInstance('not a url', 'ord-1')).toBeNull();
  });
});

describe('whether a crawl\'s API surface is the application\'s own', () => {
  it('says so for a page-heavy crawl that found almost no API', () => {
    // Freight, measured: discovery completed at 164 pages with two endpoints, and one of the
    // missing ones was the only address an object-level authorization check can use. A reader
    // seeing "completed" beside the page count would conclude the surface was whole.
    expect(apiSurfaceLooksUnwalked(164, 2)).toBe(true);
    expect(apiSurfaceLooksUnwalked(137, 0)).toBe(true);
    expect(apiSurfaceLooksUnwalked(50, 2)).toBe(true);
  });

  it('stays quiet when the pages do fetch their API', () => {
    // A client-rendered application: its pages fetch, so the crawl sees the API as traffic.
    expect(apiSurfaceLooksUnwalked(40, 12)).toBe(false);
    expect(apiSurfaceLooksUnwalked(164, 30)).toBe(false);
  });

  it('stays quiet on a small application, where the ratio means nothing', () => {
    // Under twenty pages almost anything looks API-poor and the note would be noise.
    expect(apiSurfaceLooksUnwalked(19, 0)).toBe(false);
    expect(apiSurfaceLooksUnwalked(3, 0)).toBe(false);
  });
});
