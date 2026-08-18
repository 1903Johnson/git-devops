// Typed client generated from the contract. Web and mobile both consume this; neither
// hand-writes a fetch call, so a contract change becomes a compile error rather than a
// runtime surprise.

export { createChurchClient, type ChurchClient, type ClientOptions } from './client.js';
export { ApiRequestError } from './errors.js';
export type {
  Campus,
  CampusCreate,
  CampusUpdate,
  Church,
  ChurchUpdate,
  Page,
  PageInfo,
} from '@church/contracts';
export { ModuleNotEnabledError, isApiError, isModuleNotEnabled } from '@church/contracts';
