/**
 * TatauCloud API Routes for Wrfcoin
 *
 * This file defines the API endpoints for the TatauCloud integration,
 * allowing the frontend to interact with TatauCloud services.
 */

const express = require('express');
const router = express.Router();
const { logger } = require('../utils/logger');
const TatauCloudController = require('../integrations/tataucloud/controller');

// Create logger instance
const routeLogger = logger.child({ module: 'routes:tataucloud' });

// Initialize controller
const tatauCloudController = new TatauCloudController();

// Initialize the controller when the routes are loaded
(async () => {
  try {
    await tatauCloudController.initialize();
    routeLogger.info('TatauCloud controller initialized successfully');
  } catch (error) {
    routeLogger.error('Failed to initialize TatauCloud controller', { error });
  }
})();

/**
 * @route GET /api/tataucloud/status
 * @description Get TatauCloud network status
 * @access Public
 */
router.get('/status', async (req, res) => {
  try {
    const status = await tatauCloudController.getNetworkStatus();
    res.json(status);
  } catch (error) {
    routeLogger.error('Error fetching TatauCloud status', { error });
    res.status(500).json({ error: 'Failed to fetch TatauCloud status' });
  }
});

/**
 * @route GET /api/tataucloud/nodes
 * @description Get available TatauCloud compute nodes
 * @access Public
 */
router.get('/nodes', async (req, res) => {
  try {
    const filters = req.query || {};
    const nodes = await tatauCloudController.getAvailableNodes(filters);
    res.json(nodes);
  } catch (error) {
    routeLogger.error('Error fetching TatauCloud nodes', { error });
    res.status(500).json({ error: 'Failed to fetch TatauCloud nodes' });
  }
});

/**
 * @route GET /api/tataucloud/models
 * @description Get available TatauCloud AI/ML models
 * @access Public
 */
router.get('/models', async (req, res) => {
  try {
    const filters = req.query || {};
    const models = await tatauCloudController.getAvailableModels(filters);
    res.json(models);
  } catch (error) {
    routeLogger.error('Error fetching TatauCloud models', { error });
    res.status(500).json({ error: 'Failed to fetch TatauCloud models' });
  }
});

/**
 * @route POST /api/tataucloud/cost-estimate
 * @description Get cost estimate for a computation job
 * @access Public
 */
router.post('/cost-estimate', async (req, res) => {
  try {
    const params = req.body;
    if (!params) {
      return res.status(400).json({ error: 'Job parameters are required' });
    }

    const estimate = await tatauCloudController.getCostEstimate(params);
    res.json(estimate);
  } catch (error) {
    routeLogger.error('Error getting cost estimate', { error });
    res.status(500).json({ error: 'Failed to get cost estimate' });
  }
});

/**
 * @route POST /api/tataucloud/forecast
 * @description Run a weather forecast job
 * @access Public
 */
router.post('/forecast', async (req, res) => {
  try {
    const params = req.body;
    if (!params) {
      return res
        .status(400)
        .json({ error: 'Forecast parameters are required' });
    }

    const job = await tatauCloudController.runWeatherForecast(params);
    res.json(job);
  } catch (error) {
    routeLogger.error('Error running weather forecast', { error });
    res.status(500).json({ error: 'Failed to run weather forecast' });
  }
});

/**
 * @route POST /api/tataucloud/train-model
 * @description Train a custom weather model
 * @access Public
 */
router.post('/train-model', async (req, res) => {
  try {
    const params = req.body;
    if (!params) {
      return res
        .status(400)
        .json({ error: 'Training parameters are required' });
    }

    const job = await tatauCloudController.trainCustomWeatherModel(params);
    res.json(job);
  } catch (error) {
    routeLogger.error('Error training custom model', { error });
    res.status(500).json({ error: 'Failed to train custom model' });
  }
});

/**
 * @route GET /api/tataucloud/job/:jobId
 * @description Get the status of a specific job
 * @access Public
 */
router.get('/job/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!jobId) {
      return res.status(400).json({ error: 'Job ID is required' });
    }

    const status = await tatauCloudController.getJobStatus(jobId);
    res.json(status);
  } catch (error) {
    routeLogger.error('Error getting job status', { error });
    res.status(500).json({ error: 'Failed to get job status' });
  }
});

/**
 * @route GET /api/tataucloud/job/:jobId/results
 * @description Get the results of a completed job
 * @access Public
 */
router.get('/job/:jobId/results', async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!jobId) {
      return res.status(400).json({ error: 'Job ID is required' });
    }

    const results = await tatauCloudController.getJobResults(jobId);
    res.json(results);
  } catch (error) {
    routeLogger.error('Error getting job results', { error });
    res.status(500).json({ error: 'Failed to get job results' });
  }
});

module.exports = router;
