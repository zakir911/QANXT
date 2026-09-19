import { describe, expect, test } from 'vitest';
import { SecretMasker, REDACTED, isSensitiveField, isSensitiveHeader } from '../src/security/masker.js';
import { isUrlAllowed, matchesAllowlist, normalizeUrl } from '../src/security/url-guard.js';

/**
 * These mirror the control plane's own security tests. Two implementations of the same
 * rule are a liability unless both are held to the same cases, so the assertions here are
 * deliberately the same ones asserted in `Aira.UnitTests.Security`.
 */

describe('SecretMasker', () => {
  const masker = new SecretMasker();

  test('removes bearer tokens', () => {
    const result = masker.maskText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature');
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(result).toContain(REDACTED);
  });

  test('removes key/value secrets', () => {
    const result = masker.maskText('password=Sup3rSecret! and api_key=abc123def456');
    expect(result).not.toContain('Sup3rSecret!');
    expect(result).not.toContain('abc123def456');
  });

  test('removes registered literals that no pattern would catch', () => {
    const withLiteral = new SecretMasker().withLiteral('hunter2-correct-horse');
    expect(withLiteral.maskText('The user typed hunter2-correct-horse.')).not.toContain('hunter2-correct-horse');
  });

  test('ignores literals too short to be meaningful', () => {
    expect(new SecretMasker().withLiteral('abc').maskText('abcdefg')).toBe('abcdefg');
  });

  test('masks card numbers but keeps the last four', () => {
    const result = masker.maskText('Card 4111111111111111 was charged.');
    expect(result).not.toContain('4111111111111111');
    expect(result).toContain('1111');
  });

  test('partially masks email addresses', () => {
    const result = masker.maskText('Contact alice.smith@example.com for details.');
    expect(result).not.toContain('alice.smith@');
    expect(result).toContain('@example.com');
  });

  test('removes credentials embedded in urls', () => {
    expect(masker.maskText('https://admin:s3cret@internal.example.com/api')).not.toContain('s3cret');
  });

  test('redacts sensitive headers entirely', () => {
    const masked = masker.maskHeaders({
      Authorization: 'Bearer abc.def.ghi',
      Cookie: 'session=xyz',
      'Content-Type': 'application/json'
    });
    expect(masked['Authorization']).toBe(REDACTED);
    expect(masked['Cookie']).toBe(REDACTED);
    expect(masked['Content-Type']).toBe('application/json');
  });

  test('masks json by field name at any depth', () => {
    const masked = masker.maskJson(JSON.stringify({
      user: { name: 'alice', password: 'topsecret', tokens: { accessToken: 'abc123' } },
      safe: 'value'
    }));
    expect(masked).not.toContain('topsecret');
    expect(masked).not.toContain('abc123');
    expect(masked).toContain('"safe":"value"');
  });

  test('falls back to text masking for json that will not parse', () => {
    expect(masker.maskJson('{"password":"leaky-value"')).not.toContain('leaky-value');
  });

  test('replaces a sensitive step value entirely rather than pattern-masking it', () => {
    expect(masker.maskStepValue('Password123!', true)).toBe(REDACTED);
    expect(masker.maskStepValue('alice', false)).toBe('alice');
  });

  test.each([
    ['Authorization', true], ['X-Api-Key', true], ['set-cookie', true], ['Accept', false]
  ])('isSensitiveHeader(%s) === %s', (header, expected) => {
    expect(isSensitiveHeader(header as string)).toBe(expected);
  });

  test.each([
    ['password', true], ['access_token', true], ['accessToken', true], ['card-number', true], ['username', false]
  ])('isSensitiveField(%s) === %s', (field, expected) => {
    expect(isSensitiveField(field as string)).toBe(expected);
  });
});

describe('URL guard', () => {
  const options = (allowPrivateNetworks = false, allowedHosts: string[] = []) =>
    ({ allowedHosts, excludedPathPrefixes: [], allowPrivateNetworks });

  test.each([
    'ftp://example.com/file', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<script>'
  ])('rejects non-http scheme %s', url => {
    expect(isUrlAllowed(url, options(true)).allowed).toBe(false);
  });

  test.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/'
  ])('rejects cloud metadata endpoint %s', url => {
    expect(isUrlAllowed(url, options()).allowed).toBe(false);
  });

  test.each([
    'http://10.0.0.5/admin', 'http://172.16.4.1/', 'http://192.168.1.1/',
    'http://127.0.0.1:8080/', 'http://localhost:3000/', 'http://[::1]/'
  ])('rejects private or loopback target %s when disallowed', url => {
    expect(isUrlAllowed(url, options()).allowed).toBe(false);
  });

  test('allows loopback when explicitly permitted for local development', () => {
    expect(isUrlAllowed('http://localhost:4200/login', options(true)).allowed).toBe(true);
  });

  test('rejects credentials embedded in the url', () => {
    expect(isUrlAllowed('https://user:pass@example.com/', options(true)).allowed).toBe(false);
  });

  test('enforces the host allowlist', () => {
    const opts = options(true, ['app.example.com']);
    expect(isUrlAllowed('https://app.example.com/dashboard', opts).allowed).toBe(true);
    const denied = isUrlAllowed('https://evil.example.net/', opts);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain('allowed domains');
  });

  test('suffix allowlist entries match subdomains only', () => {
    expect(matchesAllowlist('app.example.com', ['.example.com'])).toBe(true);
    expect(matchesAllowlist('example.com', ['.example.com'])).toBe(true);
    expect(matchesAllowlist('notexample.com', ['.example.com'])).toBe(false);
    expect(matchesAllowlist('evilexample.com', ['.example.com'])).toBe(false);
  });

  test('honours excluded paths', () => {
    const opts = { allowedHosts: ['app.example.com'], excludedPathPrefixes: ['/logout'], allowPrivateNetworks: true };
    expect(isUrlAllowed('https://app.example.com/logout', opts).allowed).toBe(false);
    expect(isUrlAllowed('https://app.example.com/accounts', opts).allowed).toBe(true);
  });

  test.each([
    ['https://app.example.com/accounts/123', 'https://app.example.com/accounts/{id}'],
    ['https://app.example.com/accounts/123/', 'https://app.example.com/accounts/{id}'],
    ['https://APP.example.com/Accounts', 'https://app.example.com/accounts'],
    ['https://app.example.com/u/2b9f1c4e-1111-2222-3333-444455556666', 'https://app.example.com/u/{guid}'],
    ['https://app.example.com/search?q=hello&page=2', 'https://app.example.com/search?page={v}&q={v}'],
    ['https://app.example.com/page#section', 'https://app.example.com/page'],
    ['http://app.example.com:8080/x', 'http://app.example.com:8080/x']
  ])('normalizes %s', (input, expected) => {
    expect(normalizeUrl(input as string)).toBe(expected);
  });
});
