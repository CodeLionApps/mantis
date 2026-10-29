const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const { withMantis } = require('@codelionapps/mantis/metro');

// @codelionapps/mantis is linked from the repo root (file:..): watch it and resolve its imports from this app's
// node_modules only. Otherwise a react-native in the repo root's node_modules would be bundled as a second copy
// (a second renderer, which takes over touch handling).
const config = {
  watchFolders: [path.resolve(__dirname, '..')],
  resolver: {
    nodeModulesPaths: [path.resolve(__dirname, 'node_modules')],
    disableHierarchicalLookup: true,
  },
};

// withMantis: with MANTIS_E2E=1, bundles the Mantis JS agent
module.exports = withMantis(mergeConfig(getDefaultConfig(__dirname), config));
