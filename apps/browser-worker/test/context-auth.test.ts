import { describe, expect, it } from 'vitest';
import type { AuthConfig } from '@qa-nxt/shared-types';
import { contextAuthOptions } from '../src/browser/authenticator.js';

/**
 * The claim under test is narrow and was previously untested: a strategy that `performLogin`
 * reports as "already applied to the context" must actually produce context options.
 *
 * Discovery went live without them. Both callers now share this function, so these tests
 * stand in for both.
 */
describe('contextAuthOptions', () => {
  const base = { strategy: 'none' } as AuthConfig;

  it('asks for HTTP credentials for a basic-auth application', () => {
    const options = contextAuthOptions({
      ...base, strategy: 'basicAuth', username: 'clerk', password: 'Permit!2026'
    } as AuthConfig);
    expect(options.httpCredentials).toEqual({ username: 'clerk', password: 'Permit!2026' });
    expect(options.extraHeaders).toBeUndefined();
  });

  it('sends a bearer token as an Authorization header', () => {
    const options = contextAuthOptions({
      ...base, strategy: 'bearerToken', bearerToken: 'abc.def'
    } as AuthConfig);
    expect(options.extraHeaders).toEqual({ authorization: 'Bearer abc.def' });
  });

  it('parses a storage state into an object rather than passing the JSON text', () => {
    const options = contextAuthOptions({
      ...base, strategy: 'storageState', storageStateJson: '{"cookies":[]}'
    } as AuthConfig);
    expect(options.storageState).toEqual({ cookies: [] });
  });

  it('adds nothing for a form login, which is driven through the page', () => {
    expect(contextAuthOptions({ ...base, strategy: 'formLogin', loginUrl: 'http://x/in' } as AuthConfig))
      .toEqual({});
  });

  it('adds nothing when no authentication is configured', () => {
    expect(contextAuthOptions(base)).toEqual({});
  });

  /**
   * A half-configured application must not silently become an anonymous crawl that reports
   * a successful login: it gets no credentials, and the 401s that follow are the signal.
   */
  it('adds nothing when basic auth is configured without a password', () => {
    expect(contextAuthOptions({ ...base, strategy: 'basicAuth', username: 'clerk' } as AuthConfig))
      .toEqual({});
  });

  it('adds nothing when the bearer strategy is configured without a token', () => {
    expect(contextAuthOptions({ ...base, strategy: 'bearerToken' } as AuthConfig)).toEqual({});
  });
});
