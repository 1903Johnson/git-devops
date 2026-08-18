import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretDecryptionError, openSecret, sealSecret } from '../src/index.js';

const key = new Uint8Array(randomBytes(32));

describe('secret sealing', () => {
  it('round-trips a secret', () => {
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    expect(openSecret(sealSecret(secret, key), key)).toBe(secret);
  });

  it('produces different ciphertext each time for the same secret', () => {
    // A fresh IV per encryption: identical ciphertexts would reveal which users share a
    // secret, and reusing an IV with GCM is catastrophic rather than merely untidy.
    const a = sealSecret('same secret', key);
    const b = sealSecret('same secret', key);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.iv.equals(b.iv)).toBe(false);
  });

  it('refuses a ciphertext that has been tampered with', () => {
    const sealed = sealSecret('JBSWY3DPEHPK3PXP', key);
    const flipped = Buffer.from(sealed.ciphertext);
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    const tampered = { ...sealed, ciphertext: flipped };
    expect(() => openSecret(tampered, key)).toThrow(SecretDecryptionError);
  });

  it('refuses a forged authentication tag', () => {
    const sealed = sealSecret('JBSWY3DPEHPK3PXP', key);
    const tampered = { ...sealed, tag: randomBytes(16) };
    expect(() => openSecret(tampered, key)).toThrow(SecretDecryptionError);
  });

  it('refuses the wrong key', () => {
    const sealed = sealSecret('JBSWY3DPEHPK3PXP', key);
    expect(() => openSecret(sealed, new Uint8Array(randomBytes(32)))).toThrow(
      SecretDecryptionError,
    );
  });

  it('says the same thing for a wrong key as for tampering', () => {
    // Distinguishing the two tells an attacker which of them they achieved.
    const sealed = sealSecret('JBSWY3DPEHPK3PXP', key);
    const wrongKey = (() => {
      try {
        openSecret(sealed, new Uint8Array(randomBytes(32)));
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();
    const tamperedMessage = (() => {
      const tampered = { ...sealed, tag: randomBytes(16) };
      try {
        openSecret(tampered, key);
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(wrongKey).toBe(tamperedMessage);
  });

  it('rejects a key of the wrong length rather than padding it', () => {
    expect(() => sealSecret('x', new Uint8Array(16))).toThrow(TypeError);
  });
});
