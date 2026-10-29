// Babel transformer wrapper used by withMantis (metro.js): the app's own transformer, plus require(agent) appended to
// the module Metro runs right before the entry module (MANTIS_HOST_MODULE).
const path = require("node:path");

const upstream = require(process.env.MANTIS_UPSTREAM_TRANSFORMER);
const AGENT = require.resolve("../agent");

module.exports = {
  ...upstream,
  transform(args) {
    if (path.resolve(args.options.projectRoot, args.filename) !== process.env.MANTIS_HOST_MODULE)
      return upstream.transform(args);
    return upstream.transform({ ...args, src: `${args.src}\nrequire(${JSON.stringify(AGENT)});\n` });
  },
};
