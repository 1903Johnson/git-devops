/**
 * Where the platform API lives, including the version prefix the contract declares.
 *
 * The prefix is not optional and not a default to be overridden casually: the API serves
 * only under it (CORE-018a), so a base URL without it 404s on every call.
 */
export const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3001/api/v1';
