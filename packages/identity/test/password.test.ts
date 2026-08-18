import { describe, expect, it } from 'vitest';
import {
  SCRYPT_PARAMS,
  dummyVerify,
  hashPassword,
  needsRehash,
  verifyPassword,
} from '../src/index.js';

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('Correct horse battery staple', hash)).toBe(false);
  });

  it('produces a different hash each time for the same password', async () => {
    // Distinct salts: identical hashes would let anyone reading the table see which
    // accounts share a password.
    const [a, b] = await Promise.all([
      hashPassword('same passphrase here'),
      hashPassword('same passphrase here'),
    ]);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same passphrase here', a)).toBe(true);
    expect(await verifyPassword('same passphrase here', b)).toBe(true);
  });

  it('encodes its parameters so cost can be raised later', async () => {
    const hash = await hashPassword('a sufficiently long passphrase');
    expect(
      hash.startsWith(`scrypt$N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}$`),
    ).toBe(true);
    expect(hash.split('$')).toHaveLength(4);
  });

  it('treats unicode-equivalent passwords as the same', async () => {
    // é as one code point vs e + combining accent. Without normalisation a password typed
    // on a different keyboard silently stops working.
    const composed = 'café passphrase long';
    const decomposed = 'café passphrase long';
    const hash = await hashPassword(composed);
    expect(await verifyPassword(decomposed, hash)).toBe(true);
  });

  it('returns false for a malformed hash instead of throwing', async () => {
    // A corrupted row must be indistinguishable from a wrong password.
    for (const bad of [
      '',
      'nonsense',
      'scrypt$bad$salt',
      'bcrypt$N=1,r=1,p=1$c2FsdA==$aGFzaA==',
      'scrypt$N=0,r=8,p=2$c2FsdA==$aGFzaA==',
    ]) {
      expect(await verifyPassword('whatever', bad)).toBe(false);
    }
  });

  it('flags weaker stored parameters for rehash', async () => {
    const weak = await hashPassword('a sufficiently long passphrase', {
      N: 16384,
      r: 8,
      p: 1,
      keyLength: 32,
    });
    expect(needsRehash(weak)).toBe(true);
    expect(await verifyPassword('a sufficiently long passphrase', weak)).toBe(true);

    const current = await hashPassword('a sufficiently long passphrase');
    expect(needsRehash(current)).toBe(false);
  });

  it('spends comparable time on a missing account as on a real check', async () => {
    // The timing gap this closes is what turns a login form into a user directory.
    const hash = await hashPassword('a sufficiently long passphrase');

    const realStart = performance.now();
    await verifyPassword('wrong password entirely', hash);
    const real = performance.now() - realStart;

    const dummyStart = performance.now();
    await dummyVerify('wrong password entirely');
    const dummy = performance.now() - dummyStart;

    // Generous bounds: this asserts the same order of magnitude, not a constant, because
    // CI runners are noisy. A missing dummy hash would show up as ~1000x, not 2x.
    expect(dummy).toBeGreaterThan(real / 4);
    expect(dummy).toBeLessThan(real * 4);
  });
});
