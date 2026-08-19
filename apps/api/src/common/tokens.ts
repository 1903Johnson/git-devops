/**
 * Injection tokens for values Nest cannot resolve from a type — config objects and
 * third-party classes have no metadata to key on.
 */
export const API_CONFIG = Symbol('API_CONFIG');
export const PG_POOL = Symbol('PG_POOL');
/**
 * The module manifests this process loaded.
 *
 * Declared here rather than beside the module that provides it: a service importing the
 * token from its own module's file creates an import cycle, and under a cycle the symbol is
 * still undefined when the decorator runs — so `@Inject(undefined)` silently falls back to
 * injecting by type and Nest fails with an unresolvable "Function" dependency.
 */
export const LOADED_MODULES = Symbol('LOADED_MODULES');
