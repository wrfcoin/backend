/**
 * Wrfcoin Core Workflow Manager
 *
 * This utility implements the workflow optimization strategies outlined in the
 * workflow-architecture.md document. It helps manage component dependencies,
 * conditionally start services, and monitor system health.
 */

const { exec } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Dependency Graph: Maps components to their dependencies
const dependencyGraph = {
  // Core Infrastructure
  'wrfcoin-core': [],
  'database-push': [],
  'api-server': ['database-push'],
  'websocket-server': ['api-server'],

  // Network Modes (mutually exclusive)
  'testnet-mode': ['api-server', 'websocket-server'],
  'mainnet-mode': ['api-server', 'websocket-server'],

  // Data Management
  'seed-achievements': ['database-push'],
  'generate-schema': ['database-push'],

  // Database Migration Tools
  'db-migrate': ['database-push'],
  'db-migrate-apply': ['db-migrate'],
  'db-migrate-list': ['db-migrate'],
  'create-migration': ['database-push'],

  // Test Suites - Grouped by domain
  // Computational domain
  'test-computational-db': ['api-server'],
  'test-fixed-database': ['api-server'],
  'test-typescript-db': ['api-server'],

  // Cross-chain domain
  'test-cross-chain': ['api-server'],

  // Blockchain domain
  'test-incentives': ['api-server'],
  'test-pop': ['api-server'],
  'test-privacy': ['api-server'],

  // IoT domain
  'test-iot-devices': ['api-server'],

  // Achievement domain
  'test-achievements': ['seed-achievements', 'api-server'],

  // Database domain
  'test-db-migration': ['db-migrate', 'create-migration'],
};

// Component Groups: Organizes components into logical groups
const componentGroups = {
  infrastructure: [
    'wrfcoin-core',
    'database-push',
    'api-server',
    'websocket-server',
  ],
  'network-mode': ['testnet-mode', 'mainnet-mode'],
  'data-management': ['seed-achievements', 'generate-schema'],
  'db-migration': [
    'db-migrate',
    'db-migrate-apply',
    'db-migrate-list',
    'create-migration',
  ],
  'computational-tests': [
    'test-computational-db',
    'test-fixed-database',
    'test-typescript-db',
  ],
  'cross-chain-tests': ['test-cross-chain'],
  'blockchain-tests': ['test-incentives', 'test-pop', 'test-privacy'],
  'iot-tests': ['test-iot-devices'],
  'achievement-tests': ['test-achievements'],
  'db-tests': ['test-db-migration'],
};

// Component to workflow name mapping
const workflowNames = {
  'wrfcoin-core': 'Wrfcoin Core',
  'database-push': 'Database Push',
  'api-server': 'API Server',
  'websocket-server': 'WebSocket Server',
  'testnet-mode': 'Testnet Mode',
  'mainnet-mode': 'Mainnet Mode',
  'seed-achievements': 'Seed Achievements',
  'generate-schema': 'Generate Schema',
  'db-migrate': 'DB Migrate',
  'db-migrate-apply': 'DB Migrate Apply',
  'db-migrate-list': 'DB Migrate List',
  'create-migration': 'Create Migration',
  'test-computational-db': 'Test Computational DB',
  'test-fixed-database': 'Test Fixed Database',
  'test-typescript-db': 'Test TypeScript DB',
  'test-cross-chain': 'Test Cross-Chain',
  'test-incentives': 'Test Incentives',
  'test-pop': 'Test PoP',
  'test-privacy': 'Test Privacy',
  'test-iot-devices': 'Test IoT Devices',
  'test-achievements': 'Test Achievements',
  'test-db-migration': 'Test DB Migration',
};

