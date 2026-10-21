/**
 * Integrations API Routes
 *
 * This module defines the API routes for external integrations,
 * including Chainlink, Bittensor, and others.
 */

const express = require('express');
const router = express.Router();
const { ChainlinkService } = require('../chainlink');
const logger = require('../utils/logger');
const { createApiError } = require('../utils/api-error');

// Utility function to safely extract error message from unknown error type
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as any).message);
  }
  return 'Unknown error occurred';
}

// Initialize Chainlink service
const chainlinkService = new ChainlinkService('testnet');

// Chainlink endpoints

/**
 * GET /api/integrations/chainlink/status
 * Get the status of all Chainlink services
 */
router.get('/chainlink/status', async (req, res) => {
  try {
    const health = await chainlinkService.checkHealth();
    const feeds = await chainlinkService.getAvailableFeeds();

    res.json({
      success: true,
      status: health.status,
      availableFeeds: feeds,
    });
  } catch (error) {
    logger.error(
      `Error getting Chainlink status: ${getErrorMessage(error)}`,
      error
    );
    res.status(500).json(
      createApiError('CHAINLINK_STATUS_FAILED', 'Failed to get Chainlink service status'),
    );
  }
});

/**
 * GET /api/integrations/chainlink/data-feeds
 * Get all available data feeds
 */
router.get('/chainlink/data-feeds', async (req, res) => {
  try {
    const feeds = await chainlinkService.getAvailableFeeds();
    res.json({
      success: true,
      feeds,
    });
  } catch (error) {
    logger.error(`Error getting data feeds: ${getErrorMessage(error)}`, error);
    res.status(500).json(
      createApiError('CHAINLINK_DATA_FEEDS_FAILED', 'Failed to get data feeds'),
    );
  }
});

/**
 * GET /api/integrations/chainlink/data-feeds/:feedId/latest
 * Get the latest price from a specific data feed
 */
router.get('/chainlink/data-feeds/:feedId/latest', async (req, res) => {
  const { feedId } = req.params;

  try {
    const priceData = await chainlinkService.dataFeeds.getLatestPrice(feedId);
    res.json({
      success: true,
      data: priceData,
    });
  } catch (error) {
    logger.error(
      `Error getting price for ${feedId}: ${getErrorMessage(error)}`,
      error
    );
    res.status(500).json(
      createApiError('CHAINLINK_PRICE_FAILED', `Failed to get price for ${feedId}`),
    );
  }
});

/**
 * POST /api/integrations/chainlink/vrf/request
 * Request a random number from the VRF service
 */
router.post('/chainlink/vrf/request', async (req, res) => {
  try {
    const { numWords, min, max } = req.body;
    let requestId;

    // Store the promise to await it
    const requestPromise = new Promise((resolve, reject) => {
      if (min !== undefined && max !== undefined) {
        // Request a random number in a range
        requestId = chainlinkService.vrf.requestRandomNumberInRange(
          min,
          max,
          (err, result) => {
            if (err) reject(err);
            else resolve(result);
          }
        );
      } else if (Array.isArray(req.body.requests)) {
        // Request multiple numbers with different ranges
        requestId = chainlinkService.vrf.requestMultipleRandomNumbers(
          req.body.requests,
          (err, result) => {
            if (err) reject(err);
            else resolve(result);
          }
        );
      } else {
        // Request standard random number(s)
        requestId = chainlinkService.vrf.requestRandomness(
          numWords || 1,
          (err, result) => {
            if (err) reject(err);
            else resolve(result);
          }
        );
      }
    });

    // Start the request but don't wait for it to complete
    res.json({
      success: true,
      requestId,
      message: 'Random number request initiated',
    });

    // Process the request in the background
    requestPromise.catch(error => {
      logger.error(
        `Error processing VRF request ${requestId}: ${getErrorMessage(error)}`,
        error
      );
    });
  } catch (error) {
    logger.error(
      `Error initiating VRF request: ${getErrorMessage(error)}`,
      error
    );
    res.status(500).json(
      createApiError('VRF_REQUEST_FAILED', 'Failed to initiate random number request'),
    );
  }
});

/**
 * GET /api/integrations/chainlink/vrf/requests/:requestId
 * Get the status of a VRF request
 */
router.get('/chainlink/vrf/requests/:requestId', async (req, res) => {
  const { requestId } = req.params;

  try {
    const status = await chainlinkService.vrf.getRequestStatus(requestId);
    res.json({
      success: true,
      status,
    });
  } catch (error) {
    logger.error(
      `Error getting VRF request status for ${requestId}: ${getErrorMessage(error)}`,
      error
    );
    res.status(500).json(
      createApiError('VRF_STATUS_FAILED', `Failed to get request status for ${requestId}`),
    );
  }
});

