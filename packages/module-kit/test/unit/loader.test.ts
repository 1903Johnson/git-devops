import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { discoverModules, loadModules } from '../../src/index.js';

const FIXTURES = new URL('../fixtures/', import.meta.url).pathname;

// Scratch manifests are written inside the package, not into the OS temp directory, and
// always as .ts — that is what the running server loads, and a .js manifest in /tmp
// transforms fine under vitest while failing under the API's SWC hook. A test that passes
// on a file production cannot load is worse than no test.
const SCRATCH = new URL('../.tmp/', import.meta.url).pathname;
const scratchDir = async (name: string): Promise<string> => {
  await mkdir(SCRATCH, { recursive: true });
  return mkdtemp(join(SCRATCH, `${name}-`));
};

afterAll(async () => {
  await rm(SCRATCH, { recursive: true, force: true });
});

describe('discovery by convention', () => {
  it('finds every directory holding a manifest, in a stable order', async () => {
    const found = await discoverModules(FIXTURES);
    expect(found.map((m) => m.manifest.key)).toEqual(['good_module', 'needs_good']);
  });

  it('returns nothing rather than throwing when there is no modules directory', async () => {
    // A deployment with no optional modules is a valid deployment, and the common one on
    // day one. It must boot.
    expect(await discoverModules(join(tmpdir(), 'definitely-not-here'))).toEqual([]);
  });

  it('ignores a directory with no manifest', async () => {
    const root = await scratchDir('modules');
    await mkdir(join(root, 'not_a_module'), { recursive: true });
    await writeFile(join(root, 'not_a_module', 'readme.md'), 'nothing here');
    expect(await discoverModules(root)).toEqual([]);
  });

  it('refuses a manifest whose key disagrees with its directory', async () => {
    // The directory name is what boundary rule C3 greps for and what a reviewer reads.
    // A mismatch makes both of them lie.
    const root = await scratchDir('modules');
    await mkdir(join(root, 'bad_directory_name'), { recursive: true });
    await writeFile(
      join(root, 'bad_directory_name', 'manifest.ts'),
      `export const manifest = { key: 'something_else', requires: [] };`,
    );
    await expect(discoverModules(root)).rejects.toThrow(/declares key "something_else"/);
  });
});

describe('loading', () => {
  it('loads the fixture set, dependencies and all', async () => {
    const loaded = await loadModules(FIXTURES);
    expect(loaded.map((m) => m.manifest.key)).toEqual(['good_module', 'needs_good']);
  });

  it('refuses to load a set with an unresolvable requirement', async () => {
    // A deployment with a broken manifest must not start: every consequence of one is
    // silent at runtime.
    const root = await scratchDir('modules');
    await mkdir(join(root, 'orphan'), { recursive: true });
    await writeFile(
      join(root, 'orphan', 'manifest.ts'),
      `export const manifest = {
         key: 'orphan', name: 'Orphan', version: '1.0.0', minPlan: 'FREE',
         defaultEnabled: false, requires: ['gone'], permissions: ['orphan:read'],
         dataClasses: [{ name: 'thing', sensitivity: 'standard', retention: 'P1Y' }],
         purgePolicy: { onDisable: 'retain', retentionAfterDisable: 'P90D',
                        purgeStrategy: 'hard_delete', auditPurge: true },
         nav: [], events: { publishes: [], consumes: [] },
       };`,
    );
    await expect(loadModules(root)).rejects.toThrow(/no module provides/);
  });

  it('loads a valid set and reports each module directory', async () => {
    const root = await scratchDir('modules');
    await mkdir(join(root, 'alpha'), { recursive: true });
    await writeFile(
      join(root, 'alpha', 'manifest.ts'),
      `export const manifest = {
         key: 'alpha', name: 'Alpha', version: '1.0.0', minPlan: 'FREE',
         defaultEnabled: false, requires: [], permissions: ['alpha:read'],
         dataClasses: [{ name: 'thing', sensitivity: 'standard', retention: 'P1Y' }],
         purgePolicy: { onDisable: 'retain', retentionAfterDisable: 'P90D',
                        purgeStrategy: 'hard_delete', auditPurge: true },
         nav: [], events: { publishes: [], consumes: [] },
       };`,
    );
    const loaded = await loadModules(root);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.manifest.key).toBe('alpha');
    expect(loaded[0]!.directory).toContain('alpha');
  });
});
