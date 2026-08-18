import { describe, expect, it } from 'vitest';
import {
  MissingTenantContextError,
  currentTenant,
  runWithTenant,
  tryCurrentTenant,
} from '../src/index.js';

const CHURCH = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('tenant context', () => {
  it('has no ambient tenant by default', () => {
    expect(tryCurrentTenant()).toBeUndefined();
    expect(() => currentTenant('read')).toThrow(MissingTenantContextError);
  });

  it('exposes the tenant inside the scope and nowhere outside it', () => {
    runWithTenant({ churchId: CHURCH }, () => {
      expect(currentTenant().churchId).toBe(CHURCH);
    });
    expect(tryCurrentTenant()).toBeUndefined();
  });

  it('survives async boundaries', async () => {
    await runWithTenant({ churchId: CHURCH }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(currentTenant().churchId).toBe(CHURCH);
    });
  });

  it('keeps concurrent requests separate', async () => {
    // Two overlapping "requests" interleaving on the event loop. If the context were
    // module-global rather than async-local, one would read the other's church.
    const read = (church: string, delay: number) =>
      runWithTenant({ churchId: church }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return currentTenant().churchId;
      });

    const [a, b] = await Promise.all([read(CHURCH, 20), read(OTHER, 1)]);
    expect(a).toBe(CHURCH);
    expect(b).toBe(OTHER);
  });

  it('nests without leaking the inner tenant outward', () => {
    runWithTenant({ churchId: CHURCH }, () => {
      runWithTenant({ churchId: OTHER }, () => {
        expect(currentTenant().churchId).toBe(OTHER);
      });
      expect(currentTenant().churchId).toBe(CHURCH);
    });
  });

  it('rejects a church id that is not a UUID', () => {
    // Anything else means it came from somewhere untrusted, and it is about to be put
    // into a session setting that policies compare against.
    expect(() => runWithTenant({ churchId: "1' OR '1'='1" }, () => 0)).toThrow(TypeError);
    expect(() => runWithTenant({ churchId: '' }, () => 0)).toThrow(TypeError);
  });
});
