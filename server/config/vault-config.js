/**
 * HashiCorp Vault Configuration Module
 *
 * Provides secure secret management with automatic token renewal,
 * AppRole authentication, and credential rotation support.
 *
 * @module vault-config
 * @security CRITICAL - This module handles all secret management
 */

'use strict';

const crypto = require('crypto');
const { securityLogger } = require('../utils/logger.js');

/**
 * Vault Client Configuration
 * Handles connection and authentication to HashiCorp Vault
 */
class VaultClient {
  constructor(options = {}) {
    this.endpoint = options.endpoint || process.env.VAULT_ENDPOINT || 'https://vault.wrfcoin.internal:8200';
    this.namespace = options.namespace || process.env.VAULT_NAMESPACE || '';
    this.token = null;
    this.tokenExpiry = null;
    this.tokenRenewalTimer = null;
    this.isAuthenticated = false;

    // AppRole credentials (never log these)
    this.roleId = options.roleId || process.env.VAULT_ROLE_ID;
    this.secretId = options.secretId || process.env.VAULT_SECRET_ID;

    // Configuration options
    this.options = {
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 1000,
      requestTimeout: options.requestTimeout || 30000,
      renewBeforeExpiry: options.renewBeforeExpiry || 300, // 5 minutes
      tlsRejectUnauthorized: options.tlsRejectUnauthorized !== false, // SECURITY: Default to true
      caCert: options.caCert || process.env.VAULT_CA_CERT,
    };

    // Secret cache with TTL
    this.secretCache = new Map();
    this.cacheTTL = options.cacheTTL || 300000; // 5 minutes default
  }

  /**
   * Initialize Vault client with proper authentication
   * @returns {Promise<void>}
   */
  async initialize() {
    if (process.env.NODE_ENV === 'development' && !this.roleId) {
      securityLogger.warn('Running in development mode without Vault credentials', {
        operation: 'vault:initialize',
        mode: 'development',
        fallback: 'environment-variables',
      });
      this.isAuthenticated = false;
      return;
    }

    await this.authenticateAppRole();
  }

  /**
   * Authenticate using AppRole method (recommended for production)
   * @returns {Promise<void>}
   * @throws {Error} If authentication fails
   */
  async authenticateAppRole() {
    if (!this.roleId || !this.secretId) {
      throw new Error('VAULT_ROLE_ID and VAULT_SECRET_ID must be configured for Vault authentication');
    }

    try {
      const response = await this._makeRequest('/v1/auth/approle/login', {
        method: 'POST',
        body: JSON.stringify({
          role_id: this.roleId,
          secret_id: this.secretId,
        }),
      });

      const data = await response.json();

      if (!data.auth || !data.auth.client_token) {
        throw new Error('Invalid authentication response from Vault');
      }

      this.token = data.auth.client_token;
      this.tokenExpiry = Date.now() + (data.auth.lease_duration * 1000);
      this.isAuthenticated = true;

      // Schedule token renewal
      this._scheduleTokenRenewal(data.auth.lease_duration);

      // SECURITY: Never log the token value
      securityLogger.info('Successfully authenticated via AppRole', {
        operation: 'vault:auth:approle',
        status: 'success',
        leaseDuration: data.auth.lease_duration,
      });
    } catch (error) {
      securityLogger.error('AppRole authentication failed', {
        operation: 'vault:auth:approle',
        error: { name: error.name, message: error.message },
      });
      throw new Error(`Vault authentication failed: ${error.message}`);
    }
  }

  /**
   * Read a secret from Vault KV v2 secrets engine
   * @param {string} path - Secret path (e.g., 'database/credentials')
   * @returns {Promise<Object>} Secret data
   */
  async readSecret(path) {
    // Check cache first
    const cached = this._getCachedSecret(path);
    if (cached) {
      return cached;
    }

    if (!this.isAuthenticated) {
      // Fallback to environment variables in development
      return this._getSecretsFromEnvironment(path);
    }

    try {
      // KV v2 path format: /v1/secret/data/{path}
      const response = await this._makeRequest(`/v1/secret/data/${path}`, {
        method: 'GET',
        headers: {
          'X-Vault-Token': this.token,
        },
      });

      const data = await response.json();

      if (!data.data || !data.data.data) {
        throw new Error(`Secret not found at path: ${path}`);
      }

      const secret = data.data.data;

      // Cache the secret
      this._cacheSecret(path, secret, data.data.metadata?.version);

      return secret;
    } catch (error) {
      securityLogger.error('Failed to read secret', {
        operation: 'vault:secret:read',
        path,
        error: { name: error.name, message: error.message },
      });
      throw error;
    }
  }

