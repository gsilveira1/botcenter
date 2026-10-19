import base from '@botcenter/config/eslint';
import globals from 'globals';

// Node 24 scripts (ES modules) of the smoke test.
export default [
  ...base,
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  { ignores: ['results/**'] },
];
