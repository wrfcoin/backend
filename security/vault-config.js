/**
 * HashiCorp Vault Configuration Manager
 * Handles environment-specific Vault setup and policy management
 */

const VaultIntegration = require('./vault-integration');
const { securityLogger } = require('../server/utils/logger.js');

class VaultConfig {
  constructor() {
    this.vault = new VaultIntegration();
    this.policies = new Map();
    this.secretPaths = {
      // Core application secrets
      JWT_SECRET: 'wrfcoin/jwt-secret',
      JWT_REFRESH_SECRET: 'wrfcoin/jwt-refresh-secret',
      SESSION_SECRET: 'wrfcoin/session-secret',

      // Database credentials
      DB_PASSWORD: 'wrfcoin/database/password',
      DB_READONLY_USER: 'wrfcoin/database/readonly-user',

      // External API keys
      WEATHER_API_KEYS: 'wrfcoin/api-keys/weather',
      BLOCKCHAIN_API_KEYS: 'wrfcoin/api-keys/blockchain',

      // Encryption keys
      DATA_ENCRYPTION_KEY: 'wrfcoin/encryption/data-key',
      BACKUP_ENCRYPTION_KEY: 'wrfcoin/encryption/backup-key',

      // HSM and hardware security
      HSM_CONFIG: 'wrfcoin/hsm/config',
      SIGNING_KEYS: 'wrfcoin/hsm/signing-keys',
    };
  }

  /**
   * Initialize Vault configuration for Wrfcoin platform
   */
  async initialize() {
    try {
      securityLogger.info('Initializing Vault configuration for Wrfcoin', {
        operation: 'vault:config:init',
      });

      await this.vault.initialize();

      // Setup access policies
      await this.setupAccessPolicies();

      // Initialize core secrets
      await this.initializeCoreSecrets();

      // Setup database dynamic credentials
      await this.setupDatabaseSecrets();

      // Configure secret rotation
      await this.setupSecretRotation();

      securityLogger.info('Vault configuration initialized successfully', {
        operation: 'vault:config:init',
        status: 'success',
      });
      return true;
    } catch (error) {
      securityLogger.error('Failed to initialize Vault configuration', {
        operation: 'vault:config:init',
        error: { name: error.name, message: error.message },
      });
      throw error;
    }
  }

  /**
   * Setup access policies for different components
   */
  async setupAccessPolicies() {
    securityLogger.info('Setting up Vault access policies', {
      operation: 'vault:policy:setup',
    });

    // Application read/write policy
    const appPolicy = `
# Application secrets - full access
path "secret/data/wrfcoin/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}

# Database dynamic credentials - read only
path "database/creds/wrfcoin-app" {
  capabilities = ["read"]
}

# Transit encryption - encrypt/decrypt
path "transit/encrypt/wrfcoin" {
  capabilities = ["update"]
}
path "transit/decrypt/wrfcoin" {
  capabilities = ["update"]
}

# PKI for certificate management
path "pki/issue/wrfcoin-dot-com" {
  capabilities = ["update"]
}
`;

    // Read-only policy for monitoring
    const monitoringPolicy = `
# Read-only access to application secrets
path "secret/data/wrfcoin/*" {
  capabilities = ["read", "list"]
}

# System health monitoring
path "sys/health" {
  capabilities = ["read"]
}
`;

    // Database admin policy
    const databaseAdminPolicy = `
# Database connection configuration
path "database/config/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}

# Database roles management
path "database/roles/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}
`;

    await this.vault.createPolicy('wrfcoin-app', appPolicy);
    await this.vault.createPolicy('wrfcoin-monitoring', monitoringPolicy);
    await this.vault.createPolicy('wrfcoin-db-admin', databaseAdminPolicy);

    securityLogger.info('Access policies configured', {
      operation: 'vault:policy:setup',
      policies: ['wrfcoin-app', 'wrfcoin-monitoring', 'wrfcoin-db-admin'],
      status: 'success',
    });
  }

