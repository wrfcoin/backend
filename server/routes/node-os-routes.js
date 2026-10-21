/**
 * Node OS API Routes
 * Provides REST endpoints for Node OS functionality
 */

const express = require('express');
const router = express.Router();
const NodeOSCore = require('../../src/node_os/node_os_core');
const { appLogger } = require('../utils/logger');
const { createApiError } = require('../utils/api-error');
const {
  verifyNodeControlAuth,
  nodeControlRateLimiter,
} = require('../middleware/rpcAuthMiddleware');

// Initialize Node OS Core instance
const nodeOS = new NodeOSCore();
let nodeOSInitialized = false;

// Initialize Node OS on first request
async function ensureNodeOSInitialized() {
  if (!nodeOSInitialized) {
    const result = await nodeOS.initialize();
    if (result.success) {
      nodeOSInitialized = true;
    } else {
      throw new Error(`Failed to initialize Node OS: ${result.error}`);
    }
  }
  return nodeOS;
}

// Security: All node-OS endpoints require node control authentication (#484)
router.use(nodeControlRateLimiter);
router.use(verifyNodeControlAuth);

// System Status Endpoints
router.get('/status', async (req, res) => {
  try {
    await ensureNodeOSInitialized();
    const status = nodeOS.getSystemStatus();
    res.json({
      success: true,
      data: status,
      timestamp: Date.now(),
    });
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

router.get('/status/detailed', async (req, res) => {
  try {
    await ensureNodeOSInitialized();
    const report = nodeOS.getDetailedReport();
    res.json({
      success: true,
      data: report,
      timestamp: Date.now(),
    });
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

// Configuration Management Endpoints
router.get('/config', async (req, res) => {
  try {
    await ensureNodeOSInitialized();
    const { config, key } = req.query;

    if (!config) {
      return res.status(400).json(createApiError('MISSING_CONFIG_NAME', 'Configuration name required'));
    }

    const value = nodeOS.getConfig(config, key);
    res.json({
      success: true,
      data: { config, key, value },
      timestamp: Date.now(),
    });
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

router.put('/config', async (req, res) => {
  try {
    await ensureNodeOSInitialized();
    const { config, key, value } = req.body;

    if (!config || !key || value === undefined) {
      return res.status(400).json(createApiError('MISSING_CONFIG_PARAMS', 'Configuration name, key, and value required'));
    }

    const result = await nodeOS.setConfig(config, key, value);
    res.json({
      success: result.success,
      message: result.message,
      error: result.error,
      timestamp: Date.now(),
    });
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

router.post('/config/profile/:profileName', async (req, res) => {
  try {
    await ensureNodeOSInitialized();
    const { profileName } = req.params;

    const result = await nodeOS.applyProfile(profileName);
    res.json({
      success: result.success,
      data: result,
      timestamp: Date.now(),
    });
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

// Plugin Management Endpoints
router.get('/plugins', async (req, res) => {
  try {
    await ensureNodeOSInitialized();
    const status = nodeOS.pluginManager.getStatus();
    res.json({
      success: true,
      data: status,
      timestamp: Date.now(),
    });
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

router.post('/plugins/:pluginName/install', async (req, res) => {
  try {
    await ensureNodeOSInitialized();
    const { pluginName } = req.params;
    const options = req.body || {};

    const result = await nodeOS.installPlugin(pluginName, options);
    res.json({
      success: result.success,
      message: result.message,
      error: result.error,
      timestamp: Date.now(),
    });
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

router.post('/plugins/:pluginName/activate', async (req, res) => {
  try {
    await ensureNodeOSInitialized();
    const { pluginName } = req.params;

    const result = await nodeOS.activatePlugin(pluginName);
    res.json({
      success: result.success,
      message: result.message,
      error: result.error,
      timestamp: Date.now(),
    });
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

router.post('/plugins/:pluginName/deactivate', async (req, res) => {
  try {
    await ensureNodeOSInitialized();
    const { pluginName } = req.params;

    const result = await nodeOS.deactivatePlugin(pluginName);
    res.json({
      success: result.success,
      message: result.message,
      error: result.error,
      timestamp: Date.now(),
    });
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

// Workload Management Endpoints
router.get('/jobs', async (req, res) => {
  try {
    await ensureNodeOSInitialized();
    const status = nodeOS.workloadManager.getStatus();
    res.json({
      success: true,
      data: status,
      timestamp: Date.now(),
    });
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

router.post('/jobs', async (req, res) => {
  try {
    await ensureNodeOSInitialized();
    const jobDefinition = req.body;

    const result = await nodeOS.submitJob(jobDefinition);
    res.json({
      success: result.success,
      data: { jobId: result.jobId },
      message: result.message,
      error: result.error,
      timestamp: Date.now(),
    });
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

router.get('/jobs/:jobId', async (req, res) => {
  try {
    await ensureNodeOSInitialized();
    const { jobId } = req.params;

    const job = nodeOS.getJobStatus(jobId);
    if (!job) {
      return res.status(404).json(createApiError('JOB_NOT_FOUND', 'Job not found'));
    }

    res.json({
      success: true,
      data: job,
      timestamp: Date.now(),
    });
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

router.delete('/jobs/:jobId', async (req, res) => {
  try {
    await ensureNodeOSInitialized();
    const { jobId } = req.params;

    const result = await nodeOS.cancelJob(jobId);
    res.json({
      success: result.success,
      message: result.message,
      error: result.error,
      timestamp: Date.now(),
    });
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

// Health Monitoring Endpoints
router.get('/health', async (req, res) => {
  try {
    await ensureNodeOSInitialized();
    const healthSummary = nodeOS.healthMonitor.getHealthSummary();
    res.json({
      success: true,
      data: healthSummary,
      timestamp: Date.now(),
    });
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

router.get('/health/detailed', async (req, res) => {
  try {
    await ensureNodeOSInitialized();
    const healthReport = nodeOS.healthMonitor.getDetailedReport();
    res.json({
      success: true,
      data: healthReport,
      timestamp: Date.now(),
    });
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

router.post('/health/checks/:checkId', async (req, res) => {
  try {
    await ensureNodeOSInitialized();
    const { checkId } = req.params;

    const result = await nodeOS.healthMonitor.runCheck(checkId);
    res.json({
      success: true,
      data: result,
      timestamp: Date.now(),
    });
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

// System Maintenance Endpoints
router.post('/maintenance', async (req, res) => {
  try {
    await ensureNodeOSInitialized();
    const results = await nodeOS.performMaintenance();
    res.json({
      success: true,
      data: results,
      timestamp: Date.now(),
    });
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

// Resource Management Endpoints
router.get('/resources', async (req, res) => {
  try {
    await ensureNodeOSInitialized();
    const status = nodeOS.getSystemStatus();
    res.json({
      success: true,
      data: {
        resources: status.resources,
        workloads: status.components.workload_manager,
      },
      timestamp: Date.now(),
    });
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

// Backup Management Endpoints
router.get('/backups', async (req, res) => {
  try {
    await ensureNodeOSInitialized();
    const backups = await nodeOS.backupManager.listBackups();
    res.json({
      success: true,
      data: backups,
      timestamp: Date.now(),
    });
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

router.post('/backups/create', async (req, res) => {
  try {
    await ensureNodeOSInitialized();
    const options = req.body || {};
    const result = await nodeOS.backupManager.createSystemBackup(options);
    res.json({
      success: result.success,
      data: { backupId: result.backupId },
      message: result.message,
      error: result.error,
      timestamp: Date.now(),
    });
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

router.post('/backups/:backupId/restore', async (req, res) => {
  try {
    await ensureNodeOSInitialized();
    const { backupId } = req.params;
    const options = req.body || {};

    const result = await nodeOS.backupManager.restoreFromBackup(
      backupId,
      options
    );
    res.json({
      success: result.success,
      message: result.message,
      error: result.error,
      timestamp: Date.now(),
    });
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

router.delete('/backups/:backupId', async (req, res) => {
  try {
    await ensureNodeOSInitialized();
    const { backupId } = req.params;

    const result = await nodeOS.backupManager.deleteBackup(backupId);
    res.json({
      success: result.success,
      message: result.message,
      error: result.error,
      timestamp: Date.now(),
    });
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

// Security Management Endpoints
router.get('/security/status', async (req, res) => {
  try {
    await ensureNodeOSInitialized();
    const status = nodeOS.securityManager.getSecurityStatus();
    res.json({
      success: true,
      data: status,
      timestamp: Date.now(),
    });
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

router.get('/security/events', async (req, res) => {
  try {
    await ensureNodeOSInitialized();
    const limit = parseInt(req.query.limit) || 100;
    const events = nodeOS.securityManager.getSecurityEvents(limit);
    res.json({
      success: true,
      data: events,
      timestamp: Date.now(),
    });
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

router.get('/security/access-logs', async (req, res) => {
  try {
    await ensureNodeOSInitialized();
    const limit = parseInt(req.query.limit) || 100;
    const logs = nodeOS.securityManager.getAccessLogs(limit);
    res.json({
      success: true,
      data: logs,
      timestamp: Date.now(),
    });
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

router.post('/security/validate-access', async (req, res) => {
  try {
    await ensureNodeOSInitialized();
    const { userId, resource, action, context } = req.body;

    if (!userId || !resource || !action) {
      return res.status(400).json(createApiError('MISSING_ACCESS_PARAMS', 'userId, resource, and action are required'));
    }

    const result = await nodeOS.securityManager.validateAccess(
      userId,
      resource,
      action,
      context || {}
    );
    res.json({
      success: true,
      data: result,
      timestamp: Date.now(),
    });
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

// System Control Endpoints
router.post('/restart', async (req, res) => {
  try {
    await ensureNodeOSInitialized();

    // Graceful restart (would implement actual restart logic)
    appLogger.info('Node OS restart requested', { service: 'node-os-routes' });

    res.json({
      success: true,
      message: 'Restart initiated',
      timestamp: Date.now(),
    });

    // In a real implementation, would trigger restart
    setTimeout(async () => {
      await nodeOS.shutdown();
      // Restart would happen here
    }, 1000);
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

router.post('/shutdown', async (req, res) => {
  try {
    await ensureNodeOSInitialized();

    res.json({
      success: true,
      message: 'Shutdown initiated',
      timestamp: Date.now(),
    });

    // Graceful shutdown
    setTimeout(async () => {
      await nodeOS.shutdown();
      nodeOSInitialized = false;
    }, 1000);
  } catch (error) {
    appLogger.error('Node OS operation failed', { error: error.message, stack: error.stack });
    res.status(500).json(createApiError('NODE_OS_ERROR', 'Internal server error'));
  }
});

// Error handling middleware
router.use((error, req, res, next) => {
  appLogger.error('Node OS API Error', { error: { message: error.message, stack: error.stack } });
  res.status(500).json(createApiError('NODE_OS_INTERNAL_ERROR', 'Internal server error'));
});

module.exports = router;
