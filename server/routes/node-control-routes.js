/**
 * Node Control API Routes
 *
 * These routes handle administrative operations for the node,
 * including starting/stopping services, updating configuration,
 * and managing node resources.
 *
 * These routes require strict authentication via the RPC middleware.
 */

const express = require('express');
const router = express.Router();
const { logger } = require('../utils/logger');
const { notWiredEnvelope } = require('../middleware/require-wired-storage');
const {
  verifyNodeControlAuth,
  nodeControlRateLimiter,
} = require('../middleware/rpcAuthMiddleware');
const config = require('../../config');

// ---------------------------------------------------------------------------
// In-memory circular log buffer (max 1000 entries) — replaces 501 stub (#414)
// ---------------------------------------------------------------------------
const LOG_BUFFER_MAX = 1000;
const logBuffer = [];
let logIdCounter = 0;

/** Simple hash: str -> 32-bit int */
function simpleHash(str) {
  return str.split('').reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, 0);
}

/** Push a log entry into the circular buffer. */
function pushLog(level, message, source = 'wrfcoin-node') {
  logIdCounter += 1;
  const entry = {
    id: logIdCounter,
    level,
    message,
    source,
    timestamp: new Date().toISOString(),
  };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_MAX) {
    logBuffer.shift(); // evict oldest entry
  }
}

// Apply rate limiting and authentication to all node control routes
router.use(nodeControlRateLimiter);
router.use(verifyNodeControlAuth);

/**
 * Get node status
 */
router.get('/status', async (req, res) => {
  try {
    // System information about the node
    const nodeInfo = {
      uptime: process.uptime(),
      hostname: require('os').hostname(),
      platform: process.platform,
      nodeVersion: process.version,
      cpuUsage: process.cpuUsage(),
      memoryUsage: process.memoryUsage(),
      network: config.network,
      servicesStatus: {
        apiServer: 'running',
        databaseConnection: 'active',
        webSocketServer: config.websocket?.enabled ? 'running' : 'disabled',
        mcpServer: true,
        oracleNetwork: true,
      },
      lastUpdated: new Date().toISOString(),
    };

    res.json(nodeInfo);
  } catch (error) {
    logger.error('Error getting node status', { error: error.message });
    res.status(500).json({
      error: true,
      message: 'Failed to retrieve node status',
      details: error.message,
    });
  }
});

/**
 * Update node configuration
 */
router.post('/config', async (req, res) => {
  try {
    const { key, value } = req.body;

    if (!key || value === undefined) {
      return res.status(400).json({
        error: true,
        message: 'Missing required parameters: key and value',
        code: 'MISSING_PARAMS',
      });
    }

    // Validate that this is a changeable setting
    const allowedSettings = [
      'websocket.enabled',
      'websocket.maxConnections',
      'logLevel',
      'apiRateLimits.standard',
      'apiRateLimits.sensitive',
      'cors.allowedOrigins',
      'mcpSettings.maxContextSize',
      'mcpSettings.timeoutMs',
    ];

    if (!allowedSettings.includes(key)) {
      return res.status(403).json({
        error: true,
        message: `Setting "${key}" cannot be modified at runtime`,
        code: 'INVALID_SETTING',
      });
    }

    // Handle nested settings like 'websocket.enabled'
    const updateNestedConfig = (obj, path, val) => {
      const parts = path.split('.');
      let current = obj;

      for (let i = 0; i < parts.length - 1; i++) {
        if (!current[parts[i]]) current[parts[i]] = {};
        current = current[parts[i]];
      }

      current[parts[parts.length - 1]] = val;
      return obj;
    };

    // Apply the update in memory
    updateNestedConfig(config, key, value);

    logger.info('Node configuration updated', {
      key,
      value,
      admin: req.ip,
    });

    res.json({
      success: true,
      message: `Configuration updated: ${key} = ${value}`,
      requiresRestart:
        key.startsWith('websocket') || key === 'cors.allowedOrigins',
    });
  } catch (error) {
    logger.error('Error updating node configuration', { error: error.message });
    res.status(500).json({
      error: true,
      message: 'Failed to update node configuration',
      details: error.message,
    });
  }
});

/**
 * Restart a specific service
 */
router.post('/restart/:service', async (req, res) => {
  try {
    const { service } = req.params;

    const allowedServices = ['websocket', 'mcp', 'api'];

    if (!allowedServices.includes(service)) {
      return res.status(400).json({
        error: true,
        message: `Invalid service: ${service}. Allowed services: ${allowedServices.join(', ')}`,
        code: 'INVALID_SERVICE',
      });
    }

    return res.status(501).json(
      notWiredEnvelope({
        capability: 'node-control.restart',
        message: 'Service restart is not wired: no supervisor integration exists',
        details: `Requested service: ${service}`,
        see: 'wrfcoin/backend#1177',
      }),
    );
  } catch (error) {
    logger.error(`Error restarting service: ${req.params.service}`, {
      error: error.message,
    });
    res.status(500).json({
      error: true,
      message: `Failed to restart service: ${req.params.service}`,
      details: error.message,
    });
  }
});

/**
 * Clear node cache
 */
router.post('/clear-cache', async (req, res) => {
  try {
    const { cacheType } = req.body;

    const validCacheTypes = [
      'all',
      'blockchain',
      'weather',
      'transactions',
      'validators',
    ];

    if (!cacheType || !validCacheTypes.includes(cacheType)) {
      return res.status(400).json({
        error: true,
        message: `Invalid cache type. Valid types: ${validCacheTypes.join(', ')}`,
        code: 'INVALID_CACHE_TYPE',
      });
    }

    return res.status(501).json(
      notWiredEnvelope({
        capability: 'node-control.clear-cache',
        message: 'Cache clearing is not wired: no cache supervisor integration exists',
        details: `Requested cache type: ${cacheType}`,
        see: 'wrfcoin/backend#1177',
      }),
    );
  } catch (error) {
    logger.error('Error clearing node cache', { error: error.message });
    res.status(500).json({
      error: true,
      message: 'Failed to clear node cache',
      details: error.message,
    });
  }
});

/**
 * Get node logs
 *
 * Returns entries from the in-memory circular log buffer.
 * Query params:
 *   ?level=info|warn|error|debug  — filter by log level
 *   ?limit=N                      — number of entries (default 100, max 1000)
 *
 * Logs are returned in reverse chronological order (newest first).
 */
router.get('/logs', async (req, res) => {
  try {
    const { level, limit: rawLimit } = req.query;

    const validLevels = ['error', 'warn', 'info', 'debug'];

    if (level && !validLevels.includes(level)) {
      return res.status(400).json({
        error: true,
        message: `Invalid log level. Valid levels: ${validLevels.join(', ')}`,
        code: 'INVALID_LOG_LEVEL',
      });
    }

    const limit = Math.min(Math.max(parseInt(rawLimit, 10) || 100, 1), LOG_BUFFER_MAX);

    // Filter by level if provided, otherwise return all levels
    const filtered = level
      ? logBuffer.filter((entry) => entry.level === level)
      : [...logBuffer];

    // Reverse chronological order, then apply limit
    const logs = filtered.slice().reverse().slice(0, limit);

    return res.json({
      success: true,
      data: {
        logs,
        total: logBuffer.length,
        filtered: filtered.length,
        source: 'process-buffer',
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error retrieving node logs', { error: error.message });
    res.status(500).json({
      error: true,
      message: 'Failed to retrieve node logs',
      details: error.message,
    });
  }
});

router.pushLog = pushLog;

module.exports = router;
