// The paths the server actually serves, against the paths the contract promises.
//
// Everything else in this suite asks whether a handler behaves. This asks the question
// underneath that: whether a client following the published contract would reach the
// handler at all. Nothing else can — every other test calls `inject` with a literal path,
// so the suite and the spec are free to disagree indefinitely, and they did.

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../support/app.js';

let harness: TestApp;

/** The prefix the contract declares, read from the contract rather than restated here. */
function declaredPrefix(): string {
  const spec = readFileSync(
    new URL('../../../../packages/contracts/openapi/openapi.yaml', import.meta.url),
    'utf8',
  );
  const match = /^servers:\s*\n\s*-\s*url:\s*(\S+)/m.exec(spec);
  if (!match?.[1]) throw new Error('the contract declares no server url');
  return match[1].replace(/\/$/, '');
}

beforeAll(async () => {
  harness = await createTestApp();
});

afterAll(async () => {
  await harness.close();
});

describe('the served paths match the contract', () => {
  it('serves a public route under the prefix the contract declares', async () => {
    // /auth/login with no body is a 400 from the handler. That is the point: a 400 proves
    // the route was reached, where a 404 proves it was not. Any status but 404 passes.
    const response = await harness.app.inject({
      method: 'POST',
      url: `${declaredPrefix()}/auth/login`,
      payload: {},
    });
    expect(response.statusCode).not.toBe(404);
  });

  it('does not also serve it unprefixed', async () => {
    // Serving both would make the mismatch invisible again — the contract would be
    // satisfied while every existing test kept passing against the wrong path.
    const response = await harness.app.inject({ method: 'POST', url: '/auth/login', payload: {} });
    expect(response.statusCode).toBe(404);
  });
});
