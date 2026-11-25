import { describe, expect, it } from 'vitest';
import { authenticationScheme } from '../src/security/security-handler.js';

/**
 * Naming the authentication scheme a cross-site request would not carry.
 *
 * `request.csrf` and `request.origin` guard on the identity having a cookie, and the guard
 * is substantively right: a browser attaches a cookie to a cross-site request by itself,
 * which is the whole mechanism forgery depends on, and it never attaches an Authorization
 * header, because only the application's own code sets that. An application authenticating
 * by header is therefore not exposed, and the check has nothing to establish.
 *
 * What was wrong was the sentence. Both reported "An authenticated session is needed to send
 * a cross-site request", which reads as the scan having failed to sign in. It had signed in:
 * on permits-legacy (HTTP Basic) and token-api (bearer) it was holding the identity's headers
 * at the time, and the authorization checks on the same targets ran as that identity and
 * reported a status code back from it. A reader seeing "an authenticated session is needed"
 * reasonably concludes the product could not authenticate against the target. It could.
 *
 * So the reason now names the scheme, read off the headers the scan is actually holding
 * rather than off the target's configuration, which keeps the sentence true to what happened.
 */
describe('authenticationScheme', () => {
  it('names HTTP Basic, which is what permits-legacy authenticates with', () => {
    expect(authenticationScheme({ headers: { authorization: 'Basic Y2xlcms6cHc=' } }))
      .toBe('HTTP Basic credentials');
  });

  it('names a bearer token, which is what token-api authenticates with', () => {
    expect(authenticationScheme({ headers: { Authorization: 'Bearer abc.def.ghi' } }))
      .toBe('a bearer token');
  });

  it('reads the header name whatever its case, because servers do not agree on it', () => {
    expect(authenticationScheme({ headers: { AUTHORIZATION: 'basic Zm9v' } }))
      .toBe('HTTP Basic credentials');
  });

  it('does not guess a scheme it does not recognise', () => {
    expect(authenticationScheme({ headers: { authorization: 'Negotiate YIIZ' } }))
      .toBe('an Authorization header');
  });

  it('names an api-key header, which some applications use instead', () => {
    expect(authenticationScheme({ headers: { 'X-Api-Key': 'k' } })).toBe('the X-Api-Key header');
  });

  it('falls back to a true statement when the headers are unfamiliar', () => {
    expect(authenticationScheme({ headers: { 'X-Tenant': 'acme' } }))
      .toBe('headers rather than a cookie');
  });

  it('says so when there is nothing to describe, rather than implying a scheme', () => {
    expect(authenticationScheme({ headers: {} })).toBe('no credentials this scan can see');
    expect(authenticationScheme({})).toBe('no credentials this scan can see');
  });

  it('calls a cookie a cookie, so no branch can produce a false sentence', () => {
    // A cookie-authenticated identity never reaches this function, because the guards that
    // call it only fire when there is no cookie. Answered correctly regardless: the fallback
    // sentence is "headers rather than a cookie", and a function one caller away from
    // printing that about a cookie is not worth the saved branch.
    expect(authenticationScheme({ headers: { cookie: 'session=1' } })).toBe('a session cookie');
    expect(authenticationScheme({ headers: { Cookie: 'session=1', 'X-Tenant': 'acme' } }))
      .toBe('a session cookie');
  });
});
