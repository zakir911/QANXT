import type { BrowserContext } from 'playwright';
import { SECURITY_RISK, SeverityFactors, confidenceFrom } from '@aira/security-engine';
import type { CheckResult, SecurityScanner as Scanner } from '@aira/security-engine';
import type { Logger } from '../util/logger.js';

/**
 * DOM-based cross-site scripting, decided in a browser.
 *
 * This is the one check a response-only scan cannot make. The source is `location.hash`,
 * which never leaves the browser, and the sink runs after the page has loaded — so the
 * vulnerable and the corrected application can return byte-identical responses. Every other
 * check in the engine reads a response; this one has to watch what the page does with one.
 *
 * Three decisions shape it.
 *
 * **It proves execution rather than inferring it.** A page containing `innerHTML` and
 * `location.hash` is grounds to look, not a finding — `checkDomXss` in the engine says exactly
 * that and stops there. Here the payload is a marker that can only set a flag by *running*, so
 * the finding rests on the flag being set. That is reproduction, and it is the only basis on
 * which the word confirmed is used anywhere in this system.
 *
 * **The payload is inert.** It sets one property on `window` and does nothing else: no network
 * call, no cookie read, no storage write, no navigation. The whole point of a marker is that
 * running it costs the application nothing, and a payload that did anything real would make
 * this check the thing it is looking for.
 *
 * **It goes through the same guard as everything else.** The scope decision comes from
 * `scanner.authorize`, and the navigation is recorded with `scanner.record`, so a browser
 * driven at an application counts against the same rate limit, the same allowlist and the same
 * refusal ledger as an HTTP request. A second scope check living next to the browser is how
 * the two drift, and a drift in this direction means a browser pointed somewhere nobody
 * authorized.
 */

/** A marker that is unmistakably ours, and inert by construction. */
const MARKER = 'aira7x2';

/**
 * Payloads, weakest first.
 *
 * Each needs a different sink to fire, so the set distinguishes a page that assigns to
 * `innerHTML` from one that calls `document.write` or evaluates a URL. They stop at the first
 * one that runs: the finding is that the sink is reachable, and firing four payloads at a page
 * to say so four times is noise.
 */
const PAYLOADS = [
  {
    id: 'img-onerror',
    // The classic innerHTML sink: a <script> tag inserted this way does not execute, an
    // event handler on a broken image does.
    value: `<img src=x onerror="window.__${MARKER}='%%NONCE%%'">`,
    needs: 'an HTML sink such as innerHTML or insertAdjacentHTML'
  },
  {
    id: 'svg-onload',
    value: `<svg onload="window.__${MARKER}='%%NONCE%%'">`,
    needs: 'an HTML sink that parses SVG'
  },
  {
    id: 'script-tag',
    // Does nothing through innerHTML by design; reaches a document.write or eval sink.
    value: `<script>window.__${MARKER}='%%NONCE%%'</script>`,
    needs: 'a sink that evaluates script, such as document.write or eval'
  }
] as const;

export interface DomXssOptions {
  scanner: Scanner;
  context: BrowserContext;
  baseUrl: string;
  path: string;
  testId?: string;
  logger: Logger;
}

/**
 * Drives one page's DOM sinks and reports whether attacker-controlled input executed there.
 *
 * Returns the engine's own result shape, so the handler treats it like any other check: a
 * refusal is `skipped`, an inability to decide is `inconclusive`, and only an executed marker
 * is a finding.
 */