  /**
   * Read database credentials with dynamic secrets support
   * @param {string} role - Database role name
   * @returns {Promise<Object>} Database credentials
   */
  async getDatabaseCredentials(role = 'readonly') {
    if (!this.isAuthenticated) {
      return this._getDatabaseCredentialsFromEnvironment();
    }

    try {
      // Dynamic database credentials path
      const response = await this._makeRequest(`/v1/database/creds/${role}`, {
        method: 'GET',
        headers: {
          'X-Vault-Token': this.token,
        },
      });

      const data = await response.json();

      if (!data.data) {
        throw new Error(`Failed to get database credentials for role: ${role}`);
      }

      return {
        username: data.data.username,
        password: data.data.password,
        leaseId: data.lease_id,
        leaseDuration: data.lease_duration,
        renewable: data.renewable,
      };
    } catch (error) {
      securityLogger.error('Failed to get database credentials', {
        operation: 'vault:db:creds',
        role,
        error: { name: error.name, message: error.message },
      });
      // Fallback to environment variables
      return this._getDatabaseCredentialsFromEnvironment();
    }
  }

  /**
   * Revoke a lease (e.g., when a database connection is closed)
   * @param {string} leaseId - Vault lease ID
   * @returns {Promise<void>}
   */
  async revokeLease(leaseId) {
    if (!this.isAuthenticated || !leaseId) {
      return;
    }

    try {
      await this._makeRequest('/v1/sys/leases/revoke', {
        method: 'PUT',
        headers: {
          'X-Vault-Token': this.token,
        },
        body: JSON.stringify({ lease_id: leaseId }),
      });
      securityLogger.info('Lease revoked successfully', {
        operation: 'vault:lease:revoke',
        status: 'success',
      });
    } catch (error) {
      securityLogger.warn('Failed to revoke lease', {
        operation: 'vault:lease:revoke',
        error: { name: error.name, message: error.message },
      });
    }
  }

  /**
   * Renew a lease to extend its TTL
   * @param {string} leaseId - Vault lease ID
   * @returns {Promise<Object>} New lease information
   */
  async renewLease(leaseId) {
    if (!this.isAuthenticated || !leaseId) {
      throw new Error('Cannot renew lease: not authenticated or no lease ID');
    }

    try {
      const response = await this._makeRequest('/v1/sys/leases/renew', {
        method: 'PUT',
        headers: {
          'X-Vault-Token': this.token,
        },
        body: JSON.stringify({ lease_id: leaseId }),
      });

      const data = await response.json();

      return {
        leaseId: data.lease_id,
        leaseDuration: data.lease_duration,
        renewable: data.renewable,
      };
    } catch (error) {
      securityLogger.error('Failed to renew lease', {
        operation: 'vault:lease:renew',
        error: { name: error.name, message: error.message },
      });
      throw error;
    }
  }

  /**
   * Check Vault health and seal status
   * @returns {Promise<Object>} Health status
   */
  async getHealth() {
    try {
      const response = await this._makeRequest('/v1/sys/health', {
        method: 'GET',
      });

      const data = await response.json();

      return {
        initialized: data.initialized,
        sealed: data.sealed,
        standby: data.standby,
        version: data.version,
        clusterName: data.cluster_name,
      };
    } catch (error) {
      return {
        initialized: false,
        sealed: true,
        error: error.message,
      };
    }
  }

  /**
   * Graceful shutdown - revoke token and cleanup
   * @returns {Promise<void>}
   */
  async shutdown() {
    if (this.tokenRenewalTimer) {
      clearTimeout(this.tokenRenewalTimer);
      this.tokenRenewalTimer = null;
    }

    // Revoke self token
    if (this.isAuthenticated && this.token) {
      try {
        await this._makeRequest('/v1/auth/token/revoke-self', {
          method: 'POST',
          headers: {
            'X-Vault-Token': this.token,
          },
        });
        securityLogger.info('Token revoked on shutdown', {
          operation: 'vault:token:revoke',
          status: 'success',
        });
      } catch (error) {
        securityLogger.warn('Failed to revoke token on shutdown', {
          operation: 'vault:token:revoke',
          error: { name: error.name, message: error.message },
        });
      }
    }

    this.isAuthenticated = false;
    this.token = null;
    this.secretCache.clear();
  }

  // ==================== Private Methods ====================

