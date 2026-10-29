// E2E_RUNNER=mantis: the same Detox test files, with Mantis doing the actions and assertions
/** @type {import('@jest/types').Config.InitialOptions} */
module.exports = {
  rootDir: '..',
  testMatch: ['<rootDir>/e2e/**/*.test.js'],
  // @codelionapps/mantis is linked from the repo root (file:..), outside node_modules: plain Node code, don't transform
  transformIgnorePatterns: ['/node_modules/', require('path').resolve(__dirname, '../../src')],
  setupFilesAfterEnv: process.env.E2E_RUNNER === 'mantis' ? [require.resolve('@codelionapps/mantis/detox')] : [],
  testTimeout: 120000,
  maxWorkers: 1,
  globalSetup: 'detox/runners/jest/globalSetup',
  globalTeardown: 'detox/runners/jest/globalTeardown',
  reporters: ['detox/runners/jest/reporter'],
  testEnvironment: 'detox/runners/jest/testEnvironment',
  verbose: true,
};
