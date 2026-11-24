/**
 * The security engine's request path.
 *
 * Every security request in QA NXT goes through `SecurityScanner.request`. There is no other
 * way to issue one, and that is the entire design: the scope guard is not a thing a check
 * remembers to call, it is a thing a check cannot avoid.
 *
 * The guard's logic lives in C# (`SecurityScopeGuard`) and is unit tested there. This is the
 * JavaScript side that the golden suites drive, and it implements the same ladder in the
 * same order so the two agree — with the ordering pinned by tests on both sides rather than
 * by hope.
 *
 * Rate limiting, concurrency and duration are enforced here rather than advised, because a
 * limit a caller can decline to observe is documentation.
 */
import { credentialFrom } from './credentials.mjs';
import { SECURITY_RISK, SECURITY_PROFILE, evaluateScope } from './scope-guard.mjs';
import { at } from './target-url.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class SecurityScanner {
  /**
   * @param {object} options
   * @param {object} options.scope     the security scope, already parsed
   * @param {string} options.profile   passive | standard | deep | regression
   * @param {object} options.context   production flags and caller permissions
   */
  constructor({ scope, profile = SECURITY_PROFILE.STANDARD, context = {}, clock = () => Date.now() }) {
    this.scope = scope;
    this.profile = profile;
    this.context = {
      isProductionEnvironment: false,
      productionTestingAuthorized: false,
      callerMayRunActiveScans: true,
      callerMayRunDestructiveScans: false,
      ...context
    };
    this.clock = clock;
    this.startedAt = clock();

    this.requestsIssued = 0;
    this.requestsBlocked = 0;
    this.blocked = [];
    this.exchanges = [];

    this._inFlight = 0;
    this._recentRequestTimes = [];
  }

  get elapsedMinutes() { return Math.floor((this.clock() - this.startedAt) / 60_000); }

  /** Requests issued in the last second, which is what the guard's rate check reads. */
  _requestsInLastSecond() {
    const cutoff = this.clock() - 1000;
    this._recentRequestTimes = this._recentRequestTimes.filter(t => t > cutoff);
    return this._recentRequestTimes.length;
  }

  /**
   * Decides whether one piece of work is in scope, and paces the scan to its own rate.
   *
   * The single place the guard is consulted. `request` calls it, and so does anything the
   * engine cannot perform itself — a page driven in a real browser, above all. Splitting the
   * decision from the doing is what keeps that possible without a second scope check living
   * somewhere else: two implementations of one control that drift are worse than one control,
   * because everybody believes the wrong half.
   *
   * Returns `{ allowed: false, decision }` rather than throwing, because a refusal is an
   * ordinary and expected outcome that a check needs to be able to report. A scan that
   * crashes when the scope says no cannot tell you what it did not do. A refusal is counted
   * and recorded here, so a caller that simply stops on `allowed: false` still leaves the
   * right trail.
   */
  async authorize({ url, method = 'GET', risk = SECURITY_RISK.PASSIVE, testId }) {
    // Pace to the configured rate BEFORE asking the guard.
    //
    // This used to happen after, which made it useless: the guard's rate rung saw the
    // burst, refused the request, and the pacing that would have prevented the burst never
    // ran. A fifteen-request check came back as fifteen refusals, which in a report is
    // indistinguishable from an endpoint that was never reached. The limit is meant to
    // shape the scan, not abort it — so the scan waits for its own budget first, and the
    // guard's rate rung stays as a backstop for anything that reaches it another way.
    //
    // The wait is bounded by construction: the window is one second wide and decays on its
    // own, so this cannot spin for longer than that regardless of what the caller does.
    const perSecond = this.scope?.maxRequestsPerSecond ?? 0;
    if (perSecond > 0) {
      while (this._requestsInLastSecond() >= perSecond) await sleep(25);
    }

    const decision = evaluateScope(this.scope, {
      url, method, risk, profile: this.profile,
      environmentId: this.context.environmentId,
      isApiRequest: /\/api\//.test(url)
    }, {
      ...this.context,
      requestsInLastSecond: this._requestsInLastSecond(),
      requestsInFlight: this._inFlight,
      scanElapsedMinutes: this.elapsedMinutes
    });

    if (!decision.allowed) {
      this.requestsBlocked++;
      this.blocked.push({
        url, method, risk, testId,
        reason: decision.reason, explanation: decision.explanation,
        occurredAt: new Date().toISOString()
      });
      return { allowed: false, decision };
    }

    return { allowed: true, decision };
  }

  /**
   * Records work the caller performed under a decision <c>authorize</c> already granted.
   *
   * For anything this engine cannot do itself — driving a page in a real browser, most of
   * all. The alternative would be a second scope check living wherever the browser lives,
   * and two implementations of one control that drift are worse than one control, because
   * everybody believes the wrong half.
   *
   * Counts towards the same totals as a request the engine issued, because from the
   * application's side it was one: a page was fetched and something was sent to it.
   */
  record(exchange) {
    this._recentRequestTimes.push(this.clock());
    this.requestsIssued++;
    this.exchanges.push(exchange);
    return exchange;
  }

  /**
   * Issues one security request over HTTP, or refuses it.
   *
   * Every request the engine itself makes goes through here, and here goes through
   * `authorize`, which is what makes the scope guard mandatory rather than advisory.
   */
  async request({ url, method = 'GET', risk = SECURITY_RISK.PASSIVE, headers = {}, body, testId, as, note }) {
    const { allowed, decision } = await this.authorize({ url, method, risk, testId });
    if (!allowed) return { allowed: false, decision };

    this._inFlight++;
    this._recentRequestTimes.push(this.clock());
    this.requestsIssued++;

    try {
      const started = Date.now();
      let response;
      try {
        response = await fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined
            : typeof body === 'string' ? body : JSON.stringify(body),
          redirect: 'manual'
        });
      } catch (error) {
        // A transport failure is an observation, not a crash.
        //
        // A scan that throws on the first unreachable endpoint tells you nothing about the
        // two hundred it had not reached yet, and "the scan died" is indistinguishable in a
        // report from "the scan found nothing". This records what happened and lets the
        // check decide: for most checks an unreachable endpoint is simply not evidence of
        // anything, and for a few — an endpoint that was reachable a moment ago — it is.
        const failure = {
          method, url, as, note, testId,
          requestHeaders: headers, requestBody: body ?? null,
          status: 0, transportError: String(error?.cause?.code ?? error?.message ?? error),
          responseHeaders: {}, responseBody: null, responseText: '',
          durationMs: Date.now() - started
        };
        this.exchanges.push(failure);
        return { allowed: true, decision, ...failure, headers: new Headers() };
      }
      const text = await response.text();
      let parsed = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* not json */ }

      const exchange = {
        method, url, as, note, testId,
        requestHeaders: headers,
        requestBody: body ?? null,
        status: response.status,
        responseHeaders: Object.fromEntries(response.headers.entries()),
        responseBody: parsed ?? text,
        responseText: text,
        durationMs: Date.now() - started
      };
      this.exchanges.push(exchange);
      return { allowed: true, decision, ...exchange, headers: response.headers };
    } finally {
      this._inFlight--;
    }
  }

  /** Signs in as one of the lab's synthetic identities and returns a cookie header. */
  /**
   * Signs in as one identity, the way the application's own sign-in form says to.
   *
   * This used to POST JSON to a hard-coded `/api/session`, which meant identities could
   * only be established against an application that happened to expose exactly that
   * endpoint. Meridian Freight is an ordinary form-login application: the endpoint 404s,
   * all three identities failed, and every authorization check reported "an owning
   * identity is needed" — 66 of the 204 things that scan could not establish, including
   * the two planted authorization defects. A scanner that can only sign in to one
   * convention cannot test authorization on most web applications.
   *
   * So the form is read and submitted as written: its own action, its own method, its own
   * field names, and its hidden fields carried through — an anti-forgery token above all,
   * because a sign-in that omits one is refused and the refusal looks like bad
   * credentials. The JSON endpoint is still tried, last, for applications that do offer
   * it.
   */
  /**
   * Finds the application's sign-in form once and remembers it.
   *
   * Every check that submits credentials needs the same thing, and each used to hand-roll
   * a JSON POST to a guessed endpoint. Against a form-login application those requests are
   * refused before the sign-in logic ever sees them — Meridian Freight answers 403 to all
   * of them, from its anti-forgery guard — so a lockout check counted six refusals as six
   * un-throttled sign-in attempts and reported no lockout. The conclusion happened to be
   * right and the evidence was of a conversation that never took place.
   */
  async findSignInForm(baseUrl, options = {}) {
    this._signInForms ??= new Map();
    const cached = this._signInForms.get(baseUrl);
    if (cached !== undefined) return cached;

    const paths = [
      ...(options.signInPath ? [options.signInPath] : []),
      '/auth/sign-in', '/auth/login', '/login', '/sign-in', '/signin',
      '/account/login', '/users/sign_in', '/session/new'
    ];

    for (const path of dedupe(paths)) {
      const page = await this.request({
        url: at(baseUrl, `${path}`), method: 'GET', risk: SECURITY_RISK.PASSIVE,
        as: 'unauthenticated', testId: 'sign-in-form'
      });
      if (!page.allowed || typeof page.responseText !== 'string') continue;

      const form = readSignInForm(page.responseText, 'probe', 'probe');
      if (form === null) continue;

      const found = { ...form, page: path };
      this._signInForms.set(baseUrl, found);
      return found;
    }

    this._signInForms.set(baseUrl, null);
    return null;
  }

  /**
   * Submits credentials the way the application's own form does, so the request reaches
   * the sign-in logic rather than an anti-forgery guard. Falls back to the JSON endpoint
   * for applications that offer one.
   */
  async submitSignIn(baseUrl, username, password, { as, testId, note } = {}) {
    const form = await this.findSignInForm(baseUrl);

    if (form !== null) {
      // The token is re-read each time: a one-shot token spent by the previous attempt
      // would make every later one a refusal rather than a failed sign-in.
      const fresh = await this.request({
        url: at(baseUrl, `${form.page}`), method: 'GET', risk: SECURITY_RISK.PASSIVE,
        as: as ?? 'unauthenticated', testId: testId ?? 'sign-in-form'
      });
      const current = typeof fresh.responseText === 'string'
        ? readSignInForm(fresh.responseText, username, password) ?? form
        : form;
      const fields = { ...current.fields };
      for (const [name, value] of Object.entries(form.fields)) {
        if (name in fields) continue;
        fields[name] = value;
      }
      // The identity and password fields were filled by readSignInForm above.
      return await this.request({
        url: new URL(current.action || form.page, at(baseUrl, `${form.page}`)).toString(),
        method: current.method,
        risk: SECURITY_RISK.ACTIVE,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
        as: as ?? username, testId: testId ?? 'sign-in', note
      });
    }

    // No form. Use what the owner declared, and only guess when they declared nothing.
    //
    // `/api/session` with `{username, password}` was the whole of this path, and it is a
    // guess twice over: the address and the field names. Measured on this project's own
    // token-api target, whose sign-in is `POST /api/auth/token`: six "failed sign-ins"
    // were six 404s, the control probe correctly spotted that no sign-in had taken place,
    // and the lockout check reported that it could conclude nothing — while the planted
    // defect, a sign-in that is never throttled, sat there untested.
    const declared = this.context.signIn;
    const usernameField = declared?.usernameField || 'username';
    const passwordField = declared?.passwordField || 'password';
    const credentials = { [usernameField]: username, [passwordField]: password };
    const asForm = declared?.contentType === 'form';

    return await this.request({
      url: declared?.endpoint ?? at(baseUrl, `/api/session`),
      method: declared?.method ?? 'POST',
      risk: SECURITY_RISK.ACTIVE,
      headers: {
        'content-type': asForm ? 'application/x-www-form-urlencoded' : 'application/json'
      },
      body: asForm ? new URLSearchParams(credentials).toString() : credentials,
      as: as ?? username, testId: testId ?? 'sign-in', note
    });
  }

  /**
   * Every distinct way the sign-in form will authenticate this identity, each as its own
   * exchange, for a check that has to judge what the *response* to signing in sets.
   *
   * ## Why a check cannot do this for itself
   *
   * The cookie check used to read the Set-Cookie headers of a passive GET of some page. A
   * page GET is close to the only request that does not issue a session cookie: the cookie
   * worth judging is minted by the authentication response, which that check never made. It
   * reported a clean result from having looked at the wrong exchange.
   *
   * And one exchange is not enough. A sign-in form offering "keep me signed in" has two
   * authentication paths, and they are often written by different people at different times —
   * which is how one of them ends up assembling its Set-Cookie header by hand and dropping
   * HttpOnly. Signing in once, the default way, cannot see it.
   *
   * Each optional control is exercised on its own rather than in combination: the
   * combinations are exponential and the finding is per branch, not per pairing.
   *
   * @param {string} baseUrl
   * @param {string} username
   * @param {string} password
   * @param {{maxOptions?: number, signInPath?: string}} [options]
   * @returns {Promise<{exchanges: Array<{label: string, control: string|null, result: object}>,
   *                    form: {action: string, method: string, options: Array<object>}|null}>}
   */
  async signInExchanges(baseUrl, username, password, options = {}) {
    const maxOptions = options.maxOptions ?? 3;
    const paths = [
      ...(options.signInPath ? [options.signInPath] : []),
      '/auth/sign-in', '/auth/login', '/login', '/sign-in', '/signin',
      '/account/login', '/users/sign_in', '/session/new'
    ];

    for (const path of dedupe(paths)) {
      const page = await this.request({
        url: at(baseUrl, `${path}`), method: 'GET', risk: SECURITY_RISK.PASSIVE,
        as: username, testId: 'sign-in'
      });
      if (!page.allowed || typeof page.responseBody !== 'string') continue;

      const form = readSignInForm(page.responseBody, username, password);
      if (form === null) continue;

      const action = new URL(form.action, at(baseUrl, `${path}`)).toString();
      const submit = async (extra, label, control) => {
        const result = await this.request({
          url: action, method: form.method,
          risk: SECURITY_RISK.STATE_CHANGING,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ ...form.fields, ...extra }).toString(),
          as: username, testId: 'sign-in', note: label
        });
        return { label, control, result };
      };

      const exchanges = [await submit({}, 'the form as it stands', null)];

      // A fresh sign-in per option. Capped, because the number of exchanges a check may
      // make should not be decided by how many boxes somebody put on a login page.
      for (const option of (form.options ?? []).slice(0, maxOptions)) {
        exchanges.push(await submit(
          { [option.name]: option.value },
          `with "${option.name}" enabled`, option.name));
      }

      return { exchanges, form: { action: form.action, method: form.method, options: form.options ?? [] } };
    }

    return { exchanges: [], form: null };
  }

  async signIn(baseUrl, username, password = 'lab-password', options = {}) {
    // HTTP Basic first, because it is the one case where the application states the
    // answer. A 401 carrying WWW-Authenticate: Basic is the server saying what it wants,
    // and the same request with the header either succeeds or does not — there is nothing
    // to infer and no form to parse.
    //
    // Without this the engine could not sign in to an application behind a Basic
    // challenge at all: it looked for a sign-in form, found none on any of eight paths,
    // posted JSON to seven endpoints that all answered 401, and returned null. A scan of
    // such an application then reported every authorization and authentication check
    // inconclusive for want of an identity, with the credentials sitting unused in its
    // own configuration.
    const basic = await this.signInWithBasic(baseUrl, username, password);
    if (basic) return basic;

    const paths = [
      ...(options.signInPath ? [options.signInPath] : []),
      '/auth/sign-in', '/auth/login', '/login', '/sign-in', '/signin',
      '/account/login', '/users/sign_in', '/session/new'
    ];

    for (const path of dedupe(paths)) {
      const page = await this.request({
        url: at(baseUrl, `${path}`), method: 'GET', risk: SECURITY_RISK.PASSIVE,
        as: username, testId: 'sign-in'
      });
      if (!page.allowed || typeof page.responseBody !== 'string') continue;

      const form = readSignInForm(page.responseBody, username, password);
      if (form === null) continue;

      const submitted = await this.request({
        url: new URL(form.action, at(baseUrl, `${path}`)).toString(),
        method: form.method,
        risk: SECURITY_RISK.STATE_CHANGING,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form.fields).toString(),
        as: username, testId: 'sign-in'
      });
      if (!submitted.allowed) continue;

      // Whatever credential came back: a Set-Cookie, or a token in the body. A sign-in
      // that answers 2xx or a redirect and hands one back worked; a form re-rendered with
      // an error hands back nothing, and that is a failure to report rather than an
      // identity to pretend we have.
      const credential = credentialFrom(submitted);
      if (credential && submitted.status < 400) {
        return { ...credential, body: submitted.responseBody, csrf: readCsrf(submitted.responseBody) };
      }
    }

    // Applications that answer a JSON sign-in rather than serving a form. The path is not
    // one convention either: a token endpoint is spelled a dozen ways and guessing only
    // /api/session is how the whole family of them went untested.
    for (const endpoint of ['/api/session', '/api/auth/token', '/api/auth/login',
                            '/api/login', '/api/token', '/auth/token', '/oauth/token']) {
      const result = await this.request({
        url: at(baseUrl, `${endpoint}`), method: 'POST', risk: SECURITY_RISK.STATE_CHANGING,
        headers: { 'content-type': 'application/json' },
        body: { username, password, email: username }, as: username, testId: 'sign-in'
      });
      if (!result.allowed || result.status >= 400) continue;

      const credential = credentialFrom(result);
      if (credential) {
        return { ...credential, body: result.responseBody,
                 csrf: result.responseBody?.csrfToken ?? null };
      }
    }
    return null;
  }

  /**
   * Signs in with HTTP Basic, when that is what the application asks for.
   *
   * The challenge is established first rather than assumed: a Basic header sent to an
   * application that does not use Basic is ignored, and a 200 would then be read as a
   * successful sign-in that authenticates nothing — an identity that is not an identity,
   * which is worse than none, because every authorization comparison downstream would be
   * comparing two anonymous requests and finding them identical.
   *
   * @returns {Promise<{cookie: null, headers: object, body: unknown, csrf: null}|null>}
   */
  async signInWithBasic(baseUrl, username, password) {
    const challenge = await this.request({
      url: at(baseUrl, '/'), method: 'GET', risk: SECURITY_RISK.PASSIVE,
      as: username, testId: 'sign-in:basic-challenge'
    });
    if (!challenge.allowed) return null;

    const asks = String(challenge.responseHeaders?.['www-authenticate'] ?? '');
    if (challenge.status !== 401 || !/^\s*basic\b/i.test(asks)) return null;

    const headers = {
      authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    };
    const signedIn = await this.request({
      url: at(baseUrl, '/'), method: 'GET', risk: SECURITY_RISK.PASSIVE,
      headers, as: username, testId: 'sign-in:basic'
    });
    if (!signedIn.allowed || signedIn.status === 401 || signedIn.status >= 500) return null;

    // Basic carries no CSRF token and no session: the header is the whole identity, and it
    // is re-sent on every request rather than exchanged for one.
    return { cookie: null, headers, body: signedIn.responseBody, csrf: null };
  }

  summary() {
    return {
      profile: this.profile,
      requestsIssued: this.requestsIssued,
      requestsBlocked: this.requestsBlocked,
      elapsedMinutes: this.elapsedMinutes,
      blocked: this.blocked
    };
  }
}

