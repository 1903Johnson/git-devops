// Password hashing.
//
// scrypt from node:crypto, not a native Argon2 binding. OWASP names Argon2id first and
// scrypt as an accepted alternative; scrypt is memory-hard, ships in Node, and needs no
// node-gyp build in every environment that runs the tests. The parameters are stored
// alongside each hash so this decision can be revisited without invalidating credentials.

import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

// promisify resolves to scrypt's 3-argument overload, which drops the options parameter —
// and the options are where the cost parameters live.
const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/** OWASP-sanctioned pairing: N=2^16, r=8, p=2 — roughly 64 MiB per hash. */
export const SCRYPT_PARAMS = { N: 65536, r: 8, p: 2, keyLength: 32 } as const;

/** Node's default maxmem is 32 MiB, below what these parameters need. */
const MAX_MEM = 256 * 1024 * 1024;

const SALT_BYTES = 16;
const ALGORITHM = 'scrypt';

export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly keyLength: number;
}

/**
 * Encoded as `scrypt$N=65536,r=8,p=2$<salt>$<hash>`, PHC-shaped.
 *
 * The parameters travel with the hash so raising the cost later does not lock anyone out:
 * old hashes still verify under their own parameters, and `needsRehash` reports which
 * ones to upgrade on next successful login.
 */
export async function hashPassword(
  password: string,
  params: ScryptParams = SCRYPT_PARAMS,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password.normalize('NFKC'), salt, params.keyLength, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: MAX_MEM,
  });

  return [
    ALGORITHM,
    `N=${params.N},r=${params.r},p=${params.p}`,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

interface ParsedHash {
  readonly params: ScryptParams;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

function parse(encoded: string): ParsedHash | undefined {
  const parts = encoded.split('$');
  if (parts.length !== 4 || parts[0] !== ALGORITHM) return undefined;

  const [, paramPart, saltPart, hashPart] = parts as [string, string, string, string];
  const values: Record<string, number> = {};
  for (const pair of paramPart.split(',')) {
    const [key, value] = pair.split('=');
    if (!key || value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
    values[key] = parsed;
  }
  if (values['N'] === undefined || values['r'] === undefined || values['p'] === undefined) {
    return undefined;
  }

  const hash = Buffer.from(hashPart, 'base64');
  return {
    params: { N: values['N'], r: values['r'], p: values['p'], keyLength: hash.length },
    salt: Buffer.from(saltPart, 'base64'),
    hash,
  };
}

/**
 * Constant-time verification. Returns false for a malformed hash rather than throwing, so
 * a corrupted row cannot be distinguished from a wrong password by observing behaviour.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parse(encoded);
  if (!parsed || parsed.hash.length === 0) return false;

  const derived = await scryptAsync(
    password.normalize('NFKC'),
    parsed.salt,
    parsed.params.keyLength,
    {
      N: parsed.params.N,
      r: parsed.params.r,
      p: parsed.params.p,
      maxmem: MAX_MEM,
    },
  );

  return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
}

/** True when a stored hash was made with weaker parameters than the current policy. */
export function needsRehash(encoded: string, params: ScryptParams = SCRYPT_PARAMS): boolean {
  const parsed = parse(encoded);
  if (!parsed) return true;
  return (
    parsed.params.N < params.N ||
    parsed.params.r < params.r ||
    parsed.params.p < params.p ||
    parsed.hash.length < params.keyLength
  );
}

/**
 * Burns roughly the same work as a real verification, for logins against an address that
 * has no account. Without it, "no such user" returns in microseconds while a real check
 * takes ~100ms, and that gap enumerates the platform's users.
 */
export async function dummyVerify(password: string): Promise<false> {
  await scryptAsync(password.normalize('NFKC'), 'timing-equalisation', SCRYPT_PARAMS.keyLength, {
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: MAX_MEM,
  });
  return false;
}
