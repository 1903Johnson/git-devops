// eslint-config-next exports a flat-config ARRAY, not a function — calling it fails with
// "not a function or its return value is not iterable". Established while verifying
// DEP-002; see the note in pnpm-workspace.yaml.
import next from 'eslint-config-next/core-web-vitals';

export default [...next, { ignores: ['.next/**'] }];
