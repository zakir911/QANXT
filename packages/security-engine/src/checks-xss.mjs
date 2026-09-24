/**
 * Cross-site scripting, with the context test that makes the difference between a finding
 * and a false positive.
 *
 * The brief names this case explicitly, and it is the one that decides whether anyone
 * trusts the tool: do not report XSS solely because input was reflected. Almost every
 * application reflects input. An application that reflects `<script>` as
 * `&lt;script&gt;` is doing the right thing, and an application that reflects it into a
 * JSON body is not in an HTML context at all.
 *
 * So a finding here requires three things together:
 *
 *   1. the response is HTML (by content type),
 *   2. the marker appears in it, and
 *   3. the marker's angle brackets and quotes survived unencoded.
 *
 * Miss any one and there is no finding. The two safe endpoints in the lab exist to prove
 * this, and they are the reason `checkReflectedXss` reports nothing against `/greet` and
 * `/echo` while reporting `/search`.
 *
 * The payloads are inert markers. They contain no network callback, no cookie read and no
 * redirect: nothing here would do anything if it executed, and nothing is asked to execute.
 */
import { SECURITY_RISK } from './scope-guard.mjs';
import { SeverityFactors, confidenceFrom } from './severity.mjs';

/** A marker that is unmistakably ours and does nothing. */
const MARKER = 'aira7x2';
const PAYLOADS = [
  { id: 'element', value: `<aira-${MARKER}>`, needs: ['<', '>'] },
  { id: 'attribute', value: `" aira-${MARKER}="1`, needs: ['"'] },
  { id: 'script-tag', value: `<script>/*${MARKER}*/</script>`, needs: ['<', '>'] }
];

const isHtml = result => /text\/html/i.test(result.responseHeaders?.['content-type'] ?? '');

/**
 * Was the payload reflected into an HTML context with its dangerous characters intact?
 *
 * Returns one of: 'unencoded' (a finding), 'encoded' (correct behaviour), 'absent' (not
 * reflected at all) or 'not-html' (reflected, but not into a context where it matters).
 */
export function reflectionVerdict(result, payload) {
  const text = result.responseText ?? '';
  if (!text.includes(MARKER)) return 'absent';
  if (!isHtml(result)) return 'not-html';
  return text.includes(payload.value) && payload.needs.every(ch => text.includes(ch))
    ? 'unencoded'
    : 'encoded';
}

function xssFinding({ category, title, endpoint, parameter, payload, verdictDetail, exchanges, cwe = 'CWE-79', stored = false }) {
  return {
    category, title, endpoint, httpMethod: 'GET', parameter, observedAsRole: 'unauthenticated',
    description: verdictDetail,
    impact: stored
      ? 'Markup stored by one user is rendered in every other user\'s browser, so a single write '
        + 'reaches everyone who later views the page.'
      : 'Markup supplied in a link is rendered in the browser of whoever follows it.',
    remediation: 'Encode on output for the context the value lands in, and prefer a template engine that '
      + 'encodes by default.',
    cwe, cweConfidence: 'confirmed',
    owaspApiCategory: 'API8:2023', owaspWebCategory: 'A03:2021',
    severityFactors: stored
      ? new SeverityFactors('trivial', 'serious', 'authenticatedUser', 'personalData', 'public')
      : new SeverityFactors('straightforward', 'serious', 'none', 'personalData', 'public'),
    confidence: confidenceFrom({ reproduced: true, corroborated: true, unambiguous: true }),
    exchanges,
    payloadUsed: payload.value,
    // The marker is inert by construction, and saying so is part of the finding: a reader
    // deciding whether to reproduce it needs to know what it does, which is nothing.
    payloadNote: 'An inert marker. It makes no network request, reads no cookie and performs no '
      + 'navigation. Nothing was executed during the test; the finding rests on the encoding of the '
      + 'response, not on observed script execution.'
  };
}

/** Reflected XSS: the payload comes back in the same response. */
export async function checkReflectedXss(scanner, { baseUrl, path, parameter, testId = 'SECA-XSS-R' }) {
  const exchanges = [];
  const verdicts = [];

  for (const payload of PAYLOADS) {
    const url = `${baseUrl}${path}?${parameter}=${encodeURIComponent(payload.value)}`;
    const result = await scanner.request({
      url, risk: SECURITY_RISK.ACTIVE, testId: `${testId}:${payload.id}`,
      as: 'unauthenticated', note: `inert reflection marker (${payload.id})`
    });
    if (!result.allowed) return { skipped: true, decision: result.decision, findings: [] };
    exchanges.push(result);
    verdicts.push({ payload, verdict: reflectionVerdict(result, payload), status: result.status });
  }

  const unencoded = verdicts.filter(v => v.verdict === 'unencoded');
  if (unencoded.length === 0) {
    const summary = verdicts.map(v => `${v.payload.id}:${v.verdict}`).join(', ');
    return { skipped: false, findings: [], ok: true, detail: summary };
  }

  const first = unencoded[0];
  return {
    skipped: false,
    findings: [xssFinding({
      category: 'ReflectedXSS',
      title: `'${parameter}' is reflected into HTML without encoding`,
      endpoint: path, parameter, payload: first.payload,
      verdictDetail: `${unencoded.length} of ${PAYLOADS.length} inert markers came back into an HTML `
        + `response with their special characters intact (${unencoded.map(v => v.payload.id).join(', ')}). `
        + 'Reflection alone was not treated as a finding: the response content type was checked, and the '
        + 'markers whose characters were encoded were recorded as correct behaviour, not as findings.',
      exchanges: exchanges.filter((_, i) => verdicts[i].verdict === 'unencoded')
    })]
  };
}

