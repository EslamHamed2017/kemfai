/**
 * Shared KEMFAI lint rule set — backend/api (NestJS/TypeScript).
 *
 * Mirrors frontend/.eslintrc.js: both configs resolve through the same
 * `@typescript-eslint` parser/plugin family, disable the same "handled by
 * Prettier" formatting rules, and end with `plugin:prettier/recommended`
 * (via `eslint-config-prettier`) so TS and formatting rules never fight
 * each other in either project. Only the framework-specific base config
 * differs (`@typescript-eslint/recommended` here vs. `next/core-web-vitals`
 * + `next/typescript` in frontend/.eslintrc.js).
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: 'tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: ['plugin:@typescript-eslint/recommended', 'plugin:prettier/recommended'],
  env: {
    node: true,
    jest: true,
  },
  ignorePatterns: ['.eslintrc.js', 'dist/', 'node_modules/'],
  rules: {
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
  },
};