/**
 * POST /api/integrations/chainlink/automation/register
 * Register a new upkeep with the Automation service
 */
router.post('/chainlink/automation/register', async (req, res) => {
  try {
    const result = await chainlinkService.automation.registerUpkeep(req.body);
    res.json({
      success: true,
      upkeep: result.upkeep,
    });
  } catch (error) {
    logger.error(`Error registering upkeep: ${getErrorMessage(error)}`, error);
    res.status(500).json(
      createApiError('AUTOMATION_REGISTER_FAILED', 'Failed to register upkeep'),
    );
  }
});

/**
 * GET /api/integrations/chainlink/automation/upkeeps
 * List all registered upkeeps
 */
router.get('/chainlink/automation/upkeeps', async (req, res) => {
  try {
    const result = await chainlinkService.automation.listUpkeeps();
    res.json({
      success: true,
      upkeeps: result.upkeeps,
    });
  } catch (error) {
    logger.error(`Error listing upkeeps: ${getErrorMessage(error)}`, error);
    res.status(500).json(
      createApiError('AUTOMATION_LIST_FAILED', 'Failed to list upkeeps'),
    );
  }
});

/**
 * GET /api/integrations/chainlink/automation/upkeeps/:upkeepId
 * Get details about a registered upkeep
 */
router.get('/chainlink/automation/upkeeps/:upkeepId', async (req, res) => {
  const { upkeepId } = req.params;

  try {
    const result = await chainlinkService.automation.getUpkeep(upkeepId);
    res.json({
      success: true,
      upkeep: result.upkeep,
    });
  } catch (error) {
    logger.error(
      `Error getting upkeep ${upkeepId}: ${getErrorMessage(error)}`,
      error
    );
    res.status(500).json(
      createApiError('AUTOMATION_GET_FAILED', `Failed to get upkeep ${upkeepId}`),
    );
  }
});

/**
 * POST /api/integrations/chainlink/automation/upkeeps/:upkeepId/pause
 * Pause an upkeep
 */
router.post(
  '/chainlink/automation/upkeeps/:upkeepId/pause',
  async (req, res) => {
    const { upkeepId } = req.params;

    try {
      const result = await chainlinkService.automation.pauseUpkeep(upkeepId);
      res.json({
        success: true,
        upkeep: result.upkeep,
      });
    } catch (error) {
      logger.error(
        `Error pausing upkeep ${upkeepId}: ${getErrorMessage(error)}`,
        error
      );
      res.status(500).json(
        createApiError('AUTOMATION_PAUSE_FAILED', `Failed to pause upkeep ${upkeepId}`),
      );
    }
  }
);

/**
 * POST /api/integrations/chainlink/automation/upkeeps/:upkeepId/resume
 * Resume a paused upkeep
 */
router.post(
  '/chainlink/automation/upkeeps/:upkeepId/resume',
  async (req, res) => {
    const { upkeepId } = req.params;

    try {
      const result = await chainlinkService.automation.resumeUpkeep(upkeepId);
      res.json({
        success: true,
        upkeep: result.upkeep,
      });
    } catch (error) {
      logger.error(
        `Error resuming upkeep ${upkeepId}: ${getErrorMessage(error)}`,
        error
      );
      res.status(500).json(
        createApiError('AUTOMATION_RESUME_FAILED', `Failed to resume upkeep ${upkeepId}`),
      );
    }
  }
);

/**
 * POST /api/integrations/chainlink/automation/upkeeps/:upkeepId/cancel
 * Cancel an upkeep
 */
router.post(
  '/chainlink/automation/upkeeps/:upkeepId/cancel',
  async (req, res) => {
    const { upkeepId } = req.params;

    try {
      const result = await chainlinkService.automation.cancelUpkeep(upkeepId);
      res.json({
        success: true,
        upkeep: result.upkeep,
        withdrawnAmount: result.withdrawnAmount,
      });
    } catch (error) {
      logger.error(
        `Error cancelling upkeep ${upkeepId}: ${getErrorMessage(error)}`,
        error
      );
      res.status(500).json(
        createApiError('AUTOMATION_CANCEL_FAILED', `Failed to cancel upkeep ${upkeepId}`),
      );
    }
  }
);

// Placeholder for future integrations

/**
 * GET /api/integrations/bittensor/status
 * Get the status of Bittensor integration
 */
router.get('/bittensor/status', (req, res) => {
  res.json({
    success: true,
    status: 'pending',
    message: 'Bittensor integration is in development',
  });
});

export default router;
