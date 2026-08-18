// TOTP (RFC 6238), implemented on node:crypto rather than pulled from a library.
//
// The algorithm is thirty lines and the RFC publishes official test vectors, so this can be
// *proved* correct against the specification instead of trusted to a dependency. A wrong
// TOTP implementation locks every staff account out of the system, which is not a failure
// mode worth taking on faith.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP = {
  /** Seconds per code. 30 is what every authenticator app assumes. */
  stepSeconds: 30,
  digits: 6,
  algorithm: 'sha1' as const,
  /**
   * Steps of clock skew tolerated either side. One step (±30s) is the usual compromise:
   * phone clocks drift, and rejecting a code the user can plainly see is worse than a
   * 90-second acceptance window on a secret that changes every 30.
   */
  window: 1,
} as const;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function toBase32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function fromBase32(encoded: string): Buffer {
  const cleaned = encoded.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new TypeError(`invalid base32 character: ${character}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 160 bits, matching the SHA-1 block the RFC assumes. */
export const generateTotpSecret = (): string => toBase32(randomBytes(20));

export const counterFor = (at: Date = new Date(), stepSeconds: number = TOTP.stepSeconds): number =>
  Math.floor(at.getTime() / 1000 / stepSeconds);

/** The RFC 4226 HOTP truncation, which TOTP applies to a time-derived counter. */
export function generateCode(
  secret: Buffer,
  counter: number,
  digits: number = TOTP.digits,
  algorithm: string = TOTP.algorithm,
): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac(algorithm, secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export interface TotpVerification {
  readonly valid: boolean;
  /** Time-step the code matched. Recorded to stop the same code being replayed. */
  readonly counter?: number;
}

/**
 * Checks a code across the tolerated window, refusing anything at or below `notBefore`.
 *
 * `notBefore` is what makes a code single-use: TOTP codes stay valid for a whole step, so
 * without it a code observed over a shoulder — or phished seconds ago — works again.
 */
export function verifyCode(
  secret: Buffer,
  code: string,
  options: { at?: Date; window?: number; notBefore?: number | null; digits?: number } = {},
): TotpVerification {
  const digits = options.digits ?? TOTP.digits;
  const normalized = code.replace(/\s/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(normalized)) return { valid: false };

  const centre = counterFor(options.at ?? new Date());
  const window = options.window ?? TOTP.window;

  for (let offset = -window; offset <= window; offset += 1) {
    const counter = centre + offset;
    if (options.notBefore != null && counter <= options.notBefore) continue;

    const expected = Buffer.from(generateCode(secret, counter, digits));
    const supplied = Buffer.from(normalized);
    if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) {
      return { valid: true, counter };
    }
  }
  return { valid: false };
}

/** The otpauth:// URI an authenticator app scans. */
export function otpauthUri(secret: string, account: string, issuer = 'Church Platform'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: TOTP.algorithm.toUpperCase(),
    digits: String(TOTP.digits),
    period: String(TOTP.stepSeconds),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
