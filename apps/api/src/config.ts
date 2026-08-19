import { fileURLToPath } from 'node:url';
import type { KeyRing } from '@church/identity';

/**
 * Environment, parsed once at boot and never read again from `process.env`.
 *
 * Every value here is required. A server that starts with a missing signing key and
 * discovers it on the first login has turned a boot-time failure into a 3am incident, so
 * the process refuses to start instead.
 */
export interface ApiConfig {
  readonly port: number;
  readonly host: string;
  readonly databaseUrl: string;
  readonly appRole: string;
  readonly keys: KeyRing;
  /**
   * 32 bytes, for the AES-GCM envelope around stored TOTP secrets.
   *
   * Separate from the JWT signing keys on purpose: signing keys rotate freely, but rotating
   * this one requires re-encrypting every enrolled credential, so conflating them would
   * make routine key rotation a migration. In production it comes from KMS or a secrets
   * manager, never from an environment variable in a shell history.
   */
  readonly mfaEncryptionKey: Uint8Array;
  /** Where optional modules live. Discovered by convention; see docs/02 §1. */
  readonly modulesDir: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new ConfigError(`${name} is not set`);
  return value;
}

/**
 * Signing keys as `kid:base64secret`, comma-separated. The first is active (it signs); the
 * rest are accepted (they verify). That ordering is what makes key rotation a deploy rather
 * than an outage: publish the new key as accepted everywhere, then promote it to active.
 */
export function parseKeyRing(raw: string): KeyRing {
  const entries = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf(':');
      if (separator <= 0) throw new ConfigError(`malformed signing key, expected kid:secret`);
      const kid = part.slice(0, separator);
      const secret = Buffer.from(part.slice(separator + 1), 'base64');
      if (secret.byteLength < 32) {
        throw new ConfigError(`signing key ${kid} is shorter than 32 bytes`);
      }
      return { kid, secret: new Uint8Array(secret) };
    });

  const [active, ...accepted] = entries;
  if (!active) throw new ConfigError('JWT_SIGNING_KEYS is empty');
  return { active, accepted };
}

/** Base64, exactly 32 bytes. AES-256-GCM takes nothing else, and a short key fails late. */
export function parseEncryptionKey(raw: string): Uint8Array {
  const key = Buffer.from(raw, 'base64');
  if (key.byteLength !== 32) {
    throw new ConfigError(`MFA_ENCRYPTION_KEY must be 32 bytes base64, got ${key.byteLength}`);
  }
  return new Uint8Array(key);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: required(env, 'DATABASE_URL'),
    // Defaults to the unprivileged role, never to a superuser: RLS does not apply to
    // superusers at all, so a wrong default here silently disables tenant isolation.
    appRole: env.APP_DB_ROLE ?? 'app_runtime',
    keys: parseKeyRing(required(env, 'JWT_SIGNING_KEYS')),
    mfaEncryptionKey: parseEncryptionKey(required(env, 'MFA_ENCRYPTION_KEY')),
    modulesDir: env.MODULES_DIR ?? fileURLToPath(new URL('../../../modules/', import.meta.url)),
  };
}
