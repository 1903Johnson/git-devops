/**
 * Injection tokens for values Nest cannot resolve from a type — config objects and
 * third-party classes have no metadata to key on.
 */
export const API_CONFIG = Symbol('API_CONFIG');
export const PG_POOL = Symbol('PG_POOL');
