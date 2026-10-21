const fs = require('fs');
const path = require('path');
const http = require('http');

const { spawn } = require('child_process');
const EventEmitter = require('events');

const {
  isPortAvailable,
  checkServiceHealth,
  dependencyGraph,
  workflowNames,
  componentScripts,
  servicePorts,
} = require('./workflow-manager');

/**
 * Wrfcoin Core Component Scheduler
 *
 * This module implements Phase 2 of the workflow optimization plan:
 * - Advanced component grouping
 * - Parallel execution framework
 * - Detailed metrics collection
 *
 * It builds on the workflow-manager.js from Phase 1 but adds more sophisticated
 * scheduling capabilities, metrics collection, and service composition.
 */

// Create an event emitter for component events
const componentEvents = new EventEmitter();

// Metrics storage
const metrics = {
  startup: {
    startTime: null,
    endTime: null,
    duration: null,
    components: {},
  },
  scheduler: {
    efficiency: 0,
    parallelism: 0,
    idleTime: 0,
    criticalPath: [],
  },
};

// Component state tracking
const componentState = {};

// Task queue for scheduling
const taskQueue = [];

// Active tasks being executed
const activeTasks = new Set();

// Maximum parallel tasks
const MAX_PARALLEL_TASKS = 4;

/**
 * Component group definitions with composite functions
 * Organized into the 7 established categories for our 58+ workflows
 */
