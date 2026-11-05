/**
 * Jest for the checker. See tests/README.md.
 *
 * Every test file runs with a made-up environment (tests/setup/env.js): the real
 * `.env` is never read, outbound network is refused, and the only database is a
 * throwaway MongoDB started once per run (tests/setup/globalSetup.js).
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.{js,cjs}'],
  globalSetup: '<rootDir>/tests/setup/globalSetup.js',
  globalTeardown: '<rootDir>/tests/setup/globalTeardown.js',
  setupFiles: ['<rootDir>/tests/setup/env.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup/afterEnv.js'],
  restoreMocks: true,
  // A test that leaves a timer or socket open must not hang CI.
  testTimeout: 20000,

  collectCoverageFrom: [
    'routes/**/*.js',
    'services/**/*.js',
    'utils/**/*.js',
  ],
  coverageReporters: ['text-summary', 'lcov', 'json-summary'],
  // Ratchet: raise these with the suite, never lower them to make a run pass.
  coverageThreshold: {
    global: { lines: 0, statements: 0, functions: 0, branches: 0 },
  },
};
