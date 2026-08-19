import type { ModuleManifest } from './manifest.js';

export interface ManifestProblem {
  readonly moduleKey: string;
  readonly field: string;
  readonly problem: string;
}

const KEY_RE = /^[a-z][a-z0-9_]*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/i;

/**
 * Checks one manifest in isolation. Cross-module rules (unique keys, resolvable
 * `requires`, cycles) need the whole set and live in `validateRegistry`.
 *
 * Every rule here maps to an invariant in docs/02, and each is checked at boot rather than
 * trusted, because the failure modes are all silent: a mis-namespaced permission denies
 * every request, a missing data class means a purge that quietly leaves rows behind.
 */
export function validateManifest(manifest: ModuleManifest): ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  const key = manifest.key;
  const add = (field: string, problem: string) => problems.push({ moduleKey: key, field, problem });

  if (!KEY_RE.test(key)) {
    // The key is also the `mod_<key>_` table prefix (boundary rule C4), so a key with a
    // hyphen or a capital produces table names the purge path will not match.
    add('key', `"${key}" is not snake_case; it is also the mod_<key>_ table prefix`);
  }
  if (!manifest.name.trim()) add('name', 'name is empty');
  if (!VERSION_RE.test(manifest.version)) {
    add('version', `"${manifest.version}" is not a semantic version`);
  }

  for (const permission of manifest.permissions) {
    if (!permission.startsWith(`${key}:`)) {
      // Unnamespaced module permissions collide across modules, and a collision means one
      // module silently granting access to another's data.
      add('permissions', `"${permission}" must be namespaced "${key}:<action>"`);
    }
    if (!/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/.test(permission)) {
      add('permissions', `"${permission}" is not a valid resource:action permission`);
    }
  }

  if (manifest.dataClasses.length === 0) {
    // A module with no declared data classes has nothing to retain, export, or purge — it
    // is far more likely that the author has not thought about it yet.
    add('dataClasses', 'declare at least one data class, or the purge path has nothing to act on');
  }
  const classNames = new Set(manifest.dataClasses.map((dataClass) => dataClass.name));
  if (classNames.size !== manifest.dataClasses.length) {
    add('dataClasses', 'data class names must be unique within a module');
  }

  if (manifest.purgePolicy.onDisable !== 'retain') {
    add('purgePolicy', 'onDisable must be "retain": disabling withdraws access, never data');
  }
  for (const held of manifest.purgePolicy.legalHoldClasses ?? []) {
    if (!classNames.has(held)) {
      add('purgePolicy', `legalHoldClasses names "${held}", which is not a declared data class`);
    }
  }

  // The rule that matters most. A module holding restricted data — minors, money,
  // pastoral records — must never arrive switched on: enabling it is a deliberate act by a
  // church admin who has seen the consent screen (docs/02 §3).
  const restricted = manifest.dataClasses.filter((c) => c.sensitivity === 'restricted');
  if (manifest.defaultEnabled && restricted.length > 0) {
    add(
      'defaultEnabled',
      `cannot default to enabled while holding restricted data (${restricted
        .map((c) => c.name)
        .join(', ')}); enabling must be a deliberate act`,
    );
  }

  const permissions = new Set<string>(manifest.permissions);
  for (const entry of manifest.nav) {
    if (!permissions.has(entry.requiresPermission)) {
      // Nav is rendered from the API. An entry gated on a permission the module never
      // declares is either a typo or a link every user can see and nobody can follow.
      add(
        'nav',
        `"${entry.label}" requires "${entry.requiresPermission}", which it does not declare`,
      );
    }
  }

  for (const event of manifest.events.publishes) {
    if (!event.startsWith(`${key}.`)) {
      add('events', `published event "${event}" must be namespaced "${key}.<event>"`);
    }
  }

  if (manifest.requires.includes(key)) add('requires', 'a module cannot require itself');

  return problems;
}

/**
 * Checks the set as a whole: duplicate keys, unresolvable requirements, and cycles.
 *
 * A cycle is not a theoretical concern — two modules that require each other can never be
 * enabled, because enabling either needs the other on first, and the failure appears as an
 * admin clicking Enable and nothing happening.
 */
export function validateRegistry(manifests: readonly ModuleManifest[]): ManifestProblem[] {
  const problems = manifests.flatMap(validateManifest);
  const byKey = new Map<string, ModuleManifest>();

  for (const manifest of manifests) {
    if (byKey.has(manifest.key)) {
      problems.push({
        moduleKey: manifest.key,
        field: 'key',
        problem: `duplicate module key "${manifest.key}"`,
      });
      continue;
    }
    byKey.set(manifest.key, manifest);
  }

  for (const manifest of manifests) {
    for (const required of manifest.requires) {
      if (!byKey.has(required)) {
        problems.push({
          moduleKey: manifest.key,
          field: 'requires',
          problem: `requires "${required}", which no module provides`,
        });
      }
    }
  }

  for (const cycle of findCycles(byKey)) {
    problems.push({
      moduleKey: cycle[0]!,
      field: 'requires',
      problem: `requirement cycle: ${[...cycle, cycle[0]].join(' -> ')}`,
    });
  }

  return problems;
}

function findCycles(byKey: ReadonlyMap<string, ModuleManifest>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (key: string): void => {
    if (state.get(key) === 'done') return;
    if (state.get(key) === 'visiting') {
      cycles.push(stack.slice(stack.indexOf(key)));
      return;
    }
    state.set(key, 'visiting');
    stack.push(key);
    for (const required of byKey.get(key)?.requires ?? []) {
      if (byKey.has(required)) visit(required);
    }
    stack.pop();
    state.set(key, 'done');
  };

  for (const key of byKey.keys()) visit(key);
  return cycles;
}

export class InvalidManifestError extends Error {
  constructor(readonly problems: readonly ManifestProblem[]) {
    super(
      `${problems.length} manifest problem(s):\n` +
        problems.map((p) => `  ${p.moduleKey}.${p.field}: ${p.problem}`).join('\n'),
    );
    this.name = 'InvalidManifestError';
  }
}