// Component scripts mapping
const componentScripts = {
  'wrfcoin-core': 'cd src && npm run dev',
  'database-push': 'node scripts/db-push.js',
  'api-server': 'node server/server.js',
  'websocket-server': 'node server/ws_server.js',
  'testnet-mode': 'node scripts/start-testnet.js',
  'mainnet-mode': 'node scripts/start-mainnet.js',
  'seed-achievements': 'node scripts/seed-achievements.js',
  'generate-schema': 'node scripts/generate-schema.js',
  'db-migrate': 'node scripts/db-migrate.js list',
  'db-migrate-apply': 'node scripts/db-migrate.js apply',
  'db-migrate-list': 'node scripts/db-migrate.js list',
  'create-migration': 'node scripts/create-migration.js migration_name',
  'test-computational-db': 'node scripts/test-computational.js',
  'test-fixed-database': 'node scripts/test-computational-fixed.js',
  'test-typescript-db': 'node scripts/test-computational-ts.js',
  'test-cross-chain': 'node scripts/test-cross-chain.js',
  'test-incentives': 'node scripts/test-incentives.js',
  'test-pop': 'node scripts/test-pop.js',
  'test-privacy': 'node scripts/test-privacy.js',
  'test-iot-devices': 'node scripts/test-iot-devices.js',
  'test-achievements': 'node scripts/test-achievements.js',
  'test-db-migration': 'node scripts/test-db-migration.js',
};

// Port mappings
const servicePorts = {
  'wrfcoin-core': 5000,
  'api-server': 3000,
  'websocket-server': 5001,
};

// Component state tracking
const componentState = {};

/**
 * Check if a port is available (not in use)
 *
 * @param {number} port - The port to check
 * @returns {Promise<boolean>} - True if the port is available, false otherwise
 */
function isPortAvailable(port) {
  return new Promise(resolve => {
    const tester = net
      .createServer()
      .once('error', () => resolve(false))
      .once('listening', () => {
        tester.once('close', () => resolve(true)).close();
      })
      .listen(port, '0.0.0.0');
  });
}

/**
 * Check if a service is responding on the given port
 *
 * @param {string} host - The host to check
 * @param {number} port - The port to check
 * @param {string} path - The path to check (optional)
 * @returns {Promise<boolean>} - True if the service is responding, false otherwise
 */
function checkServiceHealth(host, port, path = '/') {
  return new Promise(resolve => {
    const request = http.request(
      {
        host,
        port,
        path,
        method: 'GET',
        timeout: 5000,
      },
      response => {
        if (response.statusCode >= 200 && response.statusCode < 500) {
          resolve(true);
        } else {
          resolve(false);
        }
      }
    );

    request.on('error', () => resolve(false));
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });

    request.end();
  });
}

/**
 * Check if the database schema is current (no migrations needed)
 *
 * @returns {Promise<boolean>} - True if the schema is current, false otherwise
 */
async function isDatabaseSchemaCurrent() {
  return new Promise(resolve => {
    exec('node scripts/db-migrate.js list', (error, stdout) => {
      if (error) {
        resolve(false);
        return;
      }

      // Check for "No pending migrations" message
      resolve(
        stdout.includes('No pending migrations') ||
          stdout.includes('All migrations applied')
      );
    });
  });
}

/**
 * Check if a component's dependencies are satisfied
 *
 * @param {string} component - The component to check
 * @returns {Promise<boolean>} - True if all dependencies are satisfied, false otherwise
 */
async function areDependenciesSatisfied(component) {
  const dependencies = dependencyGraph[component] || [];

  for (const dependency of dependencies) {
    if (!componentState[dependency] || componentState[dependency] !== 'ready') {
      return false;
    }
  }

  return true;
}

/**
 * Start a component and its dependencies
 *
 * @param {string} component - The component to start
 * @param {boolean} skipHealthCheck - Skip health check for this component
 * @returns {Promise<boolean>} - True if the component started successfully, false otherwise
 */
