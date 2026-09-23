/**
 * Physical evidence for a security finding.
 *
 * The brief's rule is absolute in both directions: never fabricate evidence, and never put a
 * real secret into it. Those pull against each other — the most useful evidence for an
 * authorization finding is the request that worked, and that request carries a session
 * cookie — so the resolution is to write two copies. The raw one records what actually
 * happened. The sanitized one is the one a report links to and a person reads.
 *
 * Nothing here invents anything. Every file is written from a real request and a real
 * response, and a finding with no evidence is a finding this module refuses to write.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

/** Header names whose values never appear in sanitized evidence, whatever they contain. */
const SENSITIVE_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key',
  'x-auth-token', 'x-csrf-token', 'x-xsrf-token', 'x-access-token', 'x-refresh-token',
  'x-session-id', 'authentication'
]);

/** Body fields whose values never appear in sanitized evidence. */
const SENSITIVE_FIELDS = [
  'password', 'passwd', 'pwd', 'newpassword', 'currentpassword', 'confirmpassword',
  'secret', 'clientsecret', 'apikey', 'api_key', 'accesstoken', 'access_token',
  'refreshtoken', 'refresh_token', 'idtoken', 'id_token', 'token', 'sessionid',
  'session_id', 'privatekey', 'private_key', 'credential', 'credentials',
  'passwordhash', 'password_hash', 'pin', 'cvv', 'cardnumber', 'card_number', 'ssn'
];

export const REDACTED = '***REDACTED***';

/** Patterns that look like a secret wherever they appear, including in free text. */
const PATTERNS = [
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, `Bearer ${REDACTED}`],
  [/Basic\s+[A-Za-z0-9+/]+=*/gi, `Basic ${REDACTED}`],
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED],       // JWT
  [/\bsk_[A-Za-z0-9_]{8,}/g, REDACTED],                                     // api key shapes
  [/\$2[aby]\$\d{2}\$[A-Za-z0-9./]{20,}/g, REDACTED],                       // bcrypt hash
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  [/\bsess-[A-Za-z0-9]{6,}/g, REDACTED],                                    // lab session tokens
  [/\bcsrf-[A-Za-z0-9]{6,}/g, REDACTED],
  [/\breset-[A-Za-z0-9]{6,}/g, REDACTED],
  [/\b\d{13,19}\b/g, REDACTED]                                              // card-length digits
];

/** Redacts free text. Literals the caller knows about go first, then shapes. */
export function redactText(value, literals = []) {
  let text = String(value ?? '');
  for (const literal of literals) {
    // Short strings are skipped: redacting every occurrence of a four-character value
    // would shred the evidence it is supposed to preserve.
    if (typeof literal === 'string' && literal.length >= 8) {
      text = text.split(literal).join(REDACTED);
    }
  }
  for (const [pattern, replacement] of PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

/** Redacts a header map by name, then redacts what is left by shape. */
export function redactHeaders(headers, literals = []) {
  const out = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    out[name] = SENSITIVE_HEADERS.has(name.toLowerCase())
      ? REDACTED
      : redactText(value, literals);
  }
  return out;
}

/** Redacts a parsed body by field name, recursively, then by shape. */
export function redactBody(body, literals = []) {
  if (body === null || body === undefined) return body;
  if (typeof body === 'string') return redactText(body, literals);
  if (Array.isArray(body)) return body.map(v => redactBody(v, literals));
  if (typeof body !== 'object') return body;

  const out = {};
  for (const [key, value] of Object.entries(body)) {
    const normalised = key.toLowerCase().replace(/[-_]/g, '');
    out[key] = SENSITIVE_FIELDS.includes(normalised)
      ? REDACTED
      : redactBody(value, literals);
  }
  return out;
}

const asText = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);

/**
 * Writes one finding's evidence directory.
 *
 * Refuses a finding with no exchange to show. The brief says every significant finding must
 * have physical evidence, and a directory containing only a metadata file is not evidence —
 * it is a claim with a folder around it.
 */
