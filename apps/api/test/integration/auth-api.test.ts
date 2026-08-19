// The way in. Login, MFA, rotation, logout and /me over real HTTP against a real database.
//
// What this suite is really guarding is what the endpoints decline to say: a disabled
// account and a wrong password answer identically, a stolen refresh token gets the same
// 401 as a junk one, and logging out never reveals whether the token was already dead.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_ROLE, ensureAppRole } from '@church/testing';
import { CORE_MIGRATIONS_DIR, applyMigrations, collectMigrations } from '@church/migrations';
import {
  IdentityService,
  MfaService,
  counterFor,
  fromBase32,
  generateCode,
} from '@church/identity';
import { createTestApp, TEST_KEYS, type TestApp } from '../support/app.js';

let harness: TestApp;
const church = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PASSWORD = 'correct horse battery staple';

const post = async (url: string, body: unknown, token?: string) => {
  const response = await harness.app.inject({
    method: 'POST',
    url,
    payload: body as object,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
  return {
    status: response.statusCode,
    body: JSON.parse(response.body || '{}'),
    headers: response.headers,
  };
};

const get = async (url: string, token?: string) => {
  const response = await harness.app.inject({
    method: 'GET',
    url,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
  return { status: response.statusCode, body: JSON.parse(response.body || '{}') };
};

const identity = () =>
  new IdentityService({ pool: harness.pool, appRole: APP_ROLE, policy: { checkBreaches: false } });

const newEmail = () => `auth-${Math.random().toString(36).slice(2)}@example.org`;

async function newUser(roles: string[] = []): Promise<{ email: string; userId: string }> {
  const email = newEmail();
  const created = await identity().register(church, email, PASSWORD);
  if (created.status !== 'created') throw new Error(`setup failed: ${created.status}`);
  const client = await harness.pool.connect();
  try {
    for (const role of roles) {
      await client.query('INSERT INTO user_role (church_id, user_id, role) VALUES ($1, $2, $3)', [
        church,
        created.userId,
        role,
      ]);
    }
  } finally {
    client.release();
  }
  return { email, userId: created.userId };
}

beforeAll(async () => {
  harness = await createTestApp();
  const client = await harness.pool.connect();
  try {
    await ensureAppRole(client);
    await applyMigrations(client, collectMigrations([CORE_MIGRATIONS_DIR]), { appRole: APP_ROLE });
  } finally {
    client.release();
  }
});

afterAll(async () => {
  const client = await harness.pool.connect();
  try {
    await client.query('DELETE FROM church WHERE id = $1', [church]);
  } finally {
    client.release();
    await harness.close();
  }
});

beforeEach(async () => {
  const client = await harness.pool.connect();
  try {
    await client.query('DELETE FROM church WHERE id = $1', [church]);
    await client.query(`INSERT INTO church (id, name, country) VALUES ($1, 'auth', 'US')`, [
      church,
    ]);
  } finally {
    client.release();
  }
});

describe('login', () => {
  it('issues a usable token pair', async () => {
    const { email } = await newUser(['STAFF']);
    const { status, body } = await post('/auth/login', { email, password: PASSWORD });
    expect(status).toBe(200);
    expect(body.status).toBe('success');
    const tokens = body.tokens as Record<string, unknown>;
    expect(tokens.accessToken).toBeTypeOf('string');
    expect(tokens.expiresInSeconds).toBe(900);
  });

  it('produces a token the API actually accepts', async () => {
    // The whole point of the ticket: before this, nothing could mint a token the guard
    // would take, so every authenticated route was unreachable.
    const { email } = await newUser(['STAFF']);
    const login = await post('/auth/login', { email, password: PASSWORD });
    const token = (login.body.tokens as { accessToken: string }).accessToken;
    expect((await get('/probe/tenant', token)).status).toBe(200);
  });

  it('carries the roles, so permission-guarded routes work', async () => {
    // And the corollary: a user with no roles reaches nothing. The policy engine was
    // correct all along; it just never had a subject with any roles in it.
    const staff = await newUser(['STAFF']);
    const nobody = await newUser([]);

    const staffToken = (
      (await post('/auth/login', { email: staff.email, password: PASSWORD })).body.tokens as {
        accessToken: string;
      }
    ).accessToken;
    const nobodyToken = (
      (await post('/auth/login', { email: nobody.email, password: PASSWORD })).body.tokens as {
        accessToken: string;
      }
    ).accessToken;

    expect((await get('/probe/tenant', staffToken)).status).toBe(200);
    expect((await get('/probe/tenant', nobodyToken)).status).toBe(403);
  });

  it('rejects a wrong password', async () => {
    const { email } = await newUser();
    const { status, body } = await post('/auth/login', { email, password: 'not it at all' });
    expect(status).toBe(401);
    expect(body.code).toBe('UNAUTHENTICATED');
  });

  it('answers identically for an unknown address and a disabled account', async () => {
    // Any difference here turns login into an account-existence oracle: an attacker learns
    // which addresses belong to this church one request at a time.
    const { email, userId } = await newUser();
    const client = await harness.pool.connect();
    try {
      await client.query(`UPDATE app_user SET status = 'disabled' WHERE id = $1`, [userId]);
    } finally {
      client.release();
    }

    const disabled = await post('/auth/login', { email, password: PASSWORD });
    const unknown = await post('/auth/login', { email: newEmail(), password: PASSWORD });
    const wrongPassword = await post('/auth/login', { email, password: 'wrong' });

    expect(disabled.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(disabled.body.message).toBe(unknown.body.message);
    expect(disabled.body.message).toBe(wrongPassword.body.message);
  });

  it('rejects a malformed body without touching the database', async () => {
    expect((await post('/auth/login', {})).status).toBe(400);
    expect((await post('/auth/login', { email: 'x@y.z' })).status).toBe(400);
  });

  it('locks after repeated failures and says how long to wait', async () => {
    const { email } = await newUser();
    let last = await post('/auth/login', { email, password: 'wrong' });
    for (let attempt = 0; attempt < 10 && last.status !== 429; attempt += 1) {
      last = await post('/auth/login', { email, password: 'wrong' });
    }
    expect(last.status).toBe(429);
    expect(last.body.code).toBe('RATE_LIMITED');
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('refresh rotation', () => {
  it('exchanges a refresh token for a new pair', async () => {
    const { email } = await newUser();
    const login = await post('/auth/login', { email, password: PASSWORD });
    const { refreshToken } = login.body.tokens as { refreshToken: string };

    const { status, body } = await post('/auth/refresh', { refreshToken });
    expect(status).toBe(200);
    expect(body.refreshToken).not.toBe(refreshToken);
  });

  it('refuses a spent token, and revokes the family behind it', async () => {
    // Theft detection. The response is an ordinary 401: telling a thief they were noticed
    // only tells them to move faster, and the real user's devices are already logged out.
    const { email } = await newUser();
    const login = await post('/auth/login', { email, password: PASSWORD });
    const first = (login.body.tokens as { refreshToken: string }).refreshToken;
    const rotated = await post('/auth/refresh', { refreshToken: first });
    const second = (rotated.body as { refreshToken: string }).refreshToken;

    const replay = await post('/auth/refresh', { refreshToken: first });
    expect(replay.status).toBe(401);

    // And the family is gone, so the legitimately rotated token is dead too.
    expect((await post('/auth/refresh', { refreshToken: second })).status).toBe(401);
  });

  it('refuses a token that never existed, the same way', async () => {
    const junk = await post('/auth/refresh', { refreshToken: 'not-a-real-token' });
    expect(junk.status).toBe(401);
    expect(junk.body.code).toBe('UNAUTHENTICATED');
  });
});

describe('logout', () => {
  it('ends the session and answers 204 either way', async () => {
    const { email } = await newUser();
    const login = await post('/auth/login', { email, password: PASSWORD });
    const { refreshToken } = login.body.tokens as { refreshToken: string };

    expect((await post('/auth/logout', { refreshToken })).status).toBe(204);
    expect((await post('/auth/refresh', { refreshToken })).status).toBe(401);
    // Again, on a token that is already dead: still 204. A caller logging out should never
    // be told their token had already expired.
    expect((await post('/auth/logout', { refreshToken })).status).toBe(204);
    expect((await post('/auth/logout', { refreshToken: 'junk' })).status).toBe(204);
  });

  it('ends every session on logout-all, and leaves other users alone', async () => {
    const { email } = await newUser(['STAFF']);
    const other = await newUser(['STAFF']);
    const phone = await post('/auth/login', { email, password: PASSWORD, deviceLabel: 'phone' });
    const laptop = await post('/auth/login', { email, password: PASSWORD, deviceLabel: 'laptop' });
    const bystander = await post('/auth/login', { email: other.email, password: PASSWORD });

    const access = (phone.body.tokens as { accessToken: string }).accessToken;
    const result = await post('/auth/logout-all', {}, access);
    expect(result.status).toBe(200);
    expect(result.body.sessionsEnded).toBe(2);

    for (const session of [phone, laptop]) {
      const { refreshToken } = session.body.tokens as { refreshToken: string };
      expect((await post('/auth/refresh', { refreshToken })).status).toBe(401);
    }
    const spared = (bystander.body.tokens as { refreshToken: string }).refreshToken;
    expect((await post('/auth/refresh', { refreshToken: spared })).status).toBe(200);
  });

  it('requires authentication for logout-all', async () => {
    expect((await post('/auth/logout-all', {})).status).toBe(401);
  });
});

describe('the current user', () => {
  it('reports identity, roles and expanded permissions', async () => {
    const { email } = await newUser(['STAFF']);
    const login = await post('/auth/login', { email, password: PASSWORD });
    const token = (login.body.tokens as { accessToken: string }).accessToken;

    const { status, body } = await get('/me', token);
    expect(status).toBe(200);
    expect(body).toMatchObject({ email, churchId: church, roles: ['STAFF'], mfaEnrolled: false });
    expect(body.permissions).toContain('person:read');
    expect(body.mfaRequired).toBe(true);
  });

  it('needs a token but no permission', async () => {
    // A user can always read their own identity. Without @Authenticated() this route would
    // have to be handed a permission that means nothing, or be made public.
    const { email } = await newUser([]);
    const login = await post('/auth/login', { email, password: PASSWORD });
    const token = (login.body.tokens as { accessToken: string }).accessToken;

    expect((await get('/me', token)).status).toBe(200);
    expect((await get('/me')).status).toBe(401);
  });

  it('says MFA is not required for a member', async () => {
    const { email } = await newUser(['MEMBER']);
    const login = await post('/auth/login', { email, password: PASSWORD });
    const token = (login.body.tokens as { accessToken: string }).accessToken;
    expect((await get('/me', token)).body.mfaRequired).toBe(false);
  });
});

describe('multi-factor', () => {
  it('withholds tokens until the second factor is supplied', async () => {
    const { email, userId } = await newUser(['PASTOR']);
    const secret = await enrolMfa(userId);

    const login = await post('/auth/login', { email, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.status).toBe('mfa_required');
    expect(login.body.tokens).toBeUndefined();
    expect(login.body.challenge).toBeTypeOf('string');

    // The next time step, not the current one: the code that confirmed enrolment is
    // recorded as used, and TOTP verification refuses any counter at or below it. Real
    // users hit this naturally — their app has rolled over by the time they type it in.
    const code = generateCode(secret, counterFor() + 1);
    const completed = await post('/auth/mfa', { challenge: login.body.challenge, code });
    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe('success');
  });

  it('rejects a wrong code and a forged challenge', async () => {
    const { email, userId } = await newUser(['PASTOR']);
    await enrolMfa(userId);
    const login = await post('/auth/login', { email, password: PASSWORD });

    expect(
      (await post('/auth/mfa', { challenge: login.body.challenge, code: '000000' })).status,
    ).toBe(401);
    expect((await post('/auth/mfa', { challenge: 'forged', code: '123456' })).status).toBe(401);
  });

  it('will not accept the challenge as an access token', async () => {
    // Separate audiences. A challenge that worked as a bearer token would make the second
    // factor decorative.
    const { email, userId } = await newUser(['PASTOR']);
    await enrolMfa(userId);
    const login = await post('/auth/login', { email, password: PASSWORD });
    expect((await get('/me', login.body.challenge as string)).status).toBe(401);
  });
});

/**
 * Enrols and confirms TOTP for a user, returning the raw secret so the test can generate
 * codes the way an authenticator app would. The encryption key matches the harness config.
 */
async function enrolMfa(userId: string): Promise<Buffer> {
  const mfa = new MfaService({
    pool: harness.pool,
    appRole: APP_ROLE,
    encryptionKey: new Uint8Array(32).fill(11),
  });
  const challenge = await mfa.beginEnrollment(church, userId, 'test@example.org');
  const secret = fromBase32(challenge.secret);
  const confirmed = await mfa.confirmEnrollment(church, userId, generateCode(secret, counterFor()));
  if (confirmed.status !== 'confirmed') throw new Error(`enrolment failed: ${confirmed.status}`);
  return secret;
}

void TEST_KEYS;
