/**
 * Network Integration Manager for Wrfcoin
 * Centralized management of all decentralized network connections
 */

const ArweaveAdapter = require('./integrations/arweave-adapter');
const AkashAdapter = require('./integrations/akash-adapter');
const BittensorAdapter = require('./integrations/bittensor-adapter');
const FilecoinAdapter = require('./integrations/filecoin-adapter');
const GolemAdapter = require('./integrations/golem-adapter');
const ICPAdapter = require('./integrations/icp-adapter');
const { blockchainLogger } = require('./utils/logger.js');

class NetworkIntegrationManager {
  constructor() {
    this.networks = {
      arweave: new ArweaveAdapter(),
      akash: new AkashAdapter(),
      bittensor: new BittensorAdapter(),
      filecoin: new FilecoinAdapter(),
      golem: new GolemAdapter(),
      icp: new ICPAdapter(),
    };

    this.connectionStatus = {};
    this.stats = {
      totalConnections: 0,
      activeNetworks: 0,
      lastHealthCheck: null,
    };

    this.healthCheckInterval = null;
    blockchainLogger.info('Network Integration Manager initialized', { module: 'NetworkIntegrationManager' });
  }

  async initializeAllNetworks() {
    blockchainLogger.info('Initializing all decentralized networks', { module: 'NetworkIntegrationManager' });

    const connectionPromises = Object.entries(this.networks).map(
      async ([name, adapter]) => {
        try {
          blockchainLogger.info(`Connecting to ${name.toUpperCase()}`, { module: 'NetworkIntegrationManager', network: name });
          const connected = await adapter.connect();

          this.connectionStatus[name] = {
            connected,
            lastChecked: new Date().toISOString(),
            error: null,
          };

          if (connected) {
            this.stats.activeNetworks++;
            blockchainLogger.info(`${name.toUpperCase()} connected successfully`, { module: 'NetworkIntegrationManager', network: name, status: 'connected' });
          } else {
            blockchainLogger.warn(`${name.toUpperCase()} connection failed`, { module: 'NetworkIntegrationManager', network: name, status: 'failed' });
          }

          this.stats.totalConnections++;
          return { name, connected };
        } catch (error) {
          blockchainLogger.error(`${name.toUpperCase()} error`, { module: 'NetworkIntegrationManager', network: name, error: error.message });
          this.connectionStatus[name] = {
            connected: false,
            lastChecked: new Date().toISOString(),
            error: error.message,
          };
          return { name, connected: false, error: error.message };
        }
      }
    );

    const results = await Promise.all(connectionPromises);
    this.stats.lastHealthCheck = new Date().toISOString();

    blockchainLogger.info('Network initialization complete', { module: 'NetworkIntegrationManager', activeNetworks: this.stats.activeNetworks, totalConnections: this.stats.totalConnections });

    // Start health checking
    this.startHealthChecking();

    return results;
  }

  // Weather Data Operations
  async storeWeatherDataDistributed(weatherData, options = {}) {
    const results = {};

    try {
      // Store in Arweave for permanent storage
      if (this.connectionStatus.arweave?.connected) {
        results.arweave = await this.networks.arweave.storeWeatherData(
          weatherData,
          {
            type: 'weather_archive',
            source: 'wrfcoin_network',
            ...options,
          }
        );
        blockchainLogger.info('Weather data stored in Arweave', { module: 'NetworkIntegrationManager', network: 'arweave', transactionId: results.arweave.txId });
      }

      // Store in Filecoin for long-term archiving
      if (this.connectionStatus.filecoin?.connected) {
        results.filecoin = await this.networks.filecoin.storeWeatherArchive(
          weatherData,
          {
            duration: options.duration || '1 year',
            redundancy: options.redundancy || 3,
          }
        );
        blockchainLogger.info('Weather data archived in Filecoin', { module: 'NetworkIntegrationManager', network: 'filecoin', archiveId: results.filecoin.id });
      }

      return results;
    } catch (error) {
      blockchainLogger.error('Distributed storage error', { module: 'NetworkIntegrationManager', error: error.message });
      throw error;
    }
  }