export async function checkDomXssInBrowser(options: DomXssOptions): Promise<CheckResult> {
  const { scanner, context, baseUrl, path, logger } = options;
  const testId = options.testId ?? 'xss.dom';

  const observations: Record<string, unknown>[] = [];

  for (const payload of PAYLOADS) {
    // A fresh nonce per attempt. A stale flag left by an earlier payload, or by anything else
    // on the page, must not be readable as this payload having run.
    const nonce = `${MARKER}-${Math.random().toString(36).slice(2, 10)}`;
    const value = payload.value.replace('%%NONCE%%', nonce);
    const url = `${baseUrl}${path}#${encodeURIComponent(value)}`;

    // Active: it sends input the application did not ask for, and changes no state.
    const decision = await scanner.authorize({ url, method: 'GET', risk: SECURITY_RISK.ACTIVE, testId });
    if (!decision.allowed) {
      return { skipped: true, decision: decision.decision, findings: [], observations };
    }

    const page = await context.newPage();
    const started = Date.now();
    try {
      // Read before the page's own scripts run, so the flag cannot be mistaken for anything
      // the application set itself.
      await page.addInitScript(`delete window.__${MARKER};`);

      const response = await page.goto(url, { waitUntil: 'load' });
      // The sink may run on hashchange rather than on load, so nudge it and give the page a
      // moment. Short: this is a marker firing synchronously, not an application booting.
      await page.evaluate('window.dispatchEvent(new HashChangeEvent("hashchange"))').catch(() => {});
      await page.waitForTimeout(250);

      const fired = await page.evaluate(`window.__${MARKER} ?? null`) as string | null;
      const html = await page.content();

      // Recorded whether or not it fired: the navigation happened, and a scan's request count
      // has to include the work it actually did.
      const exchange = scanner.record({
        method: 'GET', url, testId,
        as: 'unauthenticated',
        note: `DOM XSS marker (${payload.id}); inert — it sets one window property and does nothing else`,
        requestHeaders: {}, requestBody: null,
        status: response?.status() ?? 0,
        responseHeaders: response ? await response.allHeaders() : {},
        responseBody: null,
        // The rendered DOM, not the response body. That difference is the whole check: the
        // response body is identical either way, and this is where the two part company.
        responseText: html,
        durationMs: Date.now() - started
      });

      observations.push({ payload: payload.id, executed: fired === nonce, status: response?.status() ?? 0 });

      if (fired !== nonce) continue;

      logger.warn('A DOM XSS marker executed', { path, payload: payload.id });

      return {
        skipped: false,
        observations,
        detail: `The ${payload.id} marker executed at ${path}.`,
        findings: [{
          category: 'DomXSS',
          title: `Input from location.hash reaches a script sink at ${path}`,
          testId,
          endpoint: path,
          httpMethod: 'GET',
          parameter: 'location.hash',
          description:
            `A marker placed in the fragment of ${path} executed in the page. The fragment is `
            + 'never sent to the server, so this is decided in the browser and nowhere else: the '
            + 'response body is the same whether or not the sink is safe. The marker used '
            + `${payload.needs}.`,
          impact:
            'Anyone who can get a victim to open a crafted link runs script in the application\'s '
            + 'origin as that victim — reading what the page can read and acting as they can act. '
            + 'No server-side logging records the fragment, so this leaves no trace on the server.',
          remediation:
            'Assign untrusted values with textContent rather than innerHTML, or sanitise with a '
            + 'library that parses rather than pattern-matches. A Content-Security-Policy without '
            + "'unsafe-inline' limits the damage but does not close the sink.",
          reproductionSteps:
            `1. Open ${url}\n`
            + '2. The fragment is written into a script sink by the page\'s own JavaScript.\n'
            + `3. The marker runs and sets window.__${MARKER}, which is how this was observed. `
            + 'The marker is inert: it makes no network request, reads no cookie and changes no '
            + 'state.',
          cwe: 'CWE-79',
          cweConfidence: 'confirmed',
          owaspWebCategory: 'A03:2021',
          // The same five factors as reflected XSS on a public page, because on every axis it
          // is the same vulnerability: a crafted link (straightforward), script running in the
          // origin as the victim (serious), no account needed (none), reaching whatever the
          // page reaches (personalData), on a publicly addressable page (public).
          //
          // Not marked as needing unusual conditions. Both classes need a victim to open a
          // link, so setting it here and not there would rate an identical exploit lower for a
          // condition the two share — and if anything the fragment never reaching the server
          // makes this one harder to see, not easier to survive.
          severityFactors: new SeverityFactors(
            'straightforward', 'serious', 'none', 'personalData', 'public'),
          // Reproduced — the marker ran — and unambiguous: a flag set by an executed payload
          // admits no second reading. That is what High is reserved for.
          confidence: confidenceFrom({ reproduced: true, corroborated: false, unambiguous: true }),
          // The finding carries its own evidence. Both the gate and the control plane refuse a
          // finding with no exchange behind it, and they are right to: a finding with nothing
          // to show is a claim.
          exchanges: [exchange],
          // The nonce is ours and identifies this attempt; it has no business in stored
          // evidence, where it would read like something belonging to the application.
          redactLiterals: [nonce]
        }]
      };
    } finally {
      await page.close().catch(() => {});
    }
  }

  // Every payload was delivered and none executed. That is a real negative for the sinks these
  // payloads reach, and it is reported as such rather than as coverage of DOM XSS in general:
  // a sink this set does not reach is still untested.
  return {
    skipped: false,
    findings: [],
    observations,
    detail: `${PAYLOADS.length} marker(s) were written into the fragment of ${path} and none `
      + 'executed. The sinks these markers reach are not reachable from location.hash here; a '
      + 'sink they do not reach is untested rather than absent.'
  };
}
