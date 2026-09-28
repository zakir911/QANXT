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
import { SECURITY_RISK, SECURITY_PROFILE, evaluateScope } from './scope-guard.mjs';

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
  async signIn(baseUrl, username, password = 'lab-password') {
    const result = await this.request({
      url: `${baseUrl}/api/session`, method: 'POST', risk: SECURITY_RISK.STATE_CHANGING,
      headers: { 'content-type': 'application/json' },
      body: { username, password }, as: username, testId: 'sign-in'
    });
    if (!result.allowed || result.status !== 200) return null;
    const setCookie = result.headers?.getSetCookie?.() ?? [];
    const cookie = setCookie[0]?.split(';')[0] ?? null;
    return { cookie, body: result.responseBody, csrf: result.responseBody?.csrfToken ?? null };
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