  // AI/ML Processing Operations
  async processWeatherWithAI(weatherData, options = {}) {
    const results = {};

    try {
      // Deploy and run prediction on Bittensor
      if (this.connectionStatus.bittensor?.connected) {
        const model =
          await this.networks.bittensor.deployWeatherPredictionModel({
            type: 'lstm_weather_forecast',
            accuracy_target: options.accuracy || 0.92,
            prediction_horizon: options.horizon || '7 days',
          });

        results.bittensor = await this.networks.bittensor.runClimateInference(
          model.id,
          weatherData
        );
        blockchainLogger.info('AI prediction completed on Bittensor', { module: 'NetworkIntegrationManager', network: 'bittensor', inferenceId: results.bittensor.inferenceId });
      }

      return results;
    } catch (error) {
      blockchainLogger.error('AI processing error', { module: 'NetworkIntegrationManager', error: error.message });
      throw error;
    }
  }

  // Distributed Computing Operations
  async deployComputingWorkload(workloadSpec, options = {}) {
    const results = {};

    try {
      // Deploy on Akash Network
      if (this.connectionStatus.akash?.connected) {
        results.akash = await this.networks.akash.deployWeatherProcessor({
          image: workloadSpec.image || 'wrfcoin/climate-processor:latest',
          resources: workloadSpec.resources,
        });
        blockchainLogger.info('Workload deployed on Akash', { module: 'NetworkIntegrationManager', network: 'akash', deploymentId: results.akash.id });
      }

      // Deploy on Golem Network
      if (this.connectionStatus.golem?.connected) {
        results.golem = await this.networks.golem.deployClimateModel({
          algorithm: workloadSpec.algorithm || 'ensemble_weather_prediction',
          ...workloadSpec.requirements,
        });
        blockchainLogger.info('Task deployed on Golem', { module: 'NetworkIntegrationManager', network: 'golem', taskId: results.golem.id });
      }

      return results;
    } catch (error) {
      blockchainLogger.error('Computing deployment error', { module: 'NetworkIntegrationManager', error: error.message });
      throw error;
    }
  }

  // Web Application Operations
  async deployWeatherDApp(dappConfig) {
    try {
      if (this.connectionStatus.icp?.connected) {
        const dapp = await this.networks.icp.deployWeatherDApp({
          name: dappConfig.name || 'Wrfcoin Weather Analytics',
          features: dappConfig.features || [
            'real-time-data',
            'historical-analysis',
            'prediction-models',
          ],
        });

        blockchainLogger.info('Weather DApp deployed on ICP', { module: 'NetworkIntegrationManager', network: 'icp', dappId: dapp.id });
        return dapp;
      } else {
        throw new Error('Internet Computer not connected');
      }
    } catch (error) {
      blockchainLogger.error('DApp deployment error', { module: 'NetworkIntegrationManager', error: error.message });
      throw error;
    }
  }

  // Cross-Network Data Flow
  async executeDataWorkflow(workflowData) {
    blockchainLogger.info('Executing cross-network data workflow', { module: 'NetworkIntegrationManager' });
    const workflow = {
      id: 'workflow_' + Math.random().toString(36).substr(2, 8),
      steps: [],
      results: {},
    };

    try {
      // Step 1: Process data with distributed computing
      if (this.connectionStatus.golem?.connected) {
        const processing = await this.networks.golem.processWeatherData(
          'workflow_task',
          workflowData
        );
        workflow.steps.push('golem_processing');
        workflow.results.processing = processing;
        blockchainLogger.info('Step 1: Data processed on Golem', { module: 'NetworkIntegrationManager', workflowId: workflow.id, step: 1 });
      }

      // Step 2: Store results permanently
      if (
        this.connectionStatus.arweave?.connected &&
        workflow.results.processing
      ) {
        const storage = await this.networks.arweave.storeComputationalResult(
          workflow.results.processing.jobId,
          workflow.results.processing.results,
          'proof_of_computation'
        );
        workflow.steps.push('arweave_storage');
        workflow.results.storage = storage;
        blockchainLogger.info('Step 2: Results stored on Arweave', { module: 'NetworkIntegrationManager', workflowId: workflow.id, step: 2 });
      }

      // Step 3: Make data queryable via DApp
      if (this.connectionStatus.icp?.connected) {
        const query = await this.networks.icp.queryWeatherData(
          'workflow_canister',
          {
            workflowId: workflow.id,
            dataType: 'processed_results',
          }
        );
        workflow.steps.push('icp_query');
        workflow.results.query = query;
        blockchainLogger.info('Step 3: Data made queryable on ICP', { module: 'NetworkIntegrationManager', workflowId: workflow.id, step: 3 });
      }

      workflow.completedAt = new Date().toISOString();
      blockchainLogger.info('Cross-network workflow completed', { module: 'NetworkIntegrationManager', workflowId: workflow.id });

      return workflow;
    } catch (error) {
      blockchainLogger.error('Workflow execution error', { module: 'NetworkIntegrationManager', error: error.message });
      throw error;
    }
  }