// ---------------------------------------------------------------------------
// Reading an application's own sign-in form
// ---------------------------------------------------------------------------

const dedupe = (values) => [...new Set(values)];

const firstCookie = (headers) =>
  (headers?.getSetCookie?.() ?? [])[0]?.split(';')[0] ?? null;

const readCsrf = (body) =>
  (body && typeof body === 'object' && body.csrfToken) ? body.csrfToken : null;

/**
 * Finds the sign-in form in a page and fills it.
 *
 * A page is only treated as a sign-in page when it has a password input: that is what
 * distinguishes one from the dozen other forms an application serves, and guessing from the
 * URL alone put credentials into search boxes.
 *
 * Hidden fields are carried through unchanged. That is not a nicety — an application that
 * verifies an anti-forgery token refuses a submission without one, and the refusal is
 * indistinguishable from a wrong password, so the scan would report "could not sign in"
 * for an application whose credentials were perfectly good.
 */
export function readSignInForm(html, username, password) {
  for (const match of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const attributes = match[1] ?? '';
    const inner = match[2] ?? '';

    const controls = [...inner.matchAll(/<input\b([^>]*)>/gi)]
      .map(input => attributesOf(input[1] ?? ''))
      .filter(control => control.name);

    const passwordField = controls.find(c => (c.type ?? '').toLowerCase() === 'password');
    if (passwordField === undefined) continue;

    // The identity field: whatever text-like input is not the password. Named candidates
    // first, because a form may carry others.
    const named = controls.find(c =>
      /^(username|user|email|login|identifier|userid|user_name)$/i.test(c.name));
    const textLike = controls.find(c =>
      c !== passwordField && !['hidden', 'checkbox', 'radio', 'submit', 'button'].includes((c.type ?? 'text').toLowerCase()));
    const identityField = named ?? textLike;
    if (identityField === undefined) continue;

    const fields = {};
    const options = [];
    for (const control of controls) {
      const type = (control.type ?? 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'image' || type === 'reset') continue;
      if (type === 'checkbox' || type === 'radio') {
        // A box the form ticks for you is part of how the form submits, so it belongs in the
        // default submission. Every checkbox used to be dropped here, which quietly signed in
        // differently from the form for any application that pre-ticks one.
        if ('checked' in control) {
          fields[control.name] = control.value || 'on';
          continue;
        }

        // An unticked box is left unticked, which is the right thing for signing in: a scan
        // should authenticate the way the form does, not the way it could be made to.
        //
        // It is reported rather than discarded, because an unticked box can be a second
        // authentication path. "Keep me signed in" is the common one, and the common bug is a
        // branch that assembles its own Set-Cookie and loses HttpOnly doing it. A check that
        // never ticks the box cannot see that cookie, and a check never told the box is there
        // cannot say what it did not look at.
        options.push({ name: control.name, value: control.value || 'on', type });
        continue;
      }
      fields[control.name] = control.value ?? '';
    }
    fields[identityField.name] = username;
    fields[passwordField.name] = password;

    const form = attributesOf(attributes);
    return {
      action: form.action || '',
      method: (form.method || 'post').toUpperCase() === 'GET' ? 'GET' : 'POST',
      fields,
      options
    };
  }
  return null;
}

/**
 * The attributes of one tag, as a plain object.
 *
 * Valueless attributes are included, with an empty string. HTML boolean attributes are
 * ordinarily written bare — `checked`, `required`, `disabled`, `readonly` — and a reader that
 * demands `name="value"` cannot see any of them. A pre-ticked checkbox then looked identical
 * to an unticked one.
 */
function attributesOf(source) {
  const found = {};
  for (const pair of source.matchAll(
    /([a-zA-Z-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+)))?/g)) {
    if (!pair[1]) continue;
    found[pair[1].toLowerCase()] = pair[3] ?? pair[4] ?? pair[5] ?? '';
  }
  return found;
}