const componentGroups = {
  // 1. Core System Workflows
  coreSystem: {
    components: [
      'database-push',
      'api-server',
      'websocket-server',
      'wrfcoin-core',
      'mainnet-mode',
      'testnet-mode',
    ],
    startGroup: async function () {
      const startTime = Date.now();
      metrics.startup.components['coreSystem'] = {
        startTime,
        endTime: null,
        duration: null,
      };

      console.log('Starting Core System workflows');

      // Start database first
      await scheduleComponent('database-push');

      // Then start API server and frontend in parallel
      await Promise.all([
        scheduleComponent('api-server'),
        scheduleComponent('wrfcoin-core'),
      ]);

      // Finally start WebSocket server (depends on API server)
      await scheduleComponent('websocket-server');

      const endTime = Date.now();
      metrics.startup.components['coreSystem'].endTime = endTime;
      metrics.startup.components['coreSystem'].duration = endTime - startTime;

      return true;
    },
  },

  // 2. Database Management
  databaseManagement: {
    components: [
      'db-push',
      'db-migrate',
      'db-migrate-apply',
      'db-migrate-list',
      'create-migration',
      'oracle-schema-migration',
      'axelar-schema-push',
      'create-data-aware-blocks-migration',
    ],
    startGroup: async function () {
      const startTime = Date.now();
      metrics.startup.components['databaseManagement'] = {
        startTime,
        endTime: null,
        duration: null,
      };

      console.log('Starting Database Management workflows');

      // Group into migration and schema components
      const migrationComponents = [
        'db-migrate',
        'db-migrate-apply',
        'db-migrate-list',
      ];

      // First handle push operations
      await scheduleComponent('db-push');

      // Then run migrations if needed
      const migrationsNeeded = await checkMigrationsNeeded();
      if (migrationsNeeded) {
        console.log('Database migrations needed, running migration components');
        for (const component of migrationComponents) {
          await scheduleComponent(component);
        }
      }

      const endTime = Date.now();
      metrics.startup.components['databaseManagement'].endTime = endTime;
      metrics.startup.components['databaseManagement'].duration =
        endTime - startTime;

      return true;
    },
  },

  // 3. Data Seeding
  dataSeeding: {
    components: [
      'seed-achievements',
      'seed-governance',
      'seed-rewards',
      'seed-validators',
      'generate-schema',
      'setup-governance-db',
      'setup-wolfram-db',
    ],
    startGroup: async function () {
      const startTime = Date.now();
      metrics.startup.components['dataSeeding'] = {
        startTime,
        endTime: null,
        duration: null,
      };

      console.log('Starting Data Seeding workflows');

      // Start database setup components first
      await Promise.all([
        scheduleComponent('setup-governance-db'),
        scheduleComponent('setup-wolfram-db'),
      ]);

      // Then generate the schema
      await scheduleComponent('generate-schema');

      // Finally seed with data in parallel since they now have schemas
      await Promise.all([
        scheduleComponent('seed-achievements'),
        scheduleComponent('seed-governance'),
        scheduleComponent('seed-rewards'),
        scheduleComponent('seed-validators'),
      ]);

      const endTime = Date.now();
      metrics.startup.components['dataSeeding'].endTime = endTime;
      metrics.startup.components['dataSeeding'].duration = endTime - startTime;

      return true;
    },
  },

  // 4. Specialized Testing
  specializedTesting: {
    components: [
      'test-computational-db',
      'test-fixed-database',
      'test-typescript-db',
      'test-db-migration',
      'test-incentives',
      'test-pop',
      'test-privacy',
      'test-governance',
      'test-achievements',
    ],
    startGroup: async function () {
      const startTime = Date.now();
      metrics.startup.components['specializedTesting'] = {
        startTime,
        endTime: null,
        duration: null,
      };

      console.log('Starting Specialized Testing workflows');

      // Group by test type
      const dbTests = [
        'test-computational-db',
        'test-fixed-database',
        'test-typescript-db',
        'test-db-migration',
      ];
      const blockchainTests = ['test-incentives', 'test-pop', 'test-privacy'];
      const appTests = ['test-governance', 'test-achievements'];

      // Run DB tests first (sequential to avoid DB conflicts)
      for (const test of dbTests) {
        await scheduleComponent(test);
      }

      // Then run blockchain and app tests in parallel
      await Promise.all([
        ...blockchainTests.map(test => scheduleComponent(test)),
        ...appTests.map(test => scheduleComponent(test)),
      ]);

      const endTime = Date.now();
      metrics.startup.components['specializedTesting'].endTime = endTime;
      metrics.startup.components['specializedTesting'].duration =
        endTime - startTime;

      return true;
    },
  },

  // 5. Cross-Chain Testing
  crossChainTesting: {
    components: [
      'test-cross-chain',
      'test-cross-chain-providers',
      'test-layer-zero',
      'test-axelar',
      'test-wormhole',
      'test-near-protocol',
      'test-bittensor',
    ],
    startGroup: async function () {
      const startTime = Date.now();
      metrics.startup.components['crossChainTesting'] = {
        startTime,
        endTime: null,
        duration: null,
      };

      console.log('Starting Cross-Chain Testing workflows');

      // General cross-chain tests first
      await Promise.all([
        scheduleComponent('test-cross-chain'),
        scheduleComponent('test-cross-chain-providers'),
      ]);

      // Then specific bridge implementations
      const bridgeTests = ['test-layer-zero', 'test-axelar', 'test-wormhole'];
      await Promise.all(bridgeTests.map(test => scheduleComponent(test)));

      // Finally protocol-specific tests
      const protocolTests = ['test-near-protocol', 'test-bittensor'];
      await Promise.all(protocolTests.map(test => scheduleComponent(test)));

      const endTime = Date.now();
      metrics.startup.components['crossChainTesting'].endTime = endTime;
      metrics.startup.components['crossChainTesting'].duration =
        endTime - startTime;

      return true;
    },
  },

  // 6. Computational and Storage Network Testing
  computationalAndStorage: {
    components: [
      'test-computational-blocks',
      'test-bacalhau',
      'test-golem',
      'test-tataucloud',
      'test-storj',
      'test-arweave',
      'test-sonm',
      'test-light-client',
      'test-bigchaindb',
      'test-akash-network',
    ],
    startGroup: async function () {
      const startTime = Date.now();
      metrics.startup.components['computationalAndStorage'] = {
        startTime,
        endTime: null,
        duration: null,
      };

      console.log(
        'Starting Computational and Storage Network Testing workflows'
      );

      // Group tests by category
      const computationalTests = [
        'test-computational-blocks',
        'test-bacalhau',
        'test-golem',
      ];
      const storageTests = ['test-storj', 'test-arweave'];
      const miscNetworkTests = [
        'test-tataucloud',
        'test-sonm',
        'test-light-client',
        'test-bigchaindb',
        'test-akash-network',
      ];

      // Run computational tests first, as they might create data for storage tests
      await Promise.all(
        computationalTests.map(test => scheduleComponent(test))
      );

      // Then storage tests
      await Promise.all(storageTests.map(test => scheduleComponent(test)));

      // Finally misc network tests
      await Promise.all(miscNetworkTests.map(test => scheduleComponent(test)));

      const endTime = Date.now();
      metrics.startup.components['computationalAndStorage'].endTime = endTime;
      metrics.startup.components['computationalAndStorage'].duration =
        endTime - startTime;

      return true;
    },
  },

  // 7. Weather and IoT Testing
  weatherAndIoT: {
    components: [
      'test-iot-devices',
      'test-weather-data-validation',
      'test-weather-station-protocol',
      'test-forecast-compute-node',
      'test-storage-keeper-node',
      'test-validator-node',
      'test-luftdaten',
      'test-sensor-community',
      'test-streamr',
      'test-foam',
      'test-ogc',
      'test-ttn',
    ],
    startGroup: async function () {
      const startTime = Date.now();
      metrics.startup.components['weatherAndIoT'] = {
        startTime,
        endTime: null,
        duration: null,
      };

      console.log('Starting Weather and IoT Testing workflows');

      // Group tests by category
      const weatherTests = [
        'test-weather-data-validation',
        'test-weather-station-protocol',
        'test-forecast-compute-node',
      ];
      const nodeTests = ['test-storage-keeper-node', 'test-validator-node'];
      const iotPlatformTests = [
        'test-iot-devices',
        'test-luftdaten',
        'test-sensor-community',
        'test-streamr',
        'test-foam',
        'test-ogc',
        'test-ttn',
      ];

      // Start weather validation first
      await Promise.all(weatherTests.map(test => scheduleComponent(test)));

      // Then node tests
      await Promise.all(nodeTests.map(test => scheduleComponent(test)));

      // Finally IoT platform integration tests
      await Promise.all(iotPlatformTests.map(test => scheduleComponent(test)));

      const endTime = Date.now();
      metrics.startup.components['weatherAndIoT'].endTime = endTime;
      metrics.startup.components['weatherAndIoT'].duration =
        endTime - startTime;

      return true;
    },
  },

  // Testing utilities group (kept for backwards compatibility)
  legacyTesting: {
    components: ['test-db-migration'],
    startGroup: async function () {
      const startTime = Date.now();
      metrics.startup.components['legacyTesting'] = {
        startTime,
        endTime: null,
        duration: null,
      };

      console.log('Starting legacy testing group (for backward compatibility)');

      // Just one component in this group
      await scheduleComponent('test-db-migration');

      const endTime = Date.now();
      metrics.startup.components['legacyTesting'].endTime = endTime;
      metrics.startup.components['legacyTesting'].duration =
        endTime - startTime;

      return true;
    },
  },
};

