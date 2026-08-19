import { describe, expect, it } from 'vitest';
import { decidePurgeStep } from '../../src/index.js';

const now = new Date('2026-06-01T00:00:00Z');
const past = new Date('2026-05-01T00:00:00Z');
const future = new Date('2026-07-01T00:00:00Z');

describe('what to do with a module the scan called due', () => {
  it('schedules a disabled module whose retention has elapsed', () => {
    expect(decidePurgeStep({ status: 'disabled', purgeAfter: past }, now)).toEqual({
      step: 'schedule',
    });
  });

  it('purges a pending_purge module whose final grace has elapsed', () => {
    expect(decidePurgeStep({ status: 'pending_purge', purgeAfter: past }, now)).toEqual({
      step: 'purge',
    });
  });

  it('stops for a module re-enabled during the grace period', () => {
    // The race the scan cannot rule out: a row is due when the job looks and re-enabled
    // before it acts. Reaching this through the job means racing a scan against an update,
    // and a race-based test guarding a delete is worse than none — it passes when it did
    // not run.
    const decision = decidePurgeStep({ status: 'enabled', purgeAfter: past }, now);
    expect(decision.step).toBe('skip');
  });

  it('stops when the clock was pushed back', () => {
    expect(decidePurgeStep({ status: 'pending_purge', purgeAfter: future }, now).step).toBe('skip');
  });

  it('stops when there is no clock at all', () => {
    expect(decidePurgeStep({ status: 'disabled', purgeAfter: null }, now).step).toBe('skip');
  });

  it('does not purge twice', () => {
    expect(decidePurgeStep({ status: 'purged', purgeAfter: past }, now).step).toBe('skip');
  });

  it('refuses a status it does not recognise instead of assuming', () => {
    // A future migration adding a state must not be silently treated as purgeable.
    expect(decidePurgeStep({ status: 'archived', purgeAfter: past }, now).step).toBe('skip');
  });

  it('does not act at the exact instant the clock expires, only after', () => {
    expect(decidePurgeStep({ status: 'pending_purge', purgeAfter: now }, now).step).toBe('purge');
  });
});
