/**
 * Express middleware for HashiCorp Vault integration
 * Provides request-level secret access and authentication
 */

const vaultConfig = require('../security/vault-config');
const { securityLogger } = require('../server/utils/logger');

/**
 * Middleware to inject Vault secrets into request context
 */
function vaultSecretsMiddleware(requiredSecrets = []) {
  return async (req, res, next) => {
    try {
      // Initialize vault secrets object on request
      req.vault = {
        secrets: {},
        getSecret: async secretName => {
          if (req.vault.secrets[secretName]) {
            return req.vault.secrets[secretName];
          }

          const secret = await vaultConfig.getSecret(secretName);
          req.vault.secrets[secretName] = secret;
          return secret;
        },
        getDatabaseCredentials: async role => {
          return await vaultConfig.getDatabaseCredentials(role);
        },
        getAPIKeys: async service => {
          return await vaultConfig.getAPIKeys(service);
        },
      };

      // Pre-load required secrets
      for (const secretName of requiredSecrets) {
        req.vault.secrets[secretName] = await vaultConfig.getSecret(secretName);
      }

      next();
    } catch (error) {
      securityLogger.error('Vault middleware error', { error: error.message });
      res.status(500).json({
        error: 'Secret management service unavailable',
        message:
          process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  };
}

/**
 * Middleware for dynamic database credential injection
 */
function vaultDatabaseMiddleware(role = 'wrfcoin-app') {
  return async (req, res, next) => {
    try {
      const credentials = await vaultConfig.getDatabaseCredentials(role);

      req.dbCredentials = credentials;

      // Setup cleanup for dynamic credentials
      if (credentials.lease_id) {
        req.on('close', async () => {
          try {
            await vaultConfig.vault.revokeLease(credentials.lease_id);
          } catch (error) {
            securityLogger.warn('Failed to revoke database lease', { error: error.message });
          }
        });
      }

      next();
    } catch (error) {
      securityLogger.error('Database credential middleware error', { error: error.message });
      res.status(500).json({
        error: 'Database authentication service unavailable',
      });
    }
  };
}

/**
 * Middleware for audit logging of sensitive operations
 */
function vaultAuditMiddleware(operation) {
  return (req, res, next) => {
    // Log the operation
    vaultConfig.vault.logAuditEvent(
      `HTTP_${operation}`,
      req.user?.id || req.ip,
      `${req.method} ${req.path} - ${operation}`
    );

    // Override res.json to log successful operations
    const originalJson = res.json;
    res.json = function (data) {
      if (res.statusCode < 400) {
        vaultConfig.vault.logAuditEvent(
          `HTTP_${operation}_SUCCESS`,
          req.user?.id || req.ip,
          `${req.method} ${req.path} completed successfully`
        );
      }
      return originalJson.call(this, data);
    };

    next();
  };
}

/**
 * Health check endpoint for Vault integration
 */
async function vaultHealthCheck(req, res) {
  try {
    const health = await vaultConfig.healthCheck();

    res.status(health.healthy ? 200 : 503).json({
      service: 'HashiCorp Vault',
      healthy: health.healthy,
      status: health.status,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      service: 'HashiCorp Vault',
      healthy: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Audit logs endpoint
 */
async function vaultAuditLogs(req, res) {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const logs = vaultConfig.getAuditLogs(limit);

    res.json({
      logs: logs,
      count: logs.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to retrieve audit logs',
      message: error.message,
    });
  }
}

/**
 * Secret rotation endpoint (admin only)
 */
async function rotateSecret(req, res) {
  try {
    const { secretName } = req.params;

    if (!secretName) {
      return res.status(400).json({
        error: 'Secret name is required',
      });
    }

    // Only allow rotation of specific secrets
    const allowedSecrets = [
      'JWT_SECRET',
      'JWT_REFRESH_SECRET',
      'SESSION_SECRET',
      'DATA_ENCRYPTION_KEY',
    ];

    if (!allowedSecrets.includes(secretName)) {
      return res.status(403).json({
        error: 'Secret rotation not allowed for this type',
      });
    }

    const path = vaultConfig.secretPaths[secretName];
    await vaultConfig.vault.rotateSecret(path);

    vaultConfig.vault.logAuditEvent(
      'MANUAL_SECRET_ROTATION',
      req.user?.id || req.ip,
      `Manual rotation of ${secretName}`
    );

    res.json({
      message: `Secret ${secretName} rotated successfully`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      error: 'Secret rotation failed',
      message: error.message,
    });
  }
}

module.exports = {
  vaultSecretsMiddleware,
  vaultDatabaseMiddleware,
  vaultAuditMiddleware,
  vaultHealthCheck,
  vaultAuditLogs,
  rotateSecret,
};
