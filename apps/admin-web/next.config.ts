import type { NextConfig } from 'next';

const config: NextConfig = {
  // Both UI packages resolve through `dist`, so they must be built before this app runs.
  // pnpm's topological ordering handles that for `build`; `dev` needs them built once.
  // transpilePackages covers the ESM/JSX interop for their published output.
  transpilePackages: ['@church/ui', '@church/ui-tokens'],
};

export default config;
