import { describe, expect, it } from 'vitest';
import {
  TOTP,
  counterFor,
  fromBase32,
  generateCode,
  generateTotpSecret,
  otpauthUri,
  toBase32,
  verifyCode,
} from '../src/index.js';

// RFC 6238 Appendix B. The seed is the ASCII string "12345678901234567890"; the vectors
// are 8-digit codes at specific unix times. Checking against the specification is the
// whole reason this is hand-written rather than a dependency.
const RFC_SEED = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: Array<[seconds: number, code: string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('RFC 6238 conformance', () => {
  for (const [seconds, expected] of RFC_VECTORS) {
    it(`matches the published vector at t=${seconds}`, () => {
      const counter = Math.floor(seconds / TOTP.stepSeconds);
      expect(generateCode(RFC_SEED, counter, 8, 'sha1')).toBe(expected);
    });
  }
});

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    for (let length = 1; length <= 40; length += 1) {
      const bytes = Buffer.from(Array.from({ length }, (_, i) => (i * 37 + 11) % 256));
      expect(fromBase32(toBase32(bytes))).toEqual(bytes);
    }
  });

  it('matches the RFC 4648 alphabet', () => {
    expect(toBase32(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('tolerates lowercase, spaces, and padding, as users type them', () => {
    const secret = generateTotpSecret();
    const spaced = (secret.match(/.{1,4}/g) ?? []).join(' ').toLowerCase();
    expect(fromBase32(spaced)).toEqual(fromBase32(secret));
  });

  it('rejects characters outside the alphabet', () => {
    expect(() => fromBase32('ABC!DEF')).toThrow(TypeError);
  });
});

describe('verifyCode', () => {
  const secret = fromBase32(generateTotpSecret());
  const at = new Date('2026-08-18T12:00:00Z');

  it('accepts the current code', () => {
    const code = generateCode(secret, counterFor(at));
    expect(verifyCode(secret, code, { at })).toMatchObject({ valid: true });
  });

  it('tolerates one step of clock drift either side', () => {
    for (const offset of [-1, 1]) {
      const code = generateCode(secret, counterFor(at) + offset);
      expect(verifyCode(secret, code, { at }).valid).toBe(true);
    }
  });

  it('rejects a code two steps away', () => {
    const code = generateCode(secret, counterFor(at) + 2);
    expect(verifyCode(secret, code, { at }).valid).toBe(false);
  });

  it('refuses a counter at or below notBefore, so a code cannot be replayed', () => {
    // A TOTP code stays valid for its whole step. Without this, a code seen over a
    // shoulder or phished seconds ago still works.
    const counter = counterFor(at);
    const code = generateCode(secret, counter);

    const first = verifyCode(secret, code, { at });
    expect(first).toMatchObject({ valid: true, counter });

    const replay = verifyCode(secret, code, { at, notBefore: first.counter ?? null });
    expect(replay.valid).toBe(false);
  });

  it('still accepts the next step after a replay is blocked', () => {
    const counter = counterFor(at);
    const next = generateCode(secret, counter + 1);
    expect(verifyCode(secret, next, { at, notBefore: counter }).valid).toBe(true);
  });

  it('rejects malformed input without touching the secret', () => {
    for (const bad of ['', 'abcdef', '12345', '1234567', '12 34 56 78']) {
      expect(verifyCode(secret, bad, { at }).valid).toBe(false);
    }
  });

  it('rejects a code generated from a different secret', () => {
    const other = fromBase32(generateTotpSecret());
    expect(verifyCode(secret, generateCode(other, counterFor(at)), { at }).valid).toBe(false);
  });
});

describe('otpauth URI', () => {
  it('carries the parameters an authenticator app needs', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'pastor@example.org');
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    const params = new URL(uri).searchParams;
    expect(params.get('secret')).toBe('JBSWY3DPEHPK3PXP');
    expect(params.get('algorithm')).toBe('SHA1');
    expect(params.get('digits')).toBe('6');
    expect(params.get('period')).toBe('30');
  });
});
