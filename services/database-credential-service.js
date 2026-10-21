/**
 * Database Credential Service
 *
 * Manages database credentials securely with HashiCorp Vault integration.
 * Supports dynamic credential rotation, connection pooling, and
 * automatic lease management.
 *
 * @module database-credential-service
 * @security CRITICAL - This service handles all database authentication
 */

'use strict';

const { Pool } = require('pg');
const { getVaultClient, initializeVault } = require('../server/config/vault-config');
const { createDatabaseSSLConfig } = require('../server/config/secure-ssl-config');
const crypto = require('crypto');
const { securityLogger } = require('../server/utils/logger');

/**
 * Database Credential Manager
 * Handles secure credential retrieval, rotation, and connection management
 */
class DatabaseCredentialService {
  constructor(options = {}) {
    this.vaultClient = null;
    this.connections = new Map(); // role -> { pool, credentials, leaseRenewalTimer }
    this.initialized = false;

    this.options = {
      defaultRole: options.defaultRole || 'readwrite',
      maxPoolSize: options.maxPoolSize || 20,
      minPoolSize: options.minPoolSize || 2,
      idleTimeout: options.idleTimeout || 30000, // 30 seconds
      connectionTimeout: options.connectionTimeout || 10000, // 10 seconds
      leaseRenewalBuffer: options.leaseRenewalBuffer || 60, // Renew 60s before expiry
      healthCheckInterval: options.healthCheckInterval || 60000, // 1 minute
      enableSSL: options.enableSSL !== false, // Default to true
    };

    // Metrics for monitoring
    this.metrics = {
      credentialRotations: 0,
      leaseRenewals: 0,
      connectionFailures: 0,
      activeConnections: 0,
      lastHealthCheck: null,
      lastCredentialRotation: null,
    };

    // Health check timer
    this.healthCheckTimer = null;
  }

  /**
   * Initialize the credential service
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    try {
      // Initialize Vault client
      this.vaultClient = await initializeVault();

      // Check Vault health
      const health = await this.vaultClient.getHealth();
      if (health.sealed) {
        throw new Error('Vault is sealed - cannot retrieve credentials');
      }

      // Start health check monitoring
      this._startHealthChecks();

      this.initialized = true;
      securityLogger.info('Database Credential Service initialized', { service: 'db-creds' });
    } catch (error) {
      securityLogger.error('Initialization failed', { service: 'db-creds', error: error.message });
      throw error;
    }
  }

  /**
   * Get a database connection pool for a specific role
   * @param {string} role - Database role (e.g., 'readonly', 'readwrite', 'admin')
   * @returns {Promise<Pool>} PostgreSQL connection pool
   */
  async getPool(role = this.options.defaultRole) {
    if (!this.initialized) {
      await this.initialize();
    }

    // Check if we have an existing connection for this role
    const existingConnection = this.connections.get(role);
    if (existingConnection && existingConnection.pool) {
      // Verify the pool is still valid
      try {
        await existingConnection.pool.query('SELECT 1');
        return existingConnection.pool;
      } catch (error) {
        securityLogger.warn('Existing pool is invalid, recreating', { service: 'db-creds', role });
        await this._destroyConnection(role);
      }
    }

    // Get new credentials and create pool
    return await this._createConnection(role);
  }

  /**
   * Get a connection from the pool
   * @param {string} role - Database role
   * @returns {Promise<Object>} Database client connection
   */
  async getConnection(role = this.options.defaultRole) {
    const pool = await this.getPool(role);
    try {
      const client = await pool.connect();
      this.metrics.activeConnections++;

      // Wrap release to track metrics
      const originalRelease = client.release.bind(client);
      client.release = () => {
        this.metrics.activeConnections--;
        return originalRelease();
      };

      return client;
    } catch (error) {
      this.metrics.connectionFailures++;
      throw error;
    }
  }

  /**
   * Execute a query with automatic connection management
   * @param {string} sql - SQL query
   * @param {Array} params - Query parameters
   * @param {string} role - Database role
   * @returns {Promise<Object>} Query result
   */
  async query(sql, params = [], role = this.options.defaultRole) {
    const pool = await this.getPool(role);
    try {
      return await pool.query(sql, params);
    } catch (error) {
      // Check if error is due to authentication failure
      if (this._isAuthenticationError(error)) {
        securityLogger.warn('Authentication error, rotating credentials', { service: 'db-creds' });
        await this.rotateCredentials(role);
        // Retry once with new credentials
        const newPool = await this.getPool(role);
        return await newPool.query(sql, params);
      }
      throw error;
    }
  }

