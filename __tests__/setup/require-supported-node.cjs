/**
 * Jest globalSetup: refuse to run on a Node major below the one package.json "engines" requires.
 *
 * Why: several suites behave differently on an older Node (CJS/ESM interop: for example the H11
 * anonymous-GET ratchet sees two routes answer 500 `authenticateToken is not a function` on Node
 * 20 and reports a baseline failure that does not exist on the supported runtime). That false red
 * misled three lanes. One clear message at the start beats a confusing failure in the middle.
 *
 * The required major is read from package.json "engines.node" (for example "^24.15.0" -> 24), not
 * hard-coded here.
 */
const fs = require('fs');
const path = require('path');

function requiredMajor(enginesNode) {
  const match = /(\d+)/.exec(String(enginesNode || ''));
  return match ? Number(match[1]) : null;
}

/** Returns an error message when `version` (for example "v20.20.2") is below the engines major, else null. */
function checkNodeVersion(version, enginesNode) {
  const required = requiredMajor(enginesNode);
  const running = Number(/^v?(\d+)/.exec(String(version))?.[1]);
  if (required === null || !Number.isFinite(running)) return null; // cannot decide: do not block
  if (running >= required) return null;
  return `backend tests require Node >=${required} (engines: ${enginesNode}); running ${version}`;
}

module.exports = async function requireSupportedNode() {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const message = checkNodeVersion(process.version, pkg.engines && pkg.engines.node);
  if (message) {
    // eslint-disable-next-line no-console
    console.error(`\n${message}\n`);
    throw new Error(message);
  }
};
module.exports.checkNodeVersion = checkNodeVersion;
module.exports.requiredMajor = requiredMajor;
