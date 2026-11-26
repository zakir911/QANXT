import { describe, expect, it, vi } from 'vitest';
import type { SecurityScanJob } from '@qa-nxt/shared-types';
import type { SecurityScanner } from '@qa-nxt/security-engine';
import { asActor, signInIdentities, type SignedInIdentity } from '../src/security/security-handler.js';
import { Logger } from '../src/util/logger.js';

/**
 * Which sessions the worker keeps, and what it hands a check.
 *
 * The engine was taught that an identity is whatever authenticates a request — a cookie, a
 * bearer token, an HTTP Basic header. The worker was not: it discarded any session that came
 * back without a Set-Cookie, and passed only `{ cookie }` onward. So an application
 * authenticating any other way produced no identity at all, and a scan of a Basic-protected
 * permit register reported every authorization check "an owning identity is needed" with the
 * credentials sitting in its own configuration.
 */
const logger = new Logger('error', {}, () => {});

const job = (...identities: Array<{ label: string; username: string; password: string; role?: string }>) =>
  ({ baseUrl: 'http://127.0.0.1:4700/default.asp', identities } as unknown as SecurityScanJob);

const scannerReturning = (session: unknown) =>
  ({ signIn: vi.fn(async () => session) } as unknown as SecurityScanner);

describe('signInIdentities', () => {
  it('keeps an HTTP Basic session, which carries no cookie at all', async () => {
    const basic = { authorization: 'Basic Y2xlcms6UGVybWl0ITIwMjY=' };
    const identities = await signInIdentities(
      scannerReturning({ cookie: null, headers: basic, csrf: null }),
      job({ label: 'clerk', username: 'clerk', password: 'Permit!2026' }),
      logger);

    const kept = identities.get('clerk');
    expect(kept).toBeDefined();
    expect(kept!.headers).toEqual(basic);
    expect(kept!.cookie).toBeNull();
  });

  it('keeps a bearer-token session', async () => {
    const bearer = { authorization: 'Bearer abc.def.ghi' };
    const identities = await signInIdentities(
      scannerReturning({ cookie: null, headers: bearer, csrf: null }),
      job({ label: 'api user', username: 'u', password: 'p' }),
      logger);

    expect(identities.get('api user')!.headers).toEqual(bearer);
  });

  it('still keeps a cookie session, and carries it as a header too', async () => {
    const identities = await signInIdentities(
      scannerReturning({ cookie: 'clinic_session=abc', headers: { cookie: 'clinic_session=abc' }, csrf: 'tok' }),
      job({ label: 'reception', username: 'reception', password: 'p' }),
      logger);

    const kept = identities.get('reception')!;
    expect(kept.cookie).toBe('clinic_session=abc');
    expect(kept.headers).toEqual({ cookie: 'clinic_session=abc' });
    expect(kept.csrf).toBe('tok');
  });

  /**
   * A session that authenticates nothing must not become an identity. Two anonymous
   * requests compare identically, and every authorization check would read that as "no
   * defect" — a false clean, which is worse than the inconclusive it replaces.
   */
  it('discards a session that cannot authenticate anything', async () => {
    const identities = await signInIdentities(
      scannerReturning({ cookie: null, headers: {}, csrf: null }),
      job({ label: 'nobody', username: 'u', password: 'p' }),
      logger);

    expect(identities.size).toBe(0);
  });

  it('discards a sign-in that returned nothing', async () => {
    const identities = await signInIdentities(
      scannerReturning(null),
      job({ label: 'nobody', username: 'u', password: 'p' }),
      logger);

    expect(identities.size).toBe(0);
  });

  it('a sign-in that throws costs that identity and not the scan', async () => {
    const scanner = { signIn: vi.fn(async () => { throw new Error('connection reset'); }) } as unknown as SecurityScanner;

    const identities = await signInIdentities(
      scanner, job({ label: 'clerk', username: 'clerk', password: 'p' }), logger);

    expect(identities.size).toBe(0);
  });

  it('signs in each identity the job carries', async () => {
    const identities = await signInIdentities(
      scannerReturning({ cookie: null, headers: { authorization: 'Basic x' }, csrf: null }),
      job(
        { label: 'clerk', username: 'clerk', password: 'p', role: 'owner' },
        { label: 'inspector', username: 'inspector', password: 'p', role: 'privileged' },
        { label: 'viewer', username: 'viewer', password: 'p', role: 'readonly' }),
      logger);

    expect([...identities.keys()]).toEqual(['clerk', 'inspector', 'viewer']);
  });
});

describe('asActor', () => {
  it('hands a check the headers, so a non-cookie identity authenticates its requests', () => {
    const identity = {
      label: 'clerk', username: 'clerk', password: 'p',
      headers: { authorization: 'Basic x' }, cookie: null, csrf: null
    } as unknown as SignedInIdentity;

    expect(asActor(identity)).toEqual({
      headers: { authorization: 'Basic x' }, cookie: null, label: 'clerk', csrf: null
    });
  });

  it('carries the anti-forgery token, so a write check can send the request as this identity would', () => {
    // Without this the read-only write check sent its POSTs with no token in the body, an
    // application that reads the token from the body refused them, and the check read its own
    // omission as the application refusing the write. On freight that cost FP_D11: a viewer
    // settling a claim the page tells that viewer it may not settle.
    const identity = {
      label: 'viewer', username: 'viewer', password: 'p',
      headers: {}, cookie: 'session=v', csrf: 'v-token'
    } as unknown as SignedInIdentity;

    expect(asActor(identity).csrf).toBe('v-token');
  });
});
