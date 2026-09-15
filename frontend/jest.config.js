const nextJest = require('next/jest');

const createJestConfig = nextJest({
  dir: './',
});

/** @type {import('jest').Config} */
const customJestConfig = {
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  testEnvironment: 'jsdom',
  testMatch: ['<rootDir>/tests/unit/**/*.spec.tsx', '<rootDir>/tests/unit/**/*.spec.ts'],
};

module.exports = createJestConfig(customJestConfig);
