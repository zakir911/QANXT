import { createHmac } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238), the codes an authenticator app shows.
 *
 * The application stores the secret its users scan as a QR code; holding the same secret
 * for a test identity lets the worker produce the code the application expects, without a
 * phone. SHA-1, a 30 second step and six digits are what every mainstream authenticator
 * uses by default.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(secret: string): Buffer {
  const clean = secret.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('The authenticator secret is not valid base32.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function hotp(key: Buffer, counter: number, digits = 6): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16)
    | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totp(secret: string, nowMs = Date.now(), stepSeconds = 30, digits = 6): string {
  return hotp(base32Decode(secret), Math.floor(nowMs / 1000 / stepSeconds), digits);
}

/** Seconds left before the current code expires. */
export function totpSecondsRemaining(nowMs = Date.now(), stepSeconds = 30): number {
  return stepSeconds - Math.floor(nowMs / 1000) % stepSeconds;
}
