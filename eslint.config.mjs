// Flat ESLint config. The boundary rule below is the editor-time half of INF-003; the
// repo-wide half lives in scripts/check-boundaries.mjs and runs in CI. Both exist because
// they catch the violation at different moments: ESLint while you type, the script across
// files ESLint never loads (SQL migrations, manifests).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/build/**', '**/coverage/**', '**/node_modules/**', '**/.next/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // C1: backend core must never depend on an optional module (docs/01 §2).
    files: ['apps/api/**/*.{ts,tsx}', 'apps/worker/**/*.{ts,tsx}', 'packages/*/src/**/*.{ts,tsx}'],
    ignores: ['packages/sdk/**', 'packages/contracts/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/modules/*', '**/modules/*/**', '@church/mod-*'],
              message:
                'Core must not import from an optional module (boundary rule C1, docs/01 §2). Publish an interface from core or emit an event instead.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
);
