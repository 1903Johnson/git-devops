import type { components } from './generated/schema.js';

export type Church = components['schemas']['Church'];
export type ChurchUpdate = components['schemas']['ChurchUpdate'];
export type Campus = components['schemas']['Campus'];
export type CampusCreate = components['schemas']['CampusCreate'];
export type CampusUpdate = components['schemas']['CampusUpdate'];
export type PageInfo = components['schemas']['PageInfo'];

/** A page of results, matching the envelope every list endpoint returns. */
export interface Page<T> {
  data: T[];
  page: PageInfo;
}

/** Default and maximum `limit`, mirroring the spec so callers do not guess. */
export const PAGE_SIZE = { default: 25, max: 100 } as const;
