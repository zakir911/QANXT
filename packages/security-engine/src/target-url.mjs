/**
 * Where a check's probe actually goes.
 *
 * Every check in this engine built its URL as `${baseUrl}${path}`, with paths that are
 * absolute — `/api/session`, `/search.asp`, `/patients?q=x`. That is correct only while the
 * base URL has no path of its own. Registered against `http://host/schedule`, which is what
 * an application whose landing screen is not `/` looks like, the forty-one sites doing it
 * produced `http://host/schedule/api/session` and `http://host/schedule/schedule`.
 *
 * The consequence was not cosmetic. A scan of a client-rendered target reported twelve
 * missing-security-header findings; every one was measured against a URL that does not
 * exist, so what it described was the header policy of that application's 404 page. The
 * findings named those URLs, so a reader following one up would have gone to a page that
 * was never the subject.
 *
 * An absolute path resolves against the origin. That is what `new URL` does, and it is the
 * only rule here.
 *
 * @param {string} baseUrl    the application's registered base URL
 * @param {string} pathAndQuery  an absolute path, optionally with a query string
 * @returns {string} the absolute URL to request
 */
export function at(baseUrl, pathAndQuery) {
  try {
    return new URL(pathAndQuery, baseUrl).toString();
  } catch {
    // A caller that has already built something unparseable gets it back unchanged rather
    // than an exception: a malformed probe should fail as a refused request with a reason,
    // which the scanner reports, not as a crash that loses the whole scan.
    return `${baseUrl}${pathAndQuery}`;
  }
}

/** The path a finding should name, from whatever the check requested. */
export function pathOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch {
    return String(url).split('?')[0] ?? String(url);
  }
}