/**
 * Stored XSS: written once, rendered on a later read.
 *
 * The write is a state change against the application, so it is declared as one and the
 * scope guard governs it. The value written is a marker and nothing else.
 */
export async function checkStoredXss(scanner, { baseUrl, writePath, readPath, field, actor, testId = 'SECA-XSS-S' }) {
  const payload = PAYLOADS[0];

  const write = await scanner.request({
    url: `${baseUrl}${writePath}`, method: 'POST', risk: SECURITY_RISK.STATE_CHANGING,
    headers: { 'content-type': 'application/json', ...(actor?.cookie ? { cookie: actor.cookie } : {}) },
    body: { [field]: `${payload.value} stored by an AIRA security test` },
    as: actor?.label ?? 'unauthenticated', testId: `${testId}:write`,
    note: 'storing an inert marker'
  });
  if (!write.allowed) return { skipped: true, decision: write.decision, findings: [] };
  if (write.status >= 400) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: `The value could not be stored (${write.status}), so what happens on read is unknown.` };
  }

  const read = await scanner.request({
    url: `${baseUrl}${readPath}`, risk: SECURITY_RISK.ACTIVE, testId: `${testId}:read`,
    headers: actor?.cookie ? { cookie: actor.cookie } : {}, as: 'unauthenticated',
    note: 'reading the page that renders the stored value'
  });
  if (!read.allowed) return { skipped: true, decision: read.decision, findings: [] };

  const verdict = reflectionVerdict(read, payload);
  if (verdict !== 'unencoded') {
    return { skipped: false, findings: [], ok: true, detail: `stored value rendered ${verdict}` };
  }

  return {
    skipped: false,
    findings: [xssFinding({
      category: 'StoredXSS', stored: true,
      title: `'${field}' is stored and rendered without encoding`,
      endpoint: readPath, parameter: field, payload,
      verdictDetail: 'An inert marker written through the application\'s own write endpoint came back '
        + 'in a later HTML response with its angle brackets intact. The write and the read are separate '
        + 'requests, and both are in the evidence.',
      exchanges: [write, read]
    })]
  };
}

/**
 * DOM XSS, which a response-only scan cannot see.
 *
 * The sink is `innerHTML` in the browser and the source is `location.hash`, which is never
 * sent to the server. Nothing in any response body differs between the vulnerable and the
 * corrected application, so there is nothing for this scanner to observe.
 *
 * This returns `notTestable` rather than a pass. Reporting "no DOM XSS found" from a
 * response-only scan would be a claim the evidence cannot support, and the brief requires
 * tested coverage to be distinguishable from untested areas. A browser-driven scan can
 * reach it; this one cannot, and says so.
 */
export async function checkDomXss(scanner, { baseUrl, path, testId = 'SECA-XSS-D' }) {
  const result = await scanner.request({
    url: `${baseUrl}${path}`, risk: SECURITY_RISK.PASSIVE, testId,
    as: 'unauthenticated', note: 'fetching the page to record which client-side sinks it contains'
  });
  if (!result.allowed) return { skipped: true, decision: result.decision, findings: [] };

  const sinks = ['innerHTML', 'outerHTML', 'document.write', 'eval(', 'insertAdjacentHTML']
    .filter(sink => (result.responseText ?? '').includes(sink));
  const sources = ['location.hash', 'location.search', 'document.referrer', 'window.name']
    .filter(source => (result.responseText ?? '').includes(source));

  return {
    skipped: false,
    findings: [],
    notTestable: true,
    reason: 'DOM-based XSS cannot be decided from a response body. The source (location.hash) never '
      + 'reaches the server and the sink runs in the browser, so the vulnerable and the corrected '
      + 'application return identical responses. This is recorded as not tested by this scan rather '
      + 'than as no finding.',
    observed: { sinks, sources, status: result.status },
    detail: sinks.length > 0 && sources.length > 0
      ? `The page contains client-side sink(s) ${sinks.join(', ')} and source(s) ${sources.join(', ')}, `
        + 'which is grounds for a browser-driven scan of this page, not a finding.'
      : 'No client-side sink and source pair was visible in the response.'
  };
}
