/**
 * Worker-side masking. Secrets are removed at capture time, before anything is written
 * to disk, uploaded as evidence or logged — masking only on the server would mean the
 * plaintext had already been through a temp file and a log line.
 *
 * This mirrors `QaNxt.Application.Security.SecretMasker`. The two implementations are
 * held in step by `test/masker.test.ts`, which asserts the same cases as the C# suite.
 */

export const REDACTED = '***REDACTED***';

const SENSITIVE_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key',
  'x-auth-token', 'x-csrf-token', 'x-xsrf-token', 'authentication', 'x-access-token',
  'x-refresh-token', 'x-session-id', 'x-amz-security-token'
]);

const SENSITIVE_FIELDS = new Set([
  'password', 'passwd', 'pwd', 'newpassword', 'currentpassword', 'confirmpassword',
  'secret', 'clientsecret', 'apikey', 'accesstoken', 'refreshtoken', 'idtoken', 'token',
  'sessionid', 'privatekey', 'authorization', 'credential', 'credentials',
  'pin', 'cvv', 'cvc', 'cardnumber', 'accountnumber', 'ssn', 'socialsecuritynumber',
  'nationalid', 'taxid', 'iban', 'sortcode'
]);

const BEARER = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const BASIC = /Basic\s+[A-Za-z0-9+/]+=*/gi;
const KEY_VALUE = /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)(["']?\s*[:=]\s*["']?)([^\s"',;&}]+)/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const API_KEY_LIKE = /\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,}\b/g;
const PAN = /\b(?:\d[ -]*?){13,19}\b/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi;

export function normaliseFieldName(name: string): string {
  return name.replace(/[-_]/g, '').toLowerCase();
}

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADERS.has(name.toLowerCase());
}

export function isSensitiveField(name: string): boolean {
  return SENSITIVE_FIELDS.has(normaliseFieldName(name));
}

export class SecretMasker {
  private readonly literals: string[] = [];

  /**
   * Registers a value known to be secret for this job — the password a step will type,
   * a bearer token from the auth config — so it is removed wherever it appears, including
   * places no pattern would recognise.
   */
  withLiteral(secret: string | undefined | null): this {
    if (secret && secret.trim().length >= 4) this.literals.push(secret);
    return this;
  }

  withLiterals(secrets: Iterable<string | undefined | null>): this {
    for (const secret of secrets) this.withLiteral(secret);
    return this;
  }

  maskText(input: string | undefined | null): string {
    if (!input) return '';
    let text = input;
    for (const literal of this.literals) text = text.split(literal).join(REDACTED);

    text = text.replace(BEARER, `Bearer ${REDACTED}`);
    text = text.replace(BASIC, `Basic ${REDACTED}`);
    text = text.replace(KEY_VALUE, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`);
    text = text.replace(JWT, REDACTED);
    text = text.replace(API_KEY_LIKE, REDACTED);
    text = text.replace(PAN, match => maskPan(match));
    text = text.replace(EMAIL, match => maskEmail(match));
    text = text.replace(URL_CREDENTIALS, (_m, scheme: string) => `${scheme}${REDACTED}@`);
    return text;
  }

  maskHeaders(headers: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      result[key] = isSensitiveHeader(key) ? REDACTED : this.maskText(value);
    }
    return result;
  }

  /** Masks by field name at any depth, then by value pattern. Unparseable input falls
   *  back to text masking so a truncated body cannot escape unmasked. */
  maskJson(json: string | undefined | null): string {
    if (!json || json.trim() === '') return json ?? '';
    try {
      return JSON.stringify(this.maskValue(JSON.parse(json)));
    } catch {
      return this.maskText(json);
    }
  }

  /**
   * Masks a parsed value, hiding what it holds without changing what shape it is.
   *
   * A redacted string stays a string, a redacted number stays a number, a null stays null,
   * and a sensitive object keeps its structure with every value inside it redacted. The
   * control plane's contract check compares masked bodies, so a masker that rewrote
   * `"sortCode": null` as a string made a field becoming nullable invisible and would have
   * invented type changes where there were none (BUG-0024).
   */
  private maskValue(value: unknown, forceRedact = false): unknown {
    if (Array.isArray(value)) return value.map(item => this.maskValue(item, forceRedact));

    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        // Once inside a sensitive subtree, everything below it is redacted too.
        out[key] = this.maskValue(item, forceRedact || isSensitiveField(key));
      }
      return out;
    }

    if (value === null) return null;
    if (typeof value === 'string') return forceRedact ? REDACTED : this.maskText(value);
    if (typeof value === 'number') return forceRedact ? 0 : value;
    if (typeof value === 'boolean') return forceRedact ? false : value;
    return value;
  }

  /** Masks a value a test step is about to type, for the execution record. */
  maskStepValue(value: string | undefined, isSensitiveInput: boolean): string | undefined {
    if (value === undefined) return undefined;
    if (isSensitiveInput) return REDACTED;
    return this.maskText(value);
  }
}

function maskPan(pan: string): string {
  const digits = pan.replace(/\D/g, '');
  if (digits.length < 8) return REDACTED;
  return '*'.repeat(digits.length - 4) + digits.slice(-4);
}

function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return REDACTED;
  const local = email.slice(0, at);
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}***${email.slice(at)}`;
}
