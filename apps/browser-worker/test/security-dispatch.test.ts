import { describe, expect, test } from 'vitest';
import type { BrowserContext } from 'playwright';
import type { SecurityTarget } from '@qa-nxt/shared-types';
import {
  RUNNABLE_CHECKS, RUNNERS, byRole, intruder, owner, privileged, readOnly, requestShapeOf,
  type ScanContext, type SignedInIdentity
} from '../src/security/security-handler.js';
import { Logger } from '../src/util/logger.js';

/**
 * Which account each check acts as, and what it says when it cannot run.
 *
 * This file sat at 16.5% line coverage: the checks it dispatches to were covered well and the
 * dispatch itself was not. That is the wrong half to leave untested, because the dispatch
 * decides two things nothing downstream can correct.
 *
 * The first is which identity a check acts as. Pick the same account twice and an
 * authorization comparison stops comparing — it reports "both reach this route", which is true
 * and establishes nothing, because the lesser identity held every privilege. An honest-looking
 * inconclusive is the worst possible disguise for a check that could never have failed.
 *
 * The second is the sentence a check gives when its premise does not hold. Those sentences are
 * the product's honesty: the difference between "we looked and it is fine" and "we could not
 * look, and here is why" lives entirely in them.
 */

const identity = (label: string, role?: string, over: Partial<SignedInIdentity> = {}) => ({
  label, role, username: label, password: 'pw',
  headers: { cookie: `session=${label}` }, cookie: `session=${label}`, csrf: `csrf-${label}`,
  ...over
}) as SignedInIdentity;

const context = (identities: SignedInIdentity[], browser: BrowserContext | null = null): ScanContext => ({
  baseUrl: 'http://app.test',
  identities: new Map(identities.map(i => [i.label, i])),
  logger: new Logger('error', {}, () => {}),
  browser
});

const target = (over: Partial<SecurityTarget> = {}) => ({
  kind: 'endpoint', identifier: '/api/orders', httpMethod: 'POST',
  requiresAuthentication: true, parameters: [], checks: [],
  ...over
}) as SecurityTarget;

/** A scanner that records what it was asked and answers blandly. */
const quietScanner = () => {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    async request(options: Record<string, unknown>) {
      sent.push(options);
      return { allowed: true, status: 200, responseBody: {}, responseText: '',
               headers: { get: () => null } };
    }
  };
};

describe('choosing which account a check acts as', () => {
  test('the owner is found by any of the names a caller might use', () => {
    for (const role of ['owner', 'user', 'member', 'standard']) {
      expect(owner(context([identity('a', 'readonly'), identity('b', role)])).label).toBe('b');
    }
  });

  test('with no role named, the first identity is the owner rather than nobody', () => {
    expect(owner(context([identity('first'), identity('second')])).label).toBe('first');
  });

  test('the second identity is never the same object as the first', () => {
    // Position alone could return the identity the owner already resolved to, which is how a
    // comparison silently stops comparing.
    const ctx = context([identity('alice', 'owner'), identity('bob')]);

    expect(intruder(ctx)!.label).toBe('bob');
    expect(intruder(ctx)).not.toBe(owner(ctx));
  });

  test('with only one identity there is no second one, and the check must see that', () => {
    expect(intruder(context([identity('alice', 'owner')]))).toBeUndefined();
  });

  test('an intruder named as such is preferred over whoever happens to be second', () => {
    const ctx = context([identity('alice', 'owner'), identity('bob'), identity('eve', 'attacker')]);

    expect(intruder(ctx)!.label).toBe('eve');
  });

  test('a privileged identity is found under every spelling the launcher documents', () => {
    // The launcher's own documentation says "privileged"; this once looked only for "admin",
    // so a scan configured exactly as documented had no privileged identity and every check
    // needing one reported inconclusive while the identity sat in the map.
    for (const role of ['privileged', 'admin', 'administrator']) {
      expect(privileged(context([identity('a', 'owner'), identity('b', role)]))!.label).toBe('b');
    }
  });

  test('a read-only identity is found under every spelling too', () => {
    for (const role of ['readonly', 'read-only', 'viewer']) {
      expect(readOnly(context([identity('a', 'owner'), identity('b', role)]))!.label).toBe('b');
    }
  });

  test('a role nobody configured yields nothing rather than the wrong account', () => {
    const ctx = context([identity('a', 'owner')]);

    expect(privileged(ctx)).toBeUndefined();
    expect(readOnly(ctx)).toBeUndefined();
    expect(byRole(ctx, 'auditor')).toBeUndefined();
  });

  test('an identity with no role at all is never matched by role', () => {
    expect(byRole(context([identity('a')]), 'owner')).toBeUndefined();
  });
});

