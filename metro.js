// withMantis(config): with MANTIS_E2E=1 at bundle time, adds the Mantis JS agent to the bundle, run before the app's
// entry module (so before the React renderer); without it, returns the config unchanged.
// Metro only runs getModulesRunBeforeMainModule entries that are already in the module graph, and nothing imports
// the agent. So a transformer wrapper appends require(agent) to the config's own last run-before module (RN's
// setup-env / InitializeCore: always in the graph, always run before the entry). See src/metro/transformer.js.
const path = require("node:path");

function withMantis(config) {
  if (process.env.MANTIS_E2E !== "1") return config;
  const before = config.serializer.getModulesRunBeforeMainModule("");
  // read by src/metro/transformer.js in Metro's transform workers, which inherit this env
  process.env.MANTIS_UPSTREAM_TRANSFORMER = config.transformer.babelTransformerPath; // set by RN's default config
  process.env.MANTIS_HOST_MODULE = before[before.length - 1];
  return {
    ...config,
    transformer: { ...config.transformer, babelTransformerPath: path.join(__dirname, "src/metro/transformer.js") },
  };
}

module.exports = { withMantis };
