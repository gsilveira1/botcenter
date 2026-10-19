import base from '@botcenter/config/eslint';

export default [
  ...base,
  {
    files: ['**/*.ts'],
    languageOptions: {
      // typescript-eslint keeps a value import of a class that a decorated constructor uses.
      parserOptions: { emitDecoratorMetadata: true, experimentalDecorators: true },
    },
  },
];
