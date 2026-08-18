#!/usr/bin/env node
// Verifies that the generated contract types match the spec they came from.
//
// docs/03 §5 says packages/contracts and packages/sdk generated code is "generated, never
// hand-edited, and regenerated in CI". That is a rule until something enforces it: an
// edited generated file, or a spec change committed without regenerating, both compile
// cleanly and both make the two agents build against different contracts — which is the
// single failure mode the contract-first protocol exists to prevent.
//
// Usage:  node scripts/check-contracts.mjs
// Exit:   0 = generated output matches the spec, 1 = drift

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SPEC = 'packages/contracts/openapi/openapi.yaml';
const GENERATED = 'packages/contracts/src/generated/schema.ts';

const scratch = mkdtempSync(join(tmpdir(), 'contracts-'));
const candidate = join(scratch, 'schema.ts');

try {
  execFileSync('pnpm', ['exec', 'openapi-typescript', SPEC, '-o', candidate], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  const fresh = readFileSync(candidate, 'utf8');
  const committed = readFileSync(GENERATED, 'utf8');

  if (fresh !== committed) {
    console.error(
      `\ncontract check FAILED\n\n` +
        `  ${GENERATED} does not match what ${SPEC} generates.\n\n` +
        `  Either the spec changed without regenerating, or the generated file was edited\n` +
        `  by hand. Both leave the two agents building against different contracts.\n\n` +
        `  Fix: pnpm run contracts:generate\n`,
    );
    process.exit(1);
  }

  console.log('contract check: generated types match the spec');
} catch (error) {
  if (error.status === 1) process.exit(1);
  console.error('contract check could not run:', error.message);
  process.exit(1);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
