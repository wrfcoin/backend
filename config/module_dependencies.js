/**
 * Module Dependencies Configuration
 *
 * This file defines the dependencies between different modules in the Wrfcoin Core system.
 * It is used by the module controller to ensure that when a module is enabled,
 * all of its dependencies are also enabled.
 */

const moduleDependencies = {
  // Core modules (required for basic operation)
  core: [], // No dependencies, this is the base

  // Network and API modules
  network: ['core'],
  api_server: ['core', 'network'],
  websocket_server: ['core', 'network', 'api_server'],

  // Blockchain and consensus modules
  consensus: ['core'],
  blockchain: ['core', 'consensus'],
  test_blockchain: ['core', 'consensus', 'blockchain'],
  test_validator: ['core', 'consensus', 'blockchain'],
  seed_validators: ['core', 'consensus', 'blockchain'],

  // Storage and database modules
  storage: ['core'],
  db_push: ['core', 'storage'],
  db_migrate: ['core', 'storage'],
  db_schema_gen: ['core', 'storage'],

  // Privacy modules
  privacy: ['core', 'blockchain'],
  test_privacy: ['core', 'blockchain', 'privacy'],

  // Layer 2 and cross-chain modules
  crosschain: ['core', 'blockchain'],
  test_cross_chain: ['core', 'blockchain', 'crosschain'],
  test_sidechain: ['core', 'blockchain', 'crosschain'],

  // Chain-specific integration modules
  test_axelar: ['core', 'blockchain', 'crosschain'],
  test_layerzero: ['core', 'blockchain', 'crosschain'],
  test_wormhole: ['core', 'blockchain', 'crosschain'],
  test_near: ['core', 'blockchain', 'crosschain'],
  test_arweave: ['core', 'blockchain', 'crosschain'],
  test_bittensor: ['core', 'blockchain', 'crosschain'],

  // Computational modules
  computational: ['core', 'storage'],
  test_computational: ['core', 'storage', 'computational'],

  // Weather and oracle modules
  weather: ['core', 'storage'],
  test_weather: ['core', 'storage', 'weather'],
  oracle_workflows: ['core', 'storage'],

  // IoT and data collection modules
  test_iot: ['core', 'storage', 'weather'],
  test_sensor_community: ['core', 'storage', 'weather'],
  test_luftdaten: ['core', 'storage', 'weather'],
  test_foam: ['core', 'storage', 'weather'],
  test_ogc: ['core', 'storage', 'weather'],
  test_ttn: ['core', 'storage', 'weather'],

  // Storage node modules
  test_storj: ['core', 'storage'],
  test_storage_keeper_node: ['core', 'storage'],

  // Governance modules
  governance: ['core', 'blockchain'],
  test_governance: ['core', 'blockchain', 'governance'],
  governance_workflows: ['core', 'blockchain', 'governance'],
  seed_governance: ['core', 'blockchain', 'governance'],

  // Compute node modules
  test_akash: ['core', 'computational'],
  test_golem: ['core', 'computational'],
  test_bacalhau: ['core', 'computational'],
  test_sonm: ['core', 'computational'],

  // Achievement and reward modules
  incentives: ['core', 'blockchain'],
  test_incentives: ['core', 'blockchain', 'incentives'],
  seed_rewards: ['core', 'blockchain', 'incentives'],
  seed_achievements: ['core', 'blockchain', 'incentives'],
};

/**
 * Get all dependencies for a module, including transitive dependencies
 * @param {string} moduleName - Name of the module
 * @returns {string[]} Array of all dependencies
 */
function getAllDependencies(moduleName) {
  const seen = new Set();
  const result = [];

  function collectDependencies(mod) {
    if (seen.has(mod)) return;

    seen.add(mod);

    const directDeps = moduleDependencies[mod] || [];
    for (const dep of directDeps) {
      collectDependencies(dep);
    }

    result.push(mod);
  }

  collectDependencies(moduleName);

  // Remove the module itself from the result
  return result.filter(m => m !== moduleName);
}

/**
 * Get all modules that depend on the given module
 * @param {string} moduleName - Name of the module
 * @returns {string[]} Array of modules that depend on the given module
 */
function getDependents(moduleName) {
  const dependents = [];

  for (const [mod, deps] of Object.entries(moduleDependencies)) {
    if (deps.includes(moduleName)) {
      dependents.push(mod);
    }
  }

  return dependents;
}

/**
 * Check if a module is essential (has no dependencies and others depend on it)
 * @param {string} moduleName - Name of the module
 * @returns {boolean} Whether the module is essential
 */
function isEssentialModule(moduleName) {
  // Essential modules have no dependencies
  const hasNoDependencies =
    !moduleDependencies[moduleName] ||
    moduleDependencies[moduleName].length === 0;

  // And other modules depend on them
  const othersDependOnIt = getDependents(moduleName).length > 0;

  return hasNoDependencies && othersDependOnIt;
}

/**
 * Get all modules sorted by dependency level (topological sort)
 * @returns {string[][]} Array of arrays of modules, where each inner array
 *                       contains modules at the same dependency level
 */
function getModulesByLevel() {
  const result = [];
  const visited = new Set();

  // Start with modules that have no dependencies
  let currentLevel = Object.keys(moduleDependencies).filter(
    mod => !moduleDependencies[mod] || moduleDependencies[mod].length === 0
  );

  while (currentLevel.length > 0) {
    result.push([...currentLevel]);

    // Mark current level as visited
    currentLevel.forEach(mod => visited.add(mod));

    // Find the next level (modules whose dependencies are all visited)
    currentLevel = Object.keys(moduleDependencies).filter(mod => {
      // Skip if already visited
      if (visited.has(mod)) return false;

      // Check if all dependencies are visited
      const deps = moduleDependencies[mod] || [];
      return deps.every(dep => visited.has(dep));
    });
  }

  return result;
}

module.exports = {
  moduleDependencies,
  getAllDependencies,
  getDependents,
  isEssentialModule,
  getModulesByLevel,
};