async function startComponent(component, skipHealthCheck = false) {
  if (componentState[component] === 'ready') {
    console.log(`Component ${component} is already running`);
    return true;
  }

  if (componentState[component] === 'starting') {
    console.log(`Component ${component} is already starting`);
    return false;
  }

  // Check dependencies
  const dependenciesSatisfied = await areDependenciesSatisfied(component);
  if (!dependenciesSatisfied) {
    console.log(`Dependencies for ${component} are not satisfied`);
    return false;
  }

  // Special case for mutually exclusive components
  if (
    component === 'testnet-mode' &&
    componentState['mainnet-mode'] === 'ready'
  ) {
    console.log('Cannot start testnet mode when mainnet mode is running');
    return false;
  }

  if (
    component === 'mainnet-mode' &&
    componentState['testnet-mode'] === 'ready'
  ) {
    console.log('Cannot start mainnet mode when testnet mode is running');
    return false;
  }

  // Check port availability for services that require it
  if (servicePorts[component]) {
    const portAvailable = await isPortAvailable(servicePorts[component]);
    if (!portAvailable) {
      console.log(
        `Port ${servicePorts[component]} for ${component} is not available`
      );
      return false;
    }
  }

  // Special cases for conditional startup
  if (component === 'database-push') {
    // Skip if schema is current
    const schemaCurrent = await isDatabaseSchemaCurrent();
    if (schemaCurrent) {
      console.log('Database schema is current, skipping database-push');
      componentState[component] = 'ready';
      return true;
    }
  }

  // Start the component
  console.log(`Starting component ${component}`);
  componentState[component] = 'starting';

  const script = componentScripts[component];
  const workflow = workflowNames[component];

  // Execute the workflow
  console.log(`Executing workflow ${workflow}: ${script}`);
  // In a real implementation, this would use Replit workflows API
  // For now, we'll simulate it with a message
  console.log(`Started ${workflow}`);

  // For non-service components, mark as ready immediately
  if (!servicePorts[component] || skipHealthCheck) {
    componentState[component] = 'ready';
    return true;
  }

  // For service components, check health
  try {
    // Wait for the service to start (give it a few seconds)
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Check if the service is responding
    const isHealthy = await checkServiceHealth(
      'localhost',
      servicePorts[component]
    );
    if (isHealthy) {
      componentState[component] = 'ready';
      console.log(`Component ${component} is healthy`);
      return true;
    } else {
      componentState[component] = 'failed';
      console.error(`Component ${component} failed health check`);
      return false;
    }
  } catch (error) {
    componentState[component] = 'failed';
    console.error(`Error starting component ${component}:`, error);
    return false;
  }
}

/**
 * Start a group of components in parallel
 *
 * @param {string} groupName - The name of the group to start
 * @returns {Promise<object>} - Status of each component in the group
 */
async function startComponentGroup(groupName) {
  const group = componentGroups[groupName];
  if (!group) {
    console.error(`Group ${groupName} not found`);
    return {};
  }

  console.log(`Starting component group ${groupName}`);

  const results = {};
  const promises = group.map(async component => {
    const success = await startComponent(component);
    results[component] = success ? 'ready' : 'failed';
  });

  await Promise.all(promises);
  return results;
}

/**
 * Get the status of all components
 *
 * @returns {object} - Component status map
 */
function getComponentStatus() {
  return componentState;
}

/**
 * Reset the state of a specific component
 *
 * @param {string} component - The component to reset
 */
function resetComponent(component) {
  if (componentState[component]) {
    delete componentState[component];
    console.log(`Reset state for component ${component}`);
  }
}

/**
 * Initialize the optimized workflow
 * This is the main entry point to start components in optimal order
 *
 * @param {string} mode - 'testnet' or 'mainnet'
 * @returns {Promise<object>} - Status of all components
 */
async function initializeWorkflow(mode = 'testnet') {
  console.log(`Initializing workflow in ${mode} mode`);

  // Start core infrastructure
  await startComponentGroup('infrastructure');

  // Start network mode
  if (mode === 'testnet') {
    await startComponent('testnet-mode');
  } else {
    await startComponent('mainnet-mode');
  }

  // Start data management in parallel
  await startComponentGroup('data-management');

  // Start DB migration if needed
  const schemaCurrent = await isDatabaseSchemaCurrent();
  if (!schemaCurrent) {
    await startComponentGroup('db-migration');
  }

  return getComponentStatus();
}

// Export the public API
module.exports = {
  dependencyGraph,
  componentGroups,
  workflowNames,
  startComponent,
  startComponentGroup,
  getComponentStatus,
  resetComponent,
  initializeWorkflow,
  isPortAvailable,
  checkServiceHealth,
  isDatabaseSchemaCurrent,
};
