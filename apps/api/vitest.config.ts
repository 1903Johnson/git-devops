import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC rather than vitest's default esbuild transform: Nest resolves constructor injection
// from `design:paramtypes` metadata, and esbuild cannot emit decorator metadata at all.
// Under esbuild every provider would need an explicit @Inject() token and a forgotten one
// fails at runtime, not at compile time.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.test.ts'],
    // Integration and isolation suites share one Postgres; run files serially so a
    // transaction in one cannot see another's uncommitted fixtures.
    fileParallelism: false,
  },
});