  // Network Health and Status
  async getNetworkStats() {
    const networkStats = {};

    for (const [name, adapter] of Object.entries(this.networks)) {
      try {
        if (this.connectionStatus[name]?.connected) {
          networkStats[name] = await adapter.getNetworkStats();
        } else {
          networkStats[name] = {
            isConnected: false,
            error: this.connectionStatus[name]?.error || 'Not connected',
          };
        }
      } catch (error) {
        networkStats[name] = {
          isConnected: false,
          error: error.message,
        };
      }
    }

    return {
      manager: this.stats,
      networks: networkStats,
      summary: {
        totalNetworks: Object.keys(this.networks).length,
        connectedNetworks: this.stats.activeNetworks,
        healthStatus: this.stats.activeNetworks > 3 ? 'healthy' : 'degraded',
      },
    };
  }

  startHealthChecking() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(async () => {
      await this.performHealthCheck();
    }, 60000); // Check every minute

    blockchainLogger.info('Health checking started', { module: 'NetworkIntegrationManager', intervalMs: 60000 });
  }

  async performHealthCheck() {
    try {
      let activeCount = 0;

      for (const [name, adapter] of Object.entries(this.networks)) {
        try {
          const stats = await adapter.getNetworkStats();
          if (stats.isConnected) {
            activeCount++;
            this.connectionStatus[name].connected = true;
            this.connectionStatus[name].error = null;
          }
        } catch (error) {
          this.connectionStatus[name].connected = false;
          this.connectionStatus[name].error = error.message;
        }

        this.connectionStatus[name].lastChecked = new Date().toISOString();
      }

      this.stats.activeNetworks = activeCount;
      this.stats.lastHealthCheck = new Date().toISOString();
    } catch (error) {
      blockchainLogger.error('Health check error', { module: 'NetworkIntegrationManager', error: error.message });
    }
  }

  async shutdown() {
    blockchainLogger.info('Shutting down all network connections', { module: 'NetworkIntegrationManager' });

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    const disconnectPromises = Object.entries(this.networks).map(
      async ([name, adapter]) => {
        try {
          await adapter.disconnect();
          blockchainLogger.info(`${name.toUpperCase()} disconnected`, { module: 'NetworkIntegrationManager', network: name, status: 'disconnected' });
        } catch (error) {
          blockchainLogger.error(`${name.toUpperCase()} disconnect error`, { module: 'NetworkIntegrationManager', network: name, error: error.message });
        }
      }
    );

    await Promise.all(disconnectPromises);
    blockchainLogger.info('All networks disconnected', { module: 'NetworkIntegrationManager' });
  }

  // Utility methods
  isNetworkConnected(networkName) {
    return this.connectionStatus[networkName]?.connected || false;
  }

  getConnectedNetworks() {
    return Object.entries(this.connectionStatus)
      .filter(([, status]) => status.connected)
      .map(([name]) => name);
  }

  getAvailableCapabilities() {
    const capabilities = [];

    if (this.isNetworkConnected('arweave'))
      capabilities.push('permanent_storage');
    if (this.isNetworkConnected('filecoin'))
      capabilities.push('long_term_archiving');
    if (this.isNetworkConnected('akash')) capabilities.push('cloud_computing');
    if (this.isNetworkConnected('golem'))
      capabilities.push('distributed_computing');
    if (this.isNetworkConnected('bittensor'))
      capabilities.push('ai_ml_processing');
    if (this.isNetworkConnected('icp'))
      capabilities.push('decentralized_applications');

    return capabilities;
  }
}

module.exports = NetworkIntegrationManager;