  /**
   * Initialize core application secrets
   */
  async initializeCoreSecrets() {
    securityLogger.info('Initializing core application secrets', {
      operation: 'vault:secrets:init',
    });

    const secrets = [
      {
        path: this.secretPaths.JWT_SECRET,
        generator: () => this.vault.generateSecureSecret(64),
      },
      {
        path: this.secretPaths.JWT_REFRESH_SECRET,
        generator: () => this.vault.generateSecureSecret(64),
      },
      {
        path: this.secretPaths.SESSION_SECRET,
        generator: () => this.vault.generateSecureSecret(32),
      },
      {
        path: this.secretPaths.DATA_ENCRYPTION_KEY,
        generator: () => this.vault.generateSecureSecret(32),
      },
      {
        path: this.secretPaths.BACKUP_ENCRYPTION_KEY,
        generator: () => this.vault.generateSecureSecret(32),
      },
    ];

    for (const secret of secrets) {
      try {
        // Check if secret already exists
        await this.vault.getSecret(secret.path);
        securityLogger.debug('Secret already exists', {
          operation: 'vault:secrets:check',
          path: secret.path,
        });
      } catch (error) {
        // Secret doesn't exist, create it (never log the value!)
        const value = await secret.generator();
        await this.vault.storeSecret(
          secret.path,
          { value },
          {
            created_for: 'wrfcoin-platform',
            type: 'application-secret',
          }
        );
        securityLogger.info('Created secret', {
          operation: 'vault:secrets:create',
          path: secret.path,
        });
      }
    }

    securityLogger.info('Core secrets initialized', {
      operation: 'vault:secrets:init',
      status: 'success',
    });
  }

  /**
   * Setup database dynamic credential configuration
   */
  async setupDatabaseSecrets() {
    securityLogger.info('Setting up database dynamic credentials', {
      operation: 'vault:db:setup',
    });

    try {
      // Configure PostgreSQL connection
      // SECURITY: Never log dbConfig - contains credentials
      const dbAdminPassword = process.env.DB_ADMIN_PASSWORD;
      if (!dbAdminPassword) {
        throw new Error(
          'DB_ADMIN_PASSWORD environment variable is required for Vault database setup'
        );
      }

      const dbConfig = {
        plugin_name: 'postgresql-database-plugin',
        connection_url:
          process.env.DATABASE_URL ||
          'postgresql://{{username}}:{{password}}@localhost:5432/wrfcoin',
        allowed_roles: ['wrfcoin-app', 'wrfcoin-readonly'],
        username: process.env.DB_ADMIN_USER || 'postgres',
        password: dbAdminPassword,
      };

      await this.vault.client.write('database/config/wrfcoin-db', dbConfig);

      // Create application role
      const appRole = {
        db_name: 'wrfcoin-db',
        creation_statements: [
          "CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}';",
          'GRANT CONNECT ON DATABASE wrfcoin TO "{{name}}";',
          'GRANT USAGE ON SCHEMA public TO "{{name}}";',
          'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "{{name}}";',
        ],
        default_ttl: '1h',
        max_ttl: '24h',
      };

      await this.vault.client.write('database/roles/wrfcoin-app', appRole);

      // Create readonly role
      const readonlyRole = {
        db_name: 'wrfcoin-db',
        creation_statements: [
          "CREATE ROLE \"{{name}}\" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}';",
          'GRANT CONNECT ON DATABASE wrfcoin TO "{{name}}";',
          'GRANT USAGE ON SCHEMA public TO "{{name}}";',
          'GRANT SELECT ON ALL TABLES IN SCHEMA public TO "{{name}}";',
        ],
        default_ttl: '4h',
        max_ttl: '8h',
      };

      await this.vault.client.write(
        'database/roles/wrfcoin-readonly',
        readonlyRole
      );

      securityLogger.info('Database dynamic credentials configured', {
        operation: 'vault:db:setup',
        roles: ['wrfcoin-app', 'wrfcoin-readonly'],
        status: 'success',
      });
    } catch (error) {
      securityLogger.warn('Could not configure database secrets (may require admin setup)', {
        operation: 'vault:db:setup',
        error: { name: error.name, message: error.message },
      });
    }
  }

