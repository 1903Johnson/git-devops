// Authenticated encryption for secrets that must be recoverable, not merely verified.
//
// A password is hashed because it never needs reading back. A TOTP secret does — the
// server has to regenerate codes from it — so it is encrypted instead. Storing it in the
// clear would mean a database dump hands an attacker the ability to mint valid second
// factors indefinitely, which is worse than leaking password hashes.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export interface SealedSecret {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
}

export class SecretDecryptionError extends Error {
  constructor() {
    // Deliberately uninformative: distinguishing "wrong key" from "tampered ciphertext"
    // tells an attacker which of the two they achieved.
    super('Could not decrypt secret');
    this.name = 'SecretDecryptionError';
  }
}

function assertKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) {
    throw new TypeError(`encryption key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
}

/**
 * GCM rather than CBC: it authenticates as well as encrypts, so a modified ciphertext
 * fails loudly instead of decrypting to garbage that later code has to notice.
 */
export function sealSecret(plaintext: string, key: Uint8Array): SealedSecret {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function openSecret(sealed: SealedSecret, key: Uint8Array): string {
  assertKey(key);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, sealed.iv);
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretDecryptionError();
  }
}
