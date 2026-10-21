/**
 * Wrfcoin Core Health Check Module
 *
 * This module provides health check endpoints for the API server.
 * These endpoints are used by the workflow manager to check if services are up and running.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { pool } = require('./db');
const { appLogger } = require('./utils/logger');

// Keep track of startup time
const startTime = Date.now();

// Create a metrics directory if it doesn't exist
const metricsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(metricsDir)) {
  fs.mkdirSync(metricsDir, { recursive: true });
}

/**
 * Basic health check - indicates if the server is running
 */
async function basicHealth(req, res) {
  try {
    res.json({
      status: 'healthy',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    appLogger.error('Basic health check error', { module: 'Health', operation: 'basicHealth', error: error.message });
    res.status(500).json({
      status: 'error',
      error: error.message,
    });
  }
}

/**
 * Database health check - verifies database connectivity
 */
async function databaseHealth(req, res) {
  try {
    // Test database connectivity with a simple query
    const result = await pool.query('SELECT NOW()');

    res.json({
      status: 'healthy',
      database: {
        connected: true,
        timestamp: result.rows[0].now,
      },
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    appLogger.error('Database health check error', { module: 'Health', operation: 'databaseHealth', error: error.message });
    res.status(500).json({
      status: 'error',
      database: {
        connected: false,
        error: error.message,
      },
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Complete health check - checks all components
 */
async function completeHealth(req, res) {
  try {
    // Database check
    let databaseStatus = {
      connected: false,
      error: 'Not checked',
    };

    try {
      const result = await pool.query('SELECT NOW()');
      databaseStatus = {
        connected: true,
        timestamp: result.rows[0].now,
      };
    } catch (error) {
      databaseStatus = {
        connected: false,
        error: error.message,
      };
    }

    // System resources check
    const cpus = os.cpus();
    const systemStatus = {
      memory: {
        total: os.totalmem(),
        free: os.freemem(),
        usage: (1 - os.freemem() / os.totalmem()) * 100,
      },
      cpu: {
        cores: cpus.length,
        model: cpus.length > 0 ? cpus[0].model : 'Unknown',
        loadAvg: os.loadavg(),
      },
      uptime: os.uptime(),
    };

    // Check if the logs directory is writable
    let logsStatus = {
      writable: false,
      error: 'Not checked',
    };

    try {
      const testFile = path.join(metricsDir, `test-${Date.now()}.txt`);
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
      logsStatus = {
        writable: true,
      };
    } catch (error) {
      logsStatus = {
        writable: false,
        error: error.message,
      };
    }

    // Return all health data
    res.json({
      status:
        databaseStatus.connected && logsStatus.writable
          ? 'healthy'
          : 'degraded',
      database: databaseStatus,
      system: systemStatus,
      logs: logsStatus,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    appLogger.error('Complete health check error', { module: 'Health', operation: 'completeHealth', error: error.message });
    res.status(500).json({
      status: 'error',
      error: error.message,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Register health check routes with the Express app
 *
 * @param {Express} app - Express application
 */
function register(app) {
  app.get('/health', basicHealth);
  app.get('/health/database', databaseHealth);
  app.get('/health/complete', completeHealth);
}

module.exports = {
  register,
  basicHealth,
  databaseHealth,
  completeHealth,
};