  /**
   * Setup automated secret rotation schedules
   */
  async setupSecretRotation() {
    securityLogger.info('Setting up secret rotation schedules', {
      operation: 'vault:rotation:setup',
    });

    // JWT secrets - rotate every 24 hours
    this.vault.scheduleRotation(
      this.secretPaths.JWT_SECRET,
      24 * 60 * 60 * 1000, // 24 hours
      () => this.vault.generateSecureSecret(64)
    );

    this.vault.scheduleRotation(
      this.secretPaths.JWT_REFRESH_SECRET,
      24 * 60 * 60 * 1000, // 24 hours
      () => this.vault.generateSecureSecret(64)
    );

    // Session secret - rotate every 7 days
    this.vault.scheduleRotation(
      this.secretPaths.SESSION_SECRET,
      7 * 24 * 60 * 60 * 1000, // 7 days
      () => this.vault.generateSecureSecret(32)
    );

    // Encryption keys - rotate every 30 days
    this.vault.scheduleRotation(
      this.secretPaths.DATA_ENCRYPTION_KEY,
      30 * 24 * 60 * 60 * 1000, // 30 days
      () => this.vault.generateSecureSecret(32)
    );

    securityLogger.info('Secret rotation schedules configured', {
      operation: 'vault:rotation:setup',
      status: 'success',
    });
  }

  /**
   * Get a secret by name with automatic fallback handling
   */
  async getSecret(secretName) {
    const path = this.secretPaths[secretName];
    if (!path) {
      throw new Error(`Unknown secret: ${secretName}`);
    }

    try {
      const secret = await this.vault.getSecret(path);
      return secret.value;
    } catch (error) {
      securityLogger.error('Failed to retrieve secret', {
        operation: 'vault:secret:get',
        secretName,
        error: { name: error.name, message: error.message },
      });

      // For development, provide helpful error message
      if (process.env.NODE_ENV === 'development') {
        throw new Error(`
                    Secret '${secretName}' not found in Vault.
                    
                    To initialize, run:
                    node -e "require('./backend/security/vault-config').initialize()"
                    
                    Or set environment variable as fallback:
                    export ${secretName}="your-secret-value"
                `);
      }

      throw error;
    }
  }

  /**
   * Store or update a secret
   */
  async setSecret(secretName, value, metadata = {}) {
    const path = this.secretPaths[secretName];
    if (!path) {
      throw new Error(`Unknown secret: ${secretName}`);
    }

    return await this.vault.storeSecret(
      path,
      { value },
      {
        updated_by: 'wrfcoin-platform',
        updated_at: new Date().toISOString(),
        ...metadata,
      }
    );
  }

  /**
   * Get database credentials (dynamic or static)
   */
  async getDatabaseCredentials(role = 'wrfcoin-app') {
    try {
      // Try to get dynamic credentials first
      return await this.vault.getDynamicDBCredentials(role);
    } catch (error) {
      securityLogger.warn('Dynamic DB credentials not available, falling back to static', {
        operation: 'vault:db:creds',
        role,
        error: { name: error.name, message: error.message },
      });

      // Fallback to static credentials
      const password = await this.getSecret('DB_PASSWORD');
      return {
        username: process.env.DB_USER || 'wrfcoin',
        password: password,
        static: true,
      };
    }
  }

  /**
   * Get API keys for external services
   */
  async getAPIKeys(service) {
    const path = this.secretPaths[`${service.toUpperCase()}_API_KEYS`];
    if (!path) {
      throw new Error(`Unknown API service: ${service}`);
    }

    return await this.vault.getSecret(path);
  }

  /**
   * Get encryption key for data protection
   */
  async getEncryptionKey(type = 'data') {
    const keyName =
      type === 'backup' ? 'BACKUP_ENCRYPTION_KEY' : 'DATA_ENCRYPTION_KEY';
    return await this.getSecret(keyName);
  }

  /**
   * Health check for Vault integration
   */
  async healthCheck() {
    try {
      const status = await this.vault.getStatus();
      return {
        healthy: status.initialized && !status.vault_status?.sealed,
        status: status,
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
      };
    }
  }

  /**
   * Get audit logs
   */
  getAuditLogs(limit = 50) {
    return this.vault.getAuditLogs(limit);
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    await this.vault.cleanup();
  }
}

// Export singleton instance
const vaultConfig = new VaultConfig();

module.exports = vaultConfig;