describe('what a check says when it cannot run', () => {
  const run = (check: string, ctx: ScanContext, t: SecurityTarget = target()) =>
    RUNNERS[check]!(quietScanner() as never, t, ctx);

  test('every check in the runnable list has a runner, and every runner is listed', () => {
    // A name in one and not the other is a check that is either never dispatched or never
    // declared, and both failures are silent.
    expect([...RUNNABLE_CHECKS].sort()).toEqual(Object.keys(RUNNERS).sort());
    expect(RUNNABLE_CHECKS.length).toBeGreaterThan(20);
  });

  test('with no identity at all, the anti-forgery check says there was nobody to forge for', async () => {
    const result = await run('request.csrf', context([]));

    expect(result.inconclusive).toBe(true);
    expect(result.reason).toMatch(/nobody to forge a cross-site request on behalf of/);
    expect(result.findings).toEqual([]);
  });

  test('with a header-authenticated identity it says so, and names the scheme', async () => {
    // There is no cross-site request to forge against a bearer token, and saying "no finding"
    // would read as "this endpoint is protected".
    const bearer = identity('api', 'owner', {
      headers: { authorization: 'Bearer abc' }, cookie: null
    });

    const result = await run('request.csrf', context([bearer]));

    expect(result.inconclusive).toBe(true);
    expect(result.reason).toMatch(/bearer token/);
  });

  test('the origin check says the same thing in its own terms', async () => {
    const result = await run('request.origin', context([]));

    expect(result.inconclusive).toBe(true);
    expect(result.reason).toMatch(/two anonymous requests/);
  });

  test('the read-only check needs two different accounts and says which is missing', async () => {
    const onlyOne = await run('authz.readonly', context([identity('alice', 'owner')]));

    expect(onlyOne.inconclusive).toBe(true);
    expect(onlyOne.reason).toMatch(/read-only|second/i);
  });

  test('a check needing a witness page says so rather than probing blind', async () => {
    const result = await run('request.safe-verb-state-change',
      context([identity('alice', 'owner')]), target({ witnessUrl: null }));

    expect(result.inconclusive).toBe(true);
    expect(result.reason).toMatch(/reading a page before and after/);
    expect(result.reason).toMatch(/discovery recorded no page/);
  });

  test('a check needing a parameter says so when the endpoint has none', async () => {
    for (const check of ['api.input-validation', 'injection.sql', 'injection.template']) {
      const result = await run(check, context([identity('alice', 'owner')]),
                               target({ parameters: [] }));
      expect(result.inconclusive, check).toBe(true);
      expect(result.reason, check).toMatch(/parameter/i);
    }
  });

  test('a check needing a browser says the browser is missing, not that the page was clean', async () => {
    // A browser that failed to launch costs coverage. It must never look like a page that was
    // examined and found safe.
    const result = await run('xss.dom', context([identity('alice', 'owner')], null));

    expect(result.inconclusive).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.reason).toMatch(/browser/i);
  });

  test('every inconclusive reason is a sentence somebody could act on', async () => {
    // Not a code, not a word. The reason a check did not conclude is the most useful line in a
    // scan, and a reason that does not say what was missing is not one.
    const ctx = context([]);
    for (const check of Object.keys(RUNNERS)) {
      const result = await RUNNERS[check]!(quietScanner() as never, target(), ctx);
      if (result.inconclusive !== true) continue;
      expect(typeof result.reason, check).toBe('string');
      expect(result.reason!.length, `${check}: "${result.reason}"`).toBeGreaterThan(40);
      // Ends like a sentence rather than trailing off or stopping at a code.
      expect(result.reason, check).toMatch(/[.!?]$|[A-Za-z0-9)]$/);
    }
  });

  test('no check invents a finding when its premise does not hold', async () => {
    const ctx = context([]);
    for (const check of Object.keys(RUNNERS)) {
      const result = await RUNNERS[check]!(quietScanner() as never, target(), ctx);
      if (result.inconclusive === true || result.skipped === true) {
        expect(result.findings, check).toEqual([]);
      }
    }
  });
});

describe('the request shape a check sends', () => {
  test('a target carrying nothing yields an empty body and JSON, the safe default', () => {
    expect(requestShapeOf(target())).toEqual({
      body: {}, contentType: 'application/json', tokenField: null
    });
  });

  test('a declared form body, content type and token field are all carried through', () => {
    const shape = requestShapeOf(target({
      requestContentType: 'application/x-www-form-urlencoded',
      requestSample: '{"delta":"1","reason":"Damage"}',
      requestTokenField: '_csrf'
    }));

    expect(shape.contentType).toBe('application/x-www-form-urlencoded');
    expect(shape.body).toEqual({ delta: '1', reason: 'Damage' });
    expect(shape.tokenField).toBe('_csrf');
  });

  test('a malformed sample is treated as no sample rather than thrown', () => {
    // The surface is built elsewhere. A check that cannot read it should still run with what it
    // has and say so, not take the scan down.
    const shape = requestShapeOf(target({ requestSample: 'not json at all' }));

    expect(shape.body).toEqual({});
  });

  test('a sample that is not an object is ignored, including an array and a bare value', () => {
    for (const sample of ['[1,2,3]', '"a string"', '42', 'null']) {
      expect(requestShapeOf(target({ requestSample: sample })).body, sample).toEqual({});
    }
  });

  test('a blank content type or token field falls back rather than sending an empty one', () => {
    const shape = requestShapeOf(target({ requestContentType: '   ', requestTokenField: '  ' }));

    expect(shape.contentType).toBe('application/json');
    expect(shape.tokenField).toBeNull();
  });
});