/**
 * Check if database migrations are needed
 *
 * @returns {Promise<boolean>} - True if migrations are needed, false otherwise
 */
async function checkMigrationsNeeded() {
  return new Promise(resolve => {
    const child = spawn('node', ['scripts/db-migrate.js', 'list']);
    let output = '';

    child.stdout.on('data', data => {
      output += data.toString();
    });

    child.on('close', () => {
      // Check if there are pending migrations
      const hasPendingMigrations =
        !output.includes('No pending migrations') &&
        !output.includes('All migrations applied');

      resolve(hasPendingMigrations);
    });
  });
}

/**
 * Check component dependencies
 *
 * @param {string} component - The component to check
 * @returns {Promise<boolean>} - True if dependencies are satisfied, false otherwise
 */
async function checkDependencies(component) {
  const dependencies = dependencyGraph[component] || [];

  for (const dependency of dependencies) {
    if (
      !componentState[dependency] ||
      componentState[dependency] !== 'running'
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Schedule a component for execution
 *
 * @param {string} component - The component to schedule
 * @returns {Promise<boolean>} - True if scheduled successfully
 */
async function scheduleComponent(component) {
  return new Promise((resolve, reject) => {
    // Check if already running
    if (componentState[component] === 'running') {
      console.log(`Component ${component} is already running`);
      return resolve(true);
    }

    // Add to task queue
    taskQueue.push({
      component,
      resolve,
      reject,
      time: Date.now(),
    });

    // Try to process queue
    processQueue();
  });
}

/**
 * Process the task queue
 */
async function processQueue() {
  // If we're at max capacity, wait
  if (activeTasks.size >= MAX_PARALLEL_TASKS) {
    return;
  }

  // Find a task that has its dependencies satisfied
  for (let i = 0; i < taskQueue.length; i++) {
    const task = taskQueue[i];
    const dependenciesOk = await checkDependencies(task.component);

    if (dependenciesOk) {
      // Remove from queue
      taskQueue.splice(i, 1);

      // Add to active tasks
      activeTasks.add(task.component);

      // Start the component
      startComponent(task.component)
        .then(result => {
          // Remove from active tasks
          activeTasks.delete(task.component);

          // Resolve the promise
          task.resolve(result);

          // Try to process more tasks
          processQueue();
        })
        .catch(error => {
          // Remove from active tasks
          activeTasks.delete(task.component);

          // Reject the promise
          task.reject(error);

          // Try to process more tasks
          processQueue();
        });

      // We've started a task, so return
      return;
    }
  }
}

/**
 * Start a component
 *
 * @param {string} component - The component to start
 * @returns {Promise<boolean>} - True if started successfully
 */
// Extended workflow names mapping (includes all our new categories)
const extendedWorkflowNames = {
  // Core System workflows
  'wrfcoin-core': 'Wrfcoin Core',
  'database-push': 'Database Push',
  'api-server': 'API Server',
  'websocket-server': 'WebSocket Server',
  'testnet-mode': 'Testnet Mode',
  'mainnet-mode': 'Mainnet Mode',

  // Database Management workflows
  'db-push': 'DB Push',
  'db-migrate': 'DB Migrate',
  'db-migrate-apply': 'DB Migrate Apply',
  'db-migrate-list': 'DB Migrate List',
  'create-migration': 'Create Migration',
  'oracle-schema-migration': 'Oracle Schema Migration',
  'axelar-schema-push': 'Axelar Schema Push',
  'create-data-aware-blocks-migration': 'Create Data-Aware Blocks Migration',

  // Data Seeding workflows
  'seed-achievements': 'Seed Achievements',
  'seed-governance': 'Seed Governance',
  'seed-rewards': 'Seed Rewards',
  'seed-validators': 'Seed Validators',
  'generate-schema': 'Generate Schema',
  'setup-governance-db': 'Setup Governance DB',
  'setup-wolfram-db': 'Setup Wolfram DB',

  // Specialized Testing workflows
  'test-computational-db': 'Test Computational DB',
  'test-fixed-database': 'Test Fixed Database',
  'test-typescript-db': 'Test TypeScript DB',
  'test-db-migration': 'Test DB Migration',
  'test-incentives': 'Test Incentives',
  'test-pop': 'Test PoP',
  'test-privacy': 'Test Privacy',
  'test-governance': 'Test Governance',
  'test-achievements': 'Test Achievements',

  // Cross-Chain Testing workflows
  'test-cross-chain': 'Test Cross-Chain',
  'test-cross-chain-providers': 'Test Cross-Chain Providers',
  'test-layer-zero': 'Test LayerZero',
  'test-axelar': 'Test Axelar',
  'test-wormhole': 'Test Wormhole',
  'test-near-protocol': 'Test Near Protocol',
  'test-bittensor': 'Test Bittensor',

  // Computational and Storage Network Testing workflows
  'test-computational-blocks': 'Test Computational Blocks',
  'test-bacalhau': 'Test Bacalhau',
  'test-golem': 'Test Golem',
  'test-tataucloud': 'Test TatauCloud',
  'test-storj': 'Test Storj',
  'test-arweave': 'Test Arweave',
  'test-sonm': 'Test SONM',
  'test-light-client': 'Test Light Client',
  'test-bigchaindb': 'Test BigchainDB',
  'test-akash-network': 'Test Akash Network',

  // Weather and IoT Testing workflows
  'test-iot-devices': 'Test IoT Devices',
  'test-weather-data-validation': 'Test Weather Data Validation',
  'test-weather-station-protocol': 'Test Weather Station Protocol',
  'test-forecast-compute-node': 'Test Forecast Compute Node',
  'test-storage-keeper-node': 'Test Storage Keeper Node',
  'test-validator-node': 'Test Validator Node',
  'test-luftdaten': 'Test Luftdaten',
  'test-sensor-community': 'Test Sensor.Community',
  'test-streamr': 'Test Streamr',
  'test-foam': 'Test FOAM',
  'test-ogc': 'Test OGC',
  'test-ttn': 'Test TTN',

  // Testing utilities
  'test-workflow-categories': 'Test Workflow Categories',
};

// Extended component scripts mapping
const extendedComponentScripts = {
  // Core System workflows
  'wrfcoin-core': 'cd src && npm run dev',
  'database-push': 'node scripts/db-push.js',
  'api-server': 'node server/server.js',
  'websocket-server': 'node server/ws_server.js',
  'testnet-mode': 'node scripts/start-testnet.js',
  'mainnet-mode': 'node scripts/start-mainnet.js',

  // Database Management workflows
  'db-push': 'node scripts/db-push.js',
  'db-migrate': 'node scripts/db-migrate.js list',
  'db-migrate-apply': 'node scripts/db-migrate.js apply',
  'db-migrate-list': 'node scripts/db-migrate.js list',
  'create-migration': 'node scripts/create-migration.js migration_name',
  'oracle-schema-migration': 'node scripts/create-oracle-migration.js',
  'axelar-schema-push': 'node scripts/axelar-schema-push.js',
  'create-data-aware-blocks-migration':
    'node scripts/create-data-aware-blocks.js',

  // Data Seeding workflows
  'seed-achievements': 'node scripts/seed-achievements.js',
  'seed-governance': 'node scripts/seed-governance.js',
  'seed-rewards': 'node scripts/seed-rewards.js',
  'seed-validators': 'node scripts/seed-validators.js',
  'generate-schema': 'node scripts/generate-schema.js',
  'setup-governance-db': 'node scripts/setup-governance-db.js',
  'setup-wolfram-db': 'node scripts/setup-wolfram-db.js',

  // Specialized Testing workflows
  'test-computational-db': 'node scripts/test-computational.js',
  'test-fixed-database': 'node scripts/test-computational-fixed.js',
  'test-typescript-db': 'node scripts/test-computational-ts.js',
  'test-db-migration': 'node scripts/test-db-migration.js',
  'test-incentives': 'node scripts/test-incentives.js',
  'test-pop': 'node scripts/test-pop.js',
  'test-privacy': 'node scripts/test-privacy.js',
  'test-governance': 'node scripts/test-governance.js',
  'test-achievements': 'node scripts/test-achievements.js',

  // Cross-Chain Testing workflows
  'test-cross-chain': 'node scripts/test-cross-chain.js',
  'test-cross-chain-providers': 'node scripts/test-cross-chain-providers.js',
  'test-layer-zero': 'node scripts/test-layer-zero.js',
  'test-axelar': 'node scripts/test-axelar.js',
  'test-wormhole': 'node scripts/test-wormhole.js',
  'test-near-protocol': 'node scripts/test-near.js',
  'test-bittensor': 'node scripts/test-bittensor.js',

  // Computational and Storage Network Testing workflows
  'test-computational-blocks': 'node scripts/test-data-aware-blocks.js',
  'test-bacalhau': 'node scripts/test-bacalhau.js',
  'test-golem': 'node scripts/test-golem.js',
  'test-tataucloud': 'node scripts/test-tataucloud.js',
  'test-storj': 'node scripts/test-storj.js',
  'test-arweave': 'node scripts/test-arweave.js',
  'test-sonm': 'node scripts/test-sonm.js',
  'test-light-client': 'node scripts/test-light-client.js',
  'test-bigchaindb': 'node scripts/test-bigchaindb.js',
  'test-akash-network': 'node scripts/test-akash-network.js',

  // Weather and IoT Testing workflows
  'test-iot-devices': 'node scripts/test-iot-devices.js',
  'test-weather-data-validation':
    'node scripts/test-weather-data-validation.js',
  'test-weather-station-protocol':
    'node scripts/test-weather-station-protocol.js',
  'test-forecast-compute-node': 'node scripts/test-forecast-compute-node.js',
  'test-storage-keeper-node': 'node scripts/test-storage-keeper-node.js',
  'test-validator-node': 'node scripts/test-validator-node.js',
  'test-luftdaten': 'node scripts/test-luftdaten.js',
  'test-sensor-community': 'node scripts/test-sensor-community.js',
  'test-streamr': 'node scripts/test-streamr.js',
  'test-foam': 'node scripts/test-foam.js',
  'test-ogc': 'node scripts/test-ogc.js',
  'test-ttn': 'node scripts/test-ttn.js',

  // Testing utilities
  'test-workflow-categories': 'node scripts/test-workflow-categories.js',
};

/**
 * Validate component name to prevent injection attacks
 */
function validateComponentName(component) {
  // Only allow alphanumeric characters, hyphens, and underscores
  const validPattern = /^[a-zA-Z0-9_-]+$/;
  if (!validPattern.test(component)) {
    throw new Error(`Invalid component name: ${component}`);
  }

  // Check against whitelist of known components
  const allValidComponents = [
    ...Object.keys(extendedWorkflowNames),
    ...Object.keys(extendedComponentScripts),
  ];

  if (!allValidComponents.includes(component)) {
    throw new Error(`Unknown component: ${component}`);
  }

  return true;
}

/**
 * Safely parse and validate script commands
 */
function parseScriptSafely(script) {
  if (!script || typeof script !== 'string') {
    throw new Error('Invalid script provided');
  }

  // Split script into command and args
  const parts = script.trim().split(/\s+/);
  const command = parts[0];
  const args = parts.slice(1);

  // Validate command is in whitelist of allowed commands
  const allowedCommands = ['node', 'npm', 'cd'];
  if (!allowedCommands.includes(command)) {
    throw new Error(`Command not allowed: ${command}`);
  }

  // Validate arguments don't contain shell injection patterns
  const dangerousPatterns = [';', '&&', '||', '|', '`', '$', '>', '<', '&'];
  for (const arg of args) {
    for (const pattern of dangerousPatterns) {
      if (arg.includes(pattern)) {
        throw new Error(`Dangerous pattern detected in argument: ${arg}`);
      }
    }
  }

  return { command, args };
}

async function startComponent(component) {
  return new Promise(async (resolve, reject) => {
    try {
      // Validate component name first
      validateComponentName(component);

      console.log(`Starting component ${component}`);
      componentState[component] = 'starting';

      // Record metrics
      metrics.startup.components[component] = {
        startTime: Date.now(),
        endTime: null,
        duration: null,
      };

      // Get workflow name and script - first check our extended mappings,
      // then fall back to the original workflow manager mappings
      const workflow =
        extendedWorkflowNames[component] || workflowNames[component];
      const script =
        extendedComponentScripts[component] || componentScripts[component];

      // Verify we have valid values
      if (!workflow || !script) {
        console.error(
          `Initialization failed: Cannot find workflow or script for component ${component}`
        );
        // Save metrics for debugging
        const metricsFile = path.join(
          __dirname,
          '..',
          'logs',
          `startup-metrics-${Date.now()}.json`
        );
        fs.writeFileSync(metricsFile, JSON.stringify(metrics, null, 2));
        console.log(`Metrics saved to ${metricsFile}`);

        metrics.startup.components[component].endTime = Date.now();
        metrics.startup.components[component].duration =
          metrics.startup.components[component].endTime -
          metrics.startup.components[component].startTime;

        return reject(
          new Error(`Cannot find workflow or script for component ${component}`)
        );
      }

      // Create logs directory if it doesn't exist
      const logsDir = path.join(__dirname, '..', 'logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }

      // Create log file for this component
      const logFile = path.join(logsDir, `${component}.log`);
      const logStream = fs.createWriteStream(logFile, { flags: 'a' });

      // Safely parse script command and arguments
      const { command, args } = parseScriptSafely(script);

      // Start the process
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Log output
      child.stdout.pipe(logStream);
      child.stderr.pipe(logStream);

      child.stdout.on('data', data => {
        console.log(`[${component}] ${data.toString().trim()}`);
      });

      child.stderr.on('data', data => {
        console.error(`[${component}] Error: ${data.toString().trim()}`);
      });

      // Check for port if it's a service
      if (servicePorts[component]) {
        // Wait for port to be in use
        let attempts = 0;
        const maxAttempts = 10;

        while (attempts < maxAttempts) {
          const available = await isPortAvailable(servicePorts[component]);

          if (!available) {
            // Port is in use, so service is probably running
            // Wait a bit for it to initialize fully
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Check health if it's an API server
            if (component === 'api-server') {
              try {
                const healthy = await checkServiceHealth(
                  'localhost',
                  servicePorts[component],
                  '/health'
                );
                if (healthy) {
                  break;
                }
              } catch (error) {
                console.error(
                  `Health check failed for ${component}: ${error.message}`
                );
              }
            } else {
              // For other services, just assume it's running if the port is in use
              break;
            }
          }

          attempts++;
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        if (attempts >= maxAttempts) {
          // Port never became available
          componentState[component] = 'failed';
          metrics.startup.components[component].endTime = Date.now();
          metrics.startup.components[component].duration =
            metrics.startup.components[component].endTime -
            metrics.startup.components[component].startTime;
          metrics.startup.components[component].status = 'failed';

          reject(new Error(`Timeout waiting for ${component} to start`));
          return;
        }
      } else {
        // For non-services, wait for process to exit
        child.on('close', code => {
          if (code === 0) {
            componentState[component] = 'running';
            metrics.startup.components[component].endTime = Date.now();
            metrics.startup.components[component].duration =
              metrics.startup.components[component].endTime -
              metrics.startup.components[component].startTime;
            metrics.startup.components[component].status = 'success';

            resolve(true);
          } else {
            componentState[component] = 'failed';
            metrics.startup.components[component].endTime = Date.now();
            metrics.startup.components[component].duration =
              metrics.startup.components[component].endTime -
              metrics.startup.components[component].startTime;
            metrics.startup.components[component].status = 'failed';

            reject(new Error(`${component} exited with code ${code}`));
          }
        });

        // Return early for non-services
        return;
      }

      // If we get here, the service is running
      componentState[component] = 'running';
      metrics.startup.components[component].endTime = Date.now();
      metrics.startup.components[component].duration =
        metrics.startup.components[component].endTime -
        metrics.startup.components[component].startTime;
      metrics.startup.components[component].status = 'success';

      // Emit event
      componentEvents.emit('component:started', {
        component,
        duration: metrics.startup.components[component].duration,
      });

      resolve(true);
    } catch (error) {
      componentState[component] = 'failed';

      if (metrics.startup.components[component]) {
        metrics.startup.components[component].endTime = Date.now();
        metrics.startup.components[component].duration =
          metrics.startup.components[component].endTime -
          metrics.startup.components[component].startTime;
        metrics.startup.components[component].status = 'failed';
        metrics.startup.components[component].error = error.message;
      }

      // Emit event
      componentEvents.emit('component:failed', {
        component,
        error: error.message,
      });

      reject(error);
    }
  });
}

/**
 * Stop a component
 *
 * @param {string} component - The component to stop
 * @returns {Promise<boolean>} - True if stopped successfully
 */
/**
 * Validate PID to prevent injection attacks
 */
function validatePID(pid) {
  // PID should be a positive integer
  const pidNum = parseInt(pid, 10);
  if (isNaN(pidNum) || pidNum <= 0 || pidNum > 65535) {
    throw new Error(`Invalid PID: ${pid}`);
  }

  // Additional check: PID should only contain digits
  if (!/^\d+$/.test(pid)) {
    throw new Error(`PID contains invalid characters: ${pid}`);
  }

  return pidNum;
}

async function stopComponent(component) {
  return new Promise((resolve, reject) => {
    try {
      // Validate component name first
      validateComponentName(component);

      console.log(`Stopping component ${component}`);

      // Check if component is running
      if (componentState[component] !== 'running') {
        console.log(`Component ${component} is not running`);
        resolve(true);
        return;
      }

      // Mark as stopping
      componentState[component] = 'stopping';

      // Use ps to find the PID
      const child = spawn('ps', ['aux']);
      let output = '';

      child.stdout.on('data', data => {
        output += data.toString();
      });

      child.on('close', () => {
        // Get workflow name and script
        const workflow = workflowNames[component];
        const script = componentScripts[component];

        if (!script) {
          console.log(`No script found for ${component}`);
          componentState[component] = 'stopped';
          resolve(true);
          return;
        }

        // Find the PID
        const lines = output.split('\n');
        const processLine = lines.find(line => line.includes(script));

        if (!processLine) {
          console.log(`Process for ${component} not found`);
          componentState[component] = 'stopped';
          resolve(true);
          return;
        }

        // Extract PID (second column)
        const pid = processLine.trim().split(/\s+/)[1];

        if (!pid) {
          console.log(`PID for ${component} not found`);
          componentState[component] = 'stopped';
          resolve(true);
          return;
        }

        try {
          // Validate PID before using it
          const validatedPID = validatePID(pid);

          // Kill the process using validated PID
          const kill = spawn('kill', ['-15', validatedPID.toString()]);

          kill.on('close', code => {
            if (code === 0) {
              console.log(`Stopped ${component} (PID ${validatedPID})`);
              componentState[component] = 'stopped';
              resolve(true);
            } else {
              console.error(
                `Failed to stop ${component} (PID ${validatedPID})`
              );
              componentState[component] = 'unknown';
              reject(new Error(`Failed to stop ${component}`));
            }
          });
        } catch (pidError) {
          console.error(`Invalid PID for ${component}: ${pidError.message}`);
          componentState[component] = 'unknown';
          reject(
            new Error(`Invalid PID for ${component}: ${pidError.message}`)
          );
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Start a component group
 *
 * @param {string} groupName - The name of the group to start
 * @param {object} options - Options for starting the group
 * @returns {Promise<boolean>} - True if started successfully
 */
async function startGroup(groupName, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      // Handle legacy group names for backward compatibility
      let mappedGroupName = groupName;

      // Map old group names to new categories
      const groupMapping = {
        infrastructure: 'coreSystem',
        database: 'databaseManagement',
        data: 'dataSeeding',
        migration: 'databaseManagement',
        core: 'coreSystem',
        api: 'coreSystem',
        computational: 'computationalAndStorage',
        blockchain: 'specializedTesting',
        iot: 'weatherAndIoT',
        dbtests: 'legacyTesting',
      };

      if (groupMapping[groupName]) {
        console.log(
          `Remapping legacy group '${groupName}' to '${groupMapping[groupName]}'`
        );
        mappedGroupName = groupMapping[groupName];
      }

      const group = componentGroups[mappedGroupName];

      if (!group) {
        reject(
          new Error(
            `Group ${groupName} (mapped to ${mappedGroupName}) not found`
          )
        );
        return;
      }

      group.startGroup(options.mode).then(resolve).catch(reject);
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Get the status of all components
 *
 * @returns {object} - Status of all components
 */
function getComponentStatus() {
  return componentState;
}

/**
 * Calculate scheduler metrics
 */
function calculateSchedulerMetrics() {
  // Calculate total startup time
  const startTime = metrics.startup.startTime;
  const endTime = metrics.startup.endTime;
  const totalDuration = endTime - startTime;

  // Calculate theoretical minimum time (critical path)
  let criticalPathTime = 0;
  const criticalPath = [];

  // Identify critical path (longest chain of dependent components)
  const visited = new Set();

  function dfs(component, pathTime, path) {
    if (visited.has(component)) return pathTime;

    visited.add(component);
    path.push(component);

    const componentTime = metrics.startup.components[component]?.duration || 0;
    pathTime += componentTime;

    let maxTime = pathTime;
    let maxPath = [...path];

    // Check all components that depend on this one
    Object.entries(dependencyGraph).forEach(([comp, deps]) => {
      if (deps.includes(component) && !visited.has(comp)) {
        const [time, subPath] = dfs(comp, pathTime, [...path]);
        if (time > maxTime) {
          maxTime = time;
          maxPath = subPath;
        }
      }
    });

    return [maxTime, maxPath];
  }

  // Find critical path starting from components with no dependencies
  Object.entries(dependencyGraph).forEach(([component, deps]) => {
    if (deps.length === 0) {
      const [time, path] = dfs(component, 0, []);
      if (time > criticalPathTime) {
        criticalPathTime = time;
        criticalPath.length = 0;
        criticalPath.push(...path);
      }
    }
  });

  // Calculate efficiency (critical path time / total time)
  const efficiency = criticalPathTime / totalDuration;

  // Calculate average parallelism (sum of all component times / total time)
  let totalComponentTime = 0;
  Object.values(metrics.startup.components).forEach(component => {
    if (component.duration) {
      totalComponentTime += component.duration;
    }
  });

  const parallelism = totalComponentTime / totalDuration;

  // Calculate idle time (time with no active tasks)
  const idleTime = totalDuration - totalComponentTime;

  // Update metrics
  metrics.scheduler.efficiency = efficiency;
  metrics.scheduler.parallelism = parallelism;
  metrics.scheduler.idleTime = idleTime;
  metrics.scheduler.criticalPath = criticalPath;
}

/**
 * Initialize the system with optimized workflow categories
 *
 * @param {object} options - Options for initialization
 * @param {string} options.mode - 'mainnet' or 'testnet' mode
 * @param {boolean} options.skipTests - Whether to skip test components
 * @param {string[]} options.specificCategories - Run only these specific categories
 * @returns {Promise<boolean>} - True if initialized successfully
 */
async function initializeSystem(options = {}) {
  const mode = options.mode || 'testnet';
  const skipTests = options.skipTests || false;
  const specificCategories = options.specificCategories || null;

  console.log(
    `Initializing Wrfcoin Core in ${mode} mode ${skipTests ? '(skipping tests)' : ''}`
  );

  // Record start time
  metrics.startup.startTime = Date.now();

  try {
    // Define the categories to start in sequence
    // The essential categories that must always run
    const essentialCategories = [
      'coreSystem', // Core system services
      'databaseManagement', // Database setup and migration
    ];

    // Data-oriented categories
    const dataCategories = [
      'dataSeeding', // Seeding initial data
    ];

    // Test categories that can be skipped
    const testCategories = [
      'specializedTesting', // Testing specific components
      'crossChainTesting', // Testing cross-chain functionality
      'computationalAndStorage', // Testing computational capabilities
      'weatherAndIoT', // Testing weather data and IoT integration
    ];

    // Determine which categories to start
    let categoriesToStart = [];

    if (specificCategories) {
      // If specific categories were requested, use those
      categoriesToStart = specificCategories;
    } else {
      // Otherwise, use the default sequence
      categoriesToStart = [...essentialCategories, ...dataCategories];

      // Add test categories if not skipping tests
      if (!skipTests) {
        categoriesToStart = [...categoriesToStart, ...testCategories];
      }
    }

    // Start each category in sequence
    for (const category of categoriesToStart) {
      console.log(`Starting category: ${category}`);
      await startGroup(category);
    }

    // Record end time
    metrics.startup.endTime = Date.now();
    metrics.startup.duration =
      metrics.startup.endTime - metrics.startup.startTime;

    // Calculate scheduler metrics
    calculateSchedulerMetrics();

    // Save metrics
    saveMetrics();

    return true;
  } catch (error) {
    console.error(`Initialization failed: ${error.message}`);

    // Record end time
    metrics.startup.endTime = Date.now();
    metrics.startup.duration =
      metrics.startup.endTime - metrics.startup.startTime;
    metrics.startup.error = error.message;

    // Save metrics even on failure
    saveMetrics();

    return false;
  }
}

/**
 * Save metrics to a file
 */
function saveMetrics() {
  try {
    // Create metrics directory if it doesn't exist
    const metricsDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(metricsDir)) {
      fs.mkdirSync(metricsDir, { recursive: true });
    }

    // Save metrics to a file
    const metricsFile = path.join(
      metricsDir,
      `startup-metrics-${Date.now()}.json`
    );
    fs.writeFileSync(metricsFile, JSON.stringify(metrics, null, 2));

    console.log(`Metrics saved to ${metricsFile}`);
  } catch (error) {
    console.error(`Failed to save metrics: ${error.message}`);
  }
}

// Export public API
module.exports = {
  componentGroups,
  componentState,
  componentEvents,
  metrics,
  scheduleComponent,
  startComponent,
  stopComponent,
  startGroup,
  getComponentStatus,
  initializeSystem,
};
