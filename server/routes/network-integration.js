/**
 * Network Integration API Routes for Wrfcoin
 * RESTful endpoints for all decentralized network operations
 */

const express = require('express');
const { randomBytes } = require('crypto');
const NetworkIntegrationManager = require('../network-integration-manager');
const { appLogger } = require('../utils/logger');

const router = express.Router();
const networkManager = new NetworkIntegrationManager();

// Initialize networks on server start
let networkInitialized = false;

async function ensureNetworksInitialized() {
  if (!networkInitialized) {
    try {
      await networkManager.initializeAllNetworks();
      networkInitialized = true;
      appLogger.info('Decentralized networks initialized successfully', { service: 'network-integration' });
    } catch (error) {
      appLogger.error('Network initialization error', { error: { message: error.message, stack: error.stack } });
    }
  }
}

// Network Status and Health
router.get('/status', async (req, res) => {
  try {
    await ensureNetworksInitialized();
    const stats = await networkManager.getNetworkStats();

    res.json({
      success: true,
      data: stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

router.get('/capabilities', async (req, res) => {
  try {
    await ensureNetworksInitialized();
    const capabilities = networkManager.getAvailableCapabilities();
    const connectedNetworks = networkManager.getConnectedNetworks();

    res.json({
      success: true,
      data: {
        capabilities,
        connectedNetworks,
        networkCount: connectedNetworks.length,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Weather Data Operations
router.post('/weather/store', async (req, res) => {
  try {
    await ensureNetworksInitialized();
    const { weatherData, options = {} } = req.body;

    if (!weatherData) {
      return res.status(400).json({
        success: false,
        error: 'Weather data is required',
        timestamp: new Date().toISOString(),
      });
    }

    const results = await networkManager.storeWeatherDataDistributed(
      weatherData,
      options
    );

    res.json({
      success: true,
      data: {
        storageResults: results,
        networksUsed: Object.keys(results),
        operationId: 'store_' + randomBytes(4).toString('hex'),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

router.post('/weather/process-ai', async (req, res) => {
  try {
    await ensureNetworksInitialized();
    const { weatherData, options = {} } = req.body;

    if (!weatherData) {
      return res.status(400).json({
        success: false,
        error: 'Weather data is required',
        timestamp: new Date().toISOString(),
      });
    }

    const results = await networkManager.processWeatherWithAI(
      weatherData,
      options
    );

    res.json({
      success: true,
      data: {
        aiResults: results,
        networksUsed: Object.keys(results),
        operationId: 'ai_' + randomBytes(4).toString('hex'),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Computing Operations
router.post('/compute/deploy', async (req, res) => {
  try {
    await ensureNetworksInitialized();
    const { workloadSpec, options = {} } = req.body;

    if (!workloadSpec) {
      return res.status(400).json({
        success: false,
        error: 'Workload specification is required',
        timestamp: new Date().toISOString(),
      });
    }

    const results = await networkManager.deployComputingWorkload(
      workloadSpec,
      options
    );

    res.json({
      success: true,
      data: {
        deploymentResults: results,
        networksUsed: Object.keys(results),
        operationId: 'deploy_' + randomBytes(4).toString('hex'),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// DApp Operations
router.post('/dapp/deploy', async (req, res) => {
  try {
    await ensureNetworksInitialized();
    const { dappConfig = {} } = req.body;

    const result = await networkManager.deployWeatherDApp(dappConfig);

    res.json({
      success: true,
      data: {
        dapp: result,
        operationId: 'dapp_' + randomBytes(4).toString('hex'),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Cross-Network Workflows
router.post('/workflow/execute', async (req, res) => {
  try {
    await ensureNetworksInitialized();
    const { workflowData } = req.body;

    if (!workflowData) {
      return res.status(400).json({
        success: false,
        error: 'Workflow data is required',
        timestamp: new Date().toISOString(),
      });
    }

    const workflow = await networkManager.executeDataWorkflow(workflowData);

    res.json({
      success: true,
      data: {
        workflow,
        stepsCompleted: workflow.steps.length,
        networksInvolved: workflow.steps.length,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Individual Network Operations
router.get('/arweave/stats', async (req, res) => {
  try {
    await ensureNetworksInitialized();
    if (!networkManager.isNetworkConnected('arweave')) {
      return res.status(503).json({
        success: false,
        error: 'Arweave network not connected',
        timestamp: new Date().toISOString(),
      });
    }

    const stats = await networkManager.networks.arweave.getStorageStats();

    res.json({
      success: true,
      data: stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

router.get('/bittensor/stats', async (req, res) => {
  try {
    await ensureNetworksInitialized();
    if (!networkManager.isNetworkConnected('bittensor')) {
      return res.status(503).json({
        success: false,
        error: 'Bittensor network not connected',
        timestamp: new Date().toISOString(),
      });
    }

    const stats = await networkManager.networks.bittensor.getNetworkStats();

    res.json({
      success: true,
      data: stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

router.get('/akash/stats', async (req, res) => {
  try {
    await ensureNetworksInitialized();
    if (!networkManager.isNetworkConnected('akash')) {
      return res.status(503).json({
        success: false,
        error: 'Akash network not connected',
        timestamp: new Date().toISOString(),
      });
    }

    const stats = await networkManager.networks.akash.getNetworkStats();

    res.json({
      success: true,
      data: stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Health Check Endpoint
router.get('/health', async (req, res) => {
  try {
    await ensureNetworksInitialized();
    await networkManager.performHealthCheck();

    const connectedNetworks = networkManager.getConnectedNetworks();
    const totalNetworks = Object.keys(networkManager.networks).length;
    const healthScore = (connectedNetworks.length / totalNetworks) * 100;

    res.json({
      success: true,
      data: {
        healthy: healthScore > 50,
        healthScore: Math.round(healthScore),
        connectedNetworks,
        totalNetworks,
        status:
          healthScore > 75
            ? 'excellent'
            : healthScore > 50
              ? 'good'
              : 'degraded',
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Error handling middleware
router.use((error, req, res, next) => {
  appLogger.error('Unhandled error in network-api', { error: { message: error.message, stack: error.stack } });
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
