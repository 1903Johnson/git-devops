/**
 * The optional-module contract and registry.
 *
 * Every module under `modules/` declares itself with a `ModuleManifest`; the registry reads
 * manifests at boot to build `module_definition`, register permissions, and decide which
 * routes a tenant may reach.
 *
 * Specification: docs/02-module-system.md
 */

export * from './manifest.js';
export * from './validate.js';
export * from './loader.js';
export * from './registry.js';
export * from './lifecycle.js';
