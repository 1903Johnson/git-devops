import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  InvalidAccessTokenError,
  issueAccessToken,
  verifyAccessToken,
  type KeyRing,
} from '../src/index.js';

const key = (kid: string) => ({ kid, secret: new Uint8Array(randomBytes(32)) });
const keys: KeyRing = { active: key('k1') };
const claims = {
  sub: '11111111-1111-4111-8111-111111111111',
  church_id: '22222222-2222-4222-8222-222222222222',
  roles: ['STAFF'],
};

describe('access tokens', () => {
  it('round-trips the claims the tenant layer depends on', async () => {
    const token = await issueAccessToken(claims, keys);
    const verified = await verifyAccessToken(token, keys);
    expect(verified.sub).toBe(claims.sub);
    expect(verified.church_id).toBe(claims.church_id);
    expect(verified.roles).toEqual(['STAFF']);
  });

  it('publishes the key id so verification can pick the right key', async () => {
    const token = await issueAccessToken(claims, keys);
    const header = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString());
    expect(header.kid).toBe('k1');
    expect(header.alg).toBe('HS256');
  });

  it('rejects a token signed with an unknown key', async () => {
    const token = await issueAccessToken(claims, { active: key('rogue') });
    await expect(verifyAccessToken(token, keys)).rejects.toThrow(InvalidAccessTokenError);
  });

  it('accepts a previous key during rotation, then stops once it is dropped', async () => {
    // Without the overlap, rotating a signing key logs out everyone holding a valid token.
    const old = key('k0');
    const tokenFromOld = await issueAccessToken(claims, { active: old });

    const during: KeyRing = { active: keys.active, accepted: [old] };
    await expect(verifyAccessToken(tokenFromOld, during)).resolves.toBeDefined();

    await expect(verifyAccessToken(tokenFromOld, keys)).rejects.toThrow(InvalidAccessTokenError);
  });

  it('rejects an expired token', async () => {
    const token = await issueAccessToken(claims, keys, -1);
    await expect(verifyAccessToken(token, keys)).rejects.toThrow(InvalidAccessTokenError);
  });

  it('rejects a token with the wrong issuer or audience', async () => {
    const forged = await new SignJWT({ church_id: claims.church_id, roles: [] })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setSubject(claims.sub)
      .setIssuer('somewhere-else')
      .setAudience('church-platform-api')
      .setExpirationTime('5m')
      .sign(keys.active.secret);

    await expect(verifyAccessToken(forged, keys)).rejects.toThrow(InvalidAccessTokenError);
  });

  it('rejects an unsigned token claiming alg none', async () => {
    // The classic JWT confusion attack. Pinning `algorithms` is what stops it; without
    // that, a library will take the header's word for how to verify.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ sub: claims.sub, church_id: claims.church_id, roles: ['CHURCH_ADMIN'] }),
    ).toString('base64url');

    await expect(verifyAccessToken(`${header}.${body}.`, keys)).rejects.toThrow(
      InvalidAccessTokenError,
    );
  });

  it('rejects a token missing church_id, whatever else it carries', async () => {
    const token = await new SignJWT({ roles: [] })
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setSubject(claims.sub)
      .setIssuer('church-platform')
      .setAudience('church-platform-api')
      .setExpirationTime('5m')
      .sign(keys.active.secret);

    await expect(verifyAccessToken(token, keys)).rejects.toThrow(/church_id/);
  });

  it('defaults to a 15 minute life', async () => {
    const token = await issueAccessToken(claims, keys);
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
    expect(payload.exp - payload.iat).toBe(ACCESS_TOKEN_TTL_SECONDS);
  });
});