export function writeFindingEvidence({ root, findingId, finding, exchanges, literals = [], extras = {} }) {
  if (!Array.isArray(exchanges) || exchanges.length === 0) {
    throw new Error(
      `Refusing to write evidence for ${findingId}: no request/response exchange was supplied. `
      + 'A finding with nothing to show is a claim, not a finding.');
  }

  const dir = resolve(root, findingId);
  mkdirSync(dir, { recursive: true });

  const rawParts = [];
  const safeParts = [];

  exchanges.forEach((exchange, index) => {
    const n = exchanges.length > 1 ? ` (${index + 1} of ${exchanges.length})` : '';
    const requestLine = `${exchange.method} ${exchange.url}`;

    const rawRequest = [
      `# Request${n}`, requestLine,
      ...Object.entries(exchange.requestHeaders ?? {}).map(([k, v]) => `${k}: ${v}`),
      '', asText(exchange.requestBody ?? '')
    ].join('\n');

    const rawResponse = [
      `# Response${n}`, `HTTP ${exchange.status}`,
      ...Object.entries(exchange.responseHeaders ?? {}).map(([k, v]) => `${k}: ${v}`),
      '', asText(exchange.responseBody ?? '')
    ].join('\n');

    const safeRequest = [
      `# Request${n}`, requestLine,
      ...Object.entries(redactHeaders(exchange.requestHeaders, literals)).map(([k, v]) => `${k}: ${v}`),
      '', asText(redactBody(exchange.requestBody, literals))
    ].join('\n');

    const safeResponse = [
      `# Response${n}`, `HTTP ${exchange.status}`,
      ...Object.entries(redactHeaders(exchange.responseHeaders, literals)).map(([k, v]) => `${k}: ${v}`),
      '', asText(redactBody(exchange.responseBody, literals))
    ].join('\n');

    rawParts.push(rawRequest, rawResponse);
    safeParts.push(safeRequest, safeResponse);
  });

  writeFileSync(resolve(dir, 'request.txt'), rawParts.filter((_, i) => i % 2 === 0).join('\n\n'));
  writeFileSync(resolve(dir, 'response.txt'), rawParts.filter((_, i) => i % 2 === 1).join('\n\n'));
  writeFileSync(resolve(dir, 'sanitized-request.txt'), safeParts.filter((_, i) => i % 2 === 0).join('\n\n'));
  writeFileSync(resolve(dir, 'sanitized-response.txt'), safeParts.filter((_, i) => i % 2 === 1).join('\n\n'));

  for (const [name, content] of Object.entries(extras)) {
    if (content === undefined || content === null) continue;
    writeFileSync(resolve(dir, name),
      Buffer.isBuffer(content) ? content : redactText(asText(content), literals));
  }

  const reproduction = [
    `# Reproducing ${findingId}`, '',
    finding.title, '',
    '## What was done', '',
    ...exchanges.map((e, i) => `${i + 1}. \`${e.method} ${e.url}\`${e.as ? ` as ${e.as}` : ''}`),
    '', '## What came back', '',
    ...exchanges.map((e, i) => `${i + 1}. HTTP ${e.status}${e.note ? ` — ${e.note}` : ''}`),
    '', '## Why that is a finding', '', finding.description, '',
    '## Severity', '', finding.severityExplanation ?? '(not computed)', '',
    '> Evidence is written twice. `request.txt` and `response.txt` are what actually',
    '> happened; `sanitized-request.txt` and `sanitized-response.txt` are the same exchange',
    '> with credentials removed, and are what a report links to.'
  ].join('\n');
  writeFileSync(resolve(dir, 'reproduction.md'), reproduction);

  const metadata = {
    findingId,
    title: finding.title,
    category: finding.category,
    severity: finding.severity,
    severityScore: finding.severityScore ?? null,
    severityFactors: finding.severityFactors ?? null,
    confidence: finding.confidence,
    status: finding.status,
    cwe: finding.cwe ?? null,
    cweConfidence: finding.cweConfidence ?? null,
    owaspApiCategory: finding.owaspApiCategory ?? null,
    owaspWebCategory: finding.owaspWebCategory ?? null,
    owaspEdition: finding.owaspEdition ?? null,
    owaspEditionVerifiedAgainstSource: finding.owaspEditionVerified ?? false,
    application: finding.application,
    environment: finding.environment ?? null,
    endpoint: finding.endpoint ?? null,
    parameter: finding.parameter ?? null,
    observedAsRole: finding.observedAsRole ?? null,
    testId: finding.testId ?? null,
    exchanges: exchanges.length,
    recordedAt: new Date().toISOString(),
    files: ['request.txt', 'response.txt', 'sanitized-request.txt', 'sanitized-response.txt',
            'reproduction.md', 'metadata.json', ...Object.keys(extras)]
  };
  writeFileSync(resolve(dir, 'metadata.json'), JSON.stringify(metadata, null, 2));

  // A digest over the sanitized pair, so a report can show that the evidence it links to is
  // the evidence that was written.
  const digest = createHash('sha256')
    .update(safeParts.join('\n'))
    .digest('hex');
  writeFileSync(resolve(dir, 'sha256.txt'), `${digest}  sanitized-request.txt+sanitized-response.txt\n`);

  return { dir, digest, files: metadata.files };
}
