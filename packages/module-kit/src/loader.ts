import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModuleManifest } from './manifest.js';
import { InvalidManifestError, validateRegistry } from './validate.js';

/**
 * Where a module declares itself. One file, one name, no configuration.
 *
 * TypeScript only, and not for taste. This repo runs TypeScript directly — `@swc-node` in
 * the API, esbuild under vitest — and there is no build step anywhere. A plain `.js`
 * manifest is loaded through Node's CJS path by the SWC register hook and fails with
 * ERR_REQUIRE_CYCLE_MODULE, so accepting one here would mean a module that passes every
 * test and cannot be loaded by the running server. If a compiled deployment ever needs
 * `.js`, add it together with a test that boots the real server against one.
 */
export const MANIFEST_FILENAMES = ['manifest.ts'] as const;

export interface LoadedModule {
  readonly manifest: ModuleManifest;
  /** Absolute path to the module's directory, for locating its migrations. */
  readonly directory: string;
}

/**
 * Discovers modules by convention: every immediate subdirectory of `modulesDir` holding a
 * `manifest.ts`.
 *
 * Convention rather than a registration list on purpose (docs/03 §5). A central file
 * listing every module is a merge conflict between two agents on every module they add,
 * and a module that exists but was never added to the list is the exact failure the
 * registry is supposed to make impossible.
 */
export async function discoverModules(modulesDir: string): Promise<LoadedModule[]> {
  const root = resolve(modulesDir);
  if (!existsSync(root)) return [];

  const entries = await readdir(root, { withFileTypes: true });
  const loaded: LoadedModule[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    const manifestPath = MANIFEST_FILENAMES.map((name) => join(directory, name)).find((path) =>
      existsSync(path),
    );
    if (!manifestPath) continue;

    const imported: unknown = await import(pathToFileURL(manifestPath).href);
    const manifest =
      (imported as { manifest?: ModuleManifest; default?: ModuleManifest }).manifest ??
      (imported as { default?: ModuleManifest }).default;
    if (!manifest) {
      throw new Error(`${manifestPath} exports neither "manifest" nor a default export`);
    }
    if (manifest.key !== entry.name.replaceAll('-', '_')) {
      // The directory name is what boundary rule C3 greps for and what a reviewer reads.
      // A manifest whose key disagrees with its directory makes both of those lie.
      throw new Error(
        `${manifestPath} declares key "${manifest.key}" but lives in directory "${entry.name}"`,
      );
    }
    loaded.push({ manifest, directory });
  }

  return loaded;
}

/**
 * Discovers and validates. Throws rather than returning problems: a deployment with an
 * invalid manifest must not start, because every consequence of one is silent at runtime.
 */
export async function loadModules(modulesDir: string): Promise<LoadedModule[]> {
  const loaded = await discoverModules(modulesDir);
  const problems = validateRegistry(loaded.map((module) => module.manifest));
  if (problems.length > 0) throw new InvalidManifestError(problems);
  return loaded;
}