  /**
   * Execute a transaction with automatic rollback on error
   * @param {Function} callback - Transaction callback function(client)
   * @param {string} role - Database role
   * @returns {Promise<*>} Transaction result
   */
  async transaction(callback, role = this.options.defaultRole) {
    const client = await this.getConnection(role);
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Rotate credentials for a specific role
   * @param {string} role - Database role
   * @returns {Promise<void>}
   */
  async rotateCredentials(role = this.options.defaultRole) {
    securityLogger.info('Rotating credentials for role', { service: 'db-creds', role });

    // Revoke old credentials if they have a lease
    const existingConnection = this.connections.get(role);
    if (existingConnection && existingConnection.credentials?.leaseId) {
      await this.vaultClient.revokeLease(existingConnection.credentials.leaseId);
    }

    // Destroy existing connection
    await this._destroyConnection(role);

    // Create new connection with new credentials
    await this._createConnection(role);

    this.metrics.credentialRotations++;
    this.metrics.lastCredentialRotation = new Date();

    securityLogger.info('Credentials rotated successfully for role', { service: 'db-creds', role });
  }

  /**
   * Get current service metrics
   * @returns {Object} Service metrics
   */
  getMetrics() {
    const poolStats = {};
    for (const [role, connection] of this.connections) {
      if (connection.pool) {
        poolStats[role] = {
          totalCount: connection.pool.totalCount,
          idleCount: connection.pool.idleCount,
          waitingCount: connection.pool.waitingCount,
        };
      }
    }

    return {
      ...this.metrics,
      pools: poolStats,
      connectedRoles: Array.from(this.connections.keys()),
    };
  }

  /**
   * Health check for the credential service
   * @returns {Promise<Object>} Health status
   */
  async healthCheck() {
    const health = {
      status: 'healthy',
      vaultConnected: false,
      databaseConnected: false,
      pools: {},
      errors: [],
    };

    try {
      // Check Vault connectivity
      const vaultHealth = await this.vaultClient?.getHealth();
      health.vaultConnected = vaultHealth && !vaultHealth.sealed;
      if (!health.vaultConnected) {
        health.errors.push('Vault is not connected or sealed');
        health.status = 'unhealthy';
      }
    } catch (error) {
      health.errors.push(`Vault health check failed: ${error.message}`);
      health.status = 'unhealthy';
    }

    // Check each pool
    for (const [role, connection] of this.connections) {
      try {
        const result = await connection.pool.query('SELECT 1 as health');
        health.pools[role] = {
          status: 'healthy',
          totalConnections: connection.pool.totalCount,
          idleConnections: connection.pool.idleCount,
        };
        health.databaseConnected = true;
      } catch (error) {
        health.pools[role] = {
          status: 'unhealthy',
          error: error.message,
        };
        health.errors.push(`Pool ${role} health check failed: ${error.message}`);
        if (health.status === 'healthy') {
          health.status = 'degraded';
        }
      }
    }

    this.metrics.lastHealthCheck = new Date();
    return health;
  }

  /**
   * Graceful shutdown
   * @returns {Promise<void>}
   */
  async shutdown() {
    securityLogger.info('Shutting down Database Credential Service', { service: 'db-creds' });

    // Stop health checks
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    // Destroy all connections
    const roles = Array.from(this.connections.keys());
    await Promise.all(roles.map(role => this._destroyConnection(role)));

    // Shutdown Vault client
    if (this.vaultClient) {
      await this.vaultClient.shutdown();
    }

    this.initialized = false;
    securityLogger.info('Database Credential Service shut down', { service: 'db-creds' });
  }

  // ==================== Private Methods ====================

  /**
   * Create a new database connection with fresh credentials
   * @private
   */
  async _createConnection(role) {
    try {
      // Get credentials from Vault
      const credentials = await this.vaultClient.getDatabaseCredentials(role);

      // Build connection string securely
      const connectionConfig = {
        user: credentials.username,
        password: credentials.password,
        host: credentials.host || process.env.DB_HOST || 'localhost',
        port: parseInt(credentials.port || process.env.DB_PORT || '5432'),
        database: credentials.database || process.env.DB_NAME || 'wrfcoin',
        max: this.options.maxPoolSize,
        min: this.options.minPoolSize,
        idleTimeoutMillis: this.options.idleTimeout,
        connectionTimeoutMillis: this.options.connectionTimeout,
        // SECURITY: Use secure SSL configuration
        ssl: this.options.enableSSL ? createDatabaseSSLConfig() : false,
      };

      // Create connection pool
      const pool = new Pool(connectionConfig);

      // Handle pool errors
      pool.on('error', (error, client) => {
        securityLogger.error('Pool error', { service: 'db-creds', role, error: error.message });
        this.metrics.connectionFailures++;
      });

      // Verify connection
      await pool.query('SELECT 1');

      // Schedule lease renewal if applicable
      let leaseRenewalTimer = null;
      if (credentials.leaseId && credentials.renewable && credentials.leaseDuration) {
        leaseRenewalTimer = this._scheduleLeaseRenewal(
          role,
          credentials.leaseId,
          credentials.leaseDuration
        );
      }

      // Store connection info
      this.connections.set(role, {
        pool,
        credentials,
        leaseRenewalTimer,
        createdAt: new Date(),
      });

      securityLogger.info('Connection pool created for role', { service: 'db-creds', role });
      return pool;
    } catch (error) {
      securityLogger.error('Failed to create connection for role', { service: 'db-creds', role, error: error.message });
      this.metrics.connectionFailures++;
      throw error;
    }
  }

  /**
   * Destroy a database connection
   * @private
   */
  async _destroyConnection(role) {
    const connection = this.connections.get(role);
    if (!connection) {
      return;
    }

    // Clear lease renewal timer
    if (connection.leaseRenewalTimer) {
      clearTimeout(connection.leaseRenewalTimer);
    }

    // Revoke lease if applicable
    if (connection.credentials?.leaseId) {
      try {
        await this.vaultClient.revokeLease(connection.credentials.leaseId);
      } catch (error) {
        securityLogger.warn('Failed to revoke lease for role', { service: 'db-creds', role, error: error.message });
      }
    }

    // Close pool
    if (connection.pool) {
      try {
        await connection.pool.end();
      } catch (error) {
        securityLogger.warn('Error closing pool for role', { service: 'db-creds', role, error: error.message });
      }
    }

    this.connections.delete(role);
    securityLogger.info('Connection destroyed for role', { service: 'db-creds', role });
  }

  /**
   * Schedule automatic lease renewal
   * @private
   */
  _scheduleLeaseRenewal(role, leaseId, leaseDuration) {
    // Renew before expiry
    const renewalTime = (leaseDuration - this.options.leaseRenewalBuffer) * 1000;

    return setTimeout(async () => {
      try {
        const renewedLease = await this.vaultClient.renewLease(leaseId);
        this.metrics.leaseRenewals++;

        // Update credentials with new lease info
        const connection = this.connections.get(role);
        if (connection) {
          connection.credentials = {
            ...connection.credentials,
            leaseId: renewedLease.leaseId,
            leaseDuration: renewedLease.leaseDuration,
          };

          // Schedule next renewal
          connection.leaseRenewalTimer = this._scheduleLeaseRenewal(
            role,
            renewedLease.leaseId,
            renewedLease.leaseDuration
          );
        }

        securityLogger.info('Lease renewed for role', { service: 'db-creds', role });
      } catch (error) {
        securityLogger.error('Lease renewal failed for role', { service: 'db-creds', role, error: error.message });
        // If renewal fails, rotate credentials
        try {
          await this.rotateCredentials(role);
        } catch (rotateError) {
          securityLogger.error('Credential rotation also failed', { service: 'db-creds', error: rotateError.message });
        }
      }
    }, renewalTime);
  }

  /**
   * Start periodic health checks
   * @private
   */
  _startHealthChecks() {
    this.healthCheckTimer = setInterval(async () => {
      try {
        await this.healthCheck();
      } catch (error) {
        securityLogger.error('Health check failed', { service: 'db-creds', error: error.message });
      }
    }, this.options.healthCheckInterval);
  }

  /**
   * Check if an error is an authentication error
   * @private
   */
  _isAuthenticationError(error) {
    const authErrorCodes = ['28P01', '28000']; // PostgreSQL authentication error codes
    const authErrorMessages = ['password authentication failed', 'authentication failed'];

    if (authErrorCodes.includes(error.code)) {
      return true;
    }

    const message = error.message?.toLowerCase() || '';
    return authErrorMessages.some(msg => message.includes(msg));
  }
}

// ==================== Connection URL Builder ====================

/**
 * Build a secure database connection URL
 * @param {Object} credentials - Database credentials
 * @param {Object} options - Connection options
 * @returns {string} Database connection URL
 */
function buildSecureConnectionUrl(credentials, options = {}) {
  const {
    username,
    password,
    host = 'localhost',
    port = 5432,
    database = 'wrfcoin',
  } = credentials;

  // URL encode password to handle special characters
  const encodedPassword = encodeURIComponent(password);

  // Build base URL
  let url = `postgresql://${username}:${encodedPassword}@${host}:${port}/${database}`;

  // Add SSL parameters
  const params = [];
  if (options.sslMode !== false) {
    params.push('sslmode=require');
  }
  if (options.applicationName) {
    params.push(`application_name=${encodeURIComponent(options.applicationName)}`);
  }

  if (params.length > 0) {
    url += '?' + params.join('&');
  }

  return url;
}

// ==================== Singleton Instance ====================

let credentialServiceInstance = null;

/**
 * Get or create the credential service singleton
 * @param {Object} options - Service options
 * @returns {DatabaseCredentialService}
 */
function getDatabaseCredentialService(options = {}) {
  if (!credentialServiceInstance) {
    credentialServiceInstance = new DatabaseCredentialService(options);
  }
  return credentialServiceInstance;
}

/**
 * Initialize the credential service (call once at application startup)
 * @param {Object} options - Service options
 * @returns {Promise<DatabaseCredentialService>}
 */
async function initializeDatabaseCredentials(options = {}) {
  const service = getDatabaseCredentialService(options);
  await service.initialize();
  return service;
}

module.exports = {
  DatabaseCredentialService,
  getDatabaseCredentialService,
  initializeDatabaseCredentials,
  buildSecureConnectionUrl,
};