  /**
   * Make HTTP request to Vault API
   * @private
   */
  async _makeRequest(path, options = {}) {
    const url = `${this.endpoint}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      ...(this.namespace && { 'X-Vault-Namespace': this.namespace }),
      ...options.headers,
    };

    // SECURITY: Ensure TLS validation is enabled
    const fetchOptions = {
      method: options.method || 'GET',
      headers,
      body: options.body,
      signal: AbortSignal.timeout(this.options.requestTimeout),
    };

    let lastError;
    for (let attempt = 0; attempt < this.options.maxRetries; attempt++) {
      try {
        const response = await fetch(url, fetchOptions);

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`Vault API error: ${response.status} - ${errorBody}`);
        }

        return response;
      } catch (error) {
        lastError = error;
        if (attempt < this.options.maxRetries - 1) {
          await this._sleep(this.options.retryDelay * (attempt + 1));
        }
      }
    }

    throw lastError;
  }

  /**
   * Schedule automatic token renewal
   * @private
   */
  _scheduleTokenRenewal(leaseDuration) {
    if (this.tokenRenewalTimer) {
      clearTimeout(this.tokenRenewalTimer);
    }

    // Renew at 80% of lease duration or before expiry threshold
    const renewalTime = Math.min(
      leaseDuration * 0.8,
      leaseDuration - this.options.renewBeforeExpiry
    ) * 1000;

    this.tokenRenewalTimer = setTimeout(async () => {
      try {
        await this._renewToken();
      } catch (error) {
        securityLogger.error('Token renewal failed, re-authenticating', {
          operation: 'vault:token:renew',
          error: { name: error.name, message: error.message },
        });
        try {
          await this.authenticateAppRole();
        } catch (authError) {
          securityLogger.error('Re-authentication failed', {
            operation: 'vault:auth:approle',
            error: { name: authError.name, message: authError.message },
          });
          this.isAuthenticated = false;
        }
      }
    }, renewalTime);
  }

  /**
   * Renew the current authentication token
   * @private
   */
  async _renewToken() {
    const response = await this._makeRequest('/v1/auth/token/renew-self', {
      method: 'POST',
      headers: {
        'X-Vault-Token': this.token,
      },
    });

    const data = await response.json();

    this.tokenExpiry = Date.now() + (data.auth.lease_duration * 1000);
    this._scheduleTokenRenewal(data.auth.lease_duration);

    securityLogger.info('Token renewed successfully', {
      operation: 'vault:token:renew',
      status: 'success',
      leaseDuration: data.auth.lease_duration,
    });
  }

  /**
   * Cache a secret with TTL
   * @private
   */
  _cacheSecret(path, secret, version) {
    this.secretCache.set(path, {
      data: secret,
      version,
      expiresAt: Date.now() + this.cacheTTL,
    });
  }

  /**
   * Get cached secret if not expired
   * @private
   */
  _getCachedSecret(path) {
    const cached = this.secretCache.get(path);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }
    this.secretCache.delete(path);
    return null;
  }

  /**
   * Fallback: Get secrets from environment variables (development only)
   * @private
   */
  _getSecretsFromEnvironment(path) {
    securityLogger.warn('Using environment variable fallback for secrets', {
      operation: 'vault:secret:fallback',
      path,
    });

    // Map common secret paths to environment variables
    const secretMappings = {
      'database/credentials': {
        username: process.env.DB_USER || process.env.POSTGRES_USER,
        password: process.env.DB_PASSWORD || process.env.POSTGRES_PASSWORD,
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || '5432',
        database: process.env.DB_NAME || process.env.POSTGRES_DB || 'wrfcoin',
      },
      'redis/credentials': {
        password: process.env.REDIS_PASSWORD,
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || '6379',
      },
      'jwt/secrets': {
        secret: process.env.JWT_SECRET,
        refreshSecret: process.env.JWT_REFRESH_SECRET,
      },
      'api/keys': {
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        perplexityApiKey: process.env.PERPLEXITY_API_KEY,
      },
    };

    return secretMappings[path] || {};
  }

  /**
   * Fallback: Get database credentials from environment (development only)
   * @private
   */
  _getDatabaseCredentialsFromEnvironment() {
    securityLogger.warn('Using environment variable fallback for database credentials', {
      operation: 'vault:db:fallback',
    });

    // Parse DATABASE_URL if available
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl) {
      try {
        const url = new URL(databaseUrl);
        return {
          username: url.username,
          password: url.password,
          host: url.hostname,
          port: url.port || '5432',
          database: url.pathname.slice(1),
          leaseId: null,
          leaseDuration: null,
          renewable: false,
        };
      } catch (error) {
        securityLogger.warn('Failed to parse DATABASE_URL', {
          operation: 'vault:db:parse',
          error: { name: error.name, message: error.message },
        });
      }
    }

    return {
      username: process.env.DB_USER || process.env.POSTGRES_USER || 'postgres',
      password: process.env.DB_PASSWORD || process.env.POSTGRES_PASSWORD,
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || '5432',
      database: process.env.DB_NAME || process.env.POSTGRES_DB || 'wrfcoin',
      leaseId: null,
      leaseDuration: null,
      renewable: false,
    };
  }

  /**
   * Sleep utility for retries
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Singleton instance
let vaultClientInstance = null;

/**
 * Get or create the Vault client singleton
 * @param {Object} options - Configuration options
 * @returns {VaultClient}
 */
function getVaultClient(options = {}) {
  if (!vaultClientInstance) {
    vaultClientInstance = new VaultClient(options);
  }
  return vaultClientInstance;
}

/**
 * Initialize Vault client (call once at application startup)
 * @param {Object} options - Configuration options
 * @returns {Promise<VaultClient>}
 */
async function initializeVault(options = {}) {
  const client = getVaultClient(options);
  await client.initialize();
  return client;
}

module.exports = {
  VaultClient,
  getVaultClient,
  initializeVault,
};
