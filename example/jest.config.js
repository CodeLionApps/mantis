module.exports = {
  preset: '@react-native/jest-preset',
  testPathIgnorePatterns: ['/node_modules/', '/e2e/'], // e2e/ = Detox (own config: e2e/jest.config.js)
};
