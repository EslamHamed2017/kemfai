/**
 * Shared KEMFAI lint rule set — frontend (Next.js/TypeScript).
 *
 * Mirrors backend/api/.eslintrc.js: both configs resolve through the same
 * `@typescript-eslint` parser/plugin family, disable the same "handled by
 * Prettier" formatting rules, and end by deferring to `eslint-config-prettier`
 * so TS/React rules never fight Prettier formatting in either project. Only
 * the framework-specific base config differs (`next/core-web-vitals` +
 * `next/typescript` here vs. `plugin:@typescript-eslint/recommended` in
 * backend/api/.eslintrc.js).
 */
module.exports = {
  root: true,
  extends: ['next/core-web-vitals', 'next/typescript', 'prettier'],
  ignorePatterns: ['.eslintrc.js', '.next/', 'node_modules/'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
  },
};
