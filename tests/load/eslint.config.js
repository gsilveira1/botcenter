import base from '@botcenter/config/eslint';
import globals from 'globals';

// The k6 scripts run in the k6 JavaScript runtime: `__ENV`, `__VU`, and `__ITER` are globals.
export default [
  ...base,
  {
    files: ['*.js', 'lib/**/*.js'],
    languageOptions: {
      globals: { ...globals.es2023, __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly' },
    },
  },
];
