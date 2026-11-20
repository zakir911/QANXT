/**
 * What makes a request carry an identity.
 *
 * The engine used to say this with one word: `cookie`. Every check built its headers as
 * `{ cookie: identity.cookie }`, and `signIn` returned null when a response carried no
 * Set-Cookie. An application that answers a sign-in with a bearer token — every SPA, every
 * mobile backend, most APIs written in the last decade — therefore produced no identity at
 * all, and every authorization, API and injection check that needs one reported
 * inconclusive. Not a wrong answer: no answer, on half the applications in the world.
 *
 * So an identity carries the headers that authenticate it, whatever they are. A cookie is
 * one case of that, not the shape of the idea.
 */

/** The headers that make a request act as this identity. */
export function authHeaders(identity) {
  if (!identity) return {};
  if (identity.headers && typeof identity.headers === 'object') return { ...identity.headers };
  return identity.cookie ? { cookie: identity.cookie } : {};
}

/** True when the identity can actually authenticate a request. */
export function isSignedIn(identity) {
  return Object.keys(authHeaders(identity)).length > 0;
}

/**
 * Reads whatever credential a sign-in response handed back.
 *
 * A Set-Cookie is the obvious one. A JSON body carrying a token is just as common, and the
 * field it arrives in has no standard name, so the usual spellings are tried and the scheme
 * is taken from the response where it gives one.
 */
export function credentialFrom(response) {
  const setCookie = response?.headers?.getSetCookie?.()
    ?? (typeof response?.responseHeaders?.['set-cookie'] === 'string'
      ? [response.responseHeaders['set-cookie']] : []);
  const cookie = setCookie[0]?.split(';')[0] ?? null;
  if (cookie) return { cookie, headers: { cookie } };

  const body = response?.responseBody;
  if (body && typeof body === 'object') {
    for (const field of ['token', 'accessToken', 'access_token', 'idToken', 'id_token', 'jwt']) {
      const value = body[field];
      if (typeof value === 'string' && value.length > 0) {
        const scheme = typeof body.tokenType === 'string' && body.tokenType.trim() !== ''
          ? body.tokenType.trim()
          : (typeof body.token_type === 'string' && body.token_type.trim() !== ''
            ? body.token_type.trim() : 'Bearer');
        return { cookie: null, headers: { authorization: `${scheme} ${value}` } };
      }
    }
  }

  return null;
}
