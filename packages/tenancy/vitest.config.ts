import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Every test in this package talks to a real PostgreSQL. Running them in
    // parallel against one database invites cross-test interference that looks
    // exactly like the isolation bugs these helpers exist to catch.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
