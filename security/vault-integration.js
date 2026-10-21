/**
 * HashiCorp Vault Integration for Wrfcoin Platform
 * Provides secure secret management, dynamic secret rotation, and audit logging
 *
 * Features:
 * - Dynamic secret rotation
 * - Role-based access control
 * - Audit logging of all secret operations
 * - Multiple authentication methods
 * - Secret versioning and rollback
 */

const vault = require('node-vault');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// Use unified Winston logger for structured logging
const { securityLogger, logSecurityEvent } = require('../server/utils/logger.js');

class VaultIntegration {
  constructor() {
    this.client = null;
    this.isInitialized = false;
    this.auditLog = [];
    this.secretCache = new Map();
    this.rotationSchedule = new Map();
    this.accessPolicies = new Map();

    // Configuration from environment
    this.config = {
      endpoint: process.env.VAULT_ADDR || 'http://127.0.0.1:8200',
      token: process.env.VAULT_TOKEN,
      roleId: process.env.VAULT_ROLE_ID,
      secretId: process.env.VAULT_SECRET_ID,
      namespace: process.env.VAULT_NAMESPACE || 'wrfcoin',
      mountPath: process.env.VAULT_MOUNT_PATH || 'secret',
      authMethod: process.env.VAULT_AUTH_METHOD || 'token', // token, approle, kubernetes
      tlsSkipVerify: process.env.VAULT_SKIP_VERIFY === 'true',
      maxRetries: parseInt(process.env.VAULT_MAX_RETRIES) || 3,
      timeout: parseInt(process.env.VAULT_TIMEOUT) || 30000,
    };
  }

  /**
   * Initialize Vault connection with authentication
   */
  async initialize() {
    try {
      securityLogger.info('Initializing HashiCorp Vault integration', {
        operation: 'vault:initialize',
        endpoint: this.config.endpoint,
        namespace: this.config.namespace,
        authMethod: this.config.authMethod,
      });

      // Create Vault client
      this.client = vault({
        endpoint: this.config.endpoint,
        token: this.config.token,
        namespace: this.config.namespace,
        requestOptions: {
          timeout: this.config.timeout,
          rejectUnauthorized: !this.config.tlsSkipVerify,
        },
      });

      // Authenticate based on method
      await this.authenticate();

      // Verify connection
      await this.verifyConnection();

      // Initialize secret engines
      await this.setupSecretEngines();

      // Setup audit logging
      await this.setupAuditLogging();

      // Initialize rotation schedules
      await this.initializeRotationSchedules();

      this.isInitialized = true;
      securityLogger.info('Vault integration initialized successfully', {
        operation: 'vault:initialize',
        status: 'success',
      });

      this.logAuditEvent(
        'VAULT_INITIALIZED',
        'system',
        'Vault integration initialized'
      );

      return true;
    } catch (error) {
      securityLogger.error('Failed to initialize Vault integration', {
        operation: 'vault:initialize',
        error: { name: error.name, message: error.message },
      });
      throw new Error(`Vault initialization failed: ${error.message}`);
    }
  }

  /**
   * Authenticate with Vault using configured method
   */
  async authenticate() {
    switch (this.config.authMethod) {
      case 'token':
        await this.authenticateWithToken();
        break;
      case 'approle':
        await this.authenticateWithAppRole();
        break;
      case 'kubernetes':
        await this.authenticateWithKubernetes();
        break;
      default:
        throw new Error(
          `Unsupported authentication method: ${this.config.authMethod}`
        );
    }
  }

  /**
   * Token-based authentication
   */
  async authenticateWithToken() {
    if (!this.config.token) {
      throw new Error(
        'VAULT_TOKEN environment variable is required for token authentication'
      );
    }

    // Token is already set in client constructor
    // SECURITY: Never log the token value
    securityLogger.info('Authenticating with Vault token', {
      operation: 'vault:auth:token',
    });
  }

  /**
   * AppRole authentication
   */
  async authenticateWithAppRole() {
    if (!this.config.roleId || !this.config.secretId) {
      throw new Error(
        'VAULT_ROLE_ID and VAULT_SECRET_ID are required for AppRole authentication'
      );
    }

    // SECURITY: Never log roleId or secretId values
    securityLogger.info('Authenticating with AppRole', {
      operation: 'vault:auth:approle',
    });

    const result = await this.client.approleLogin({
      role_id: this.config.roleId,
      secret_id: this.config.secretId,
    });

    this.client.token = result.auth.client_token;
    securityLogger.info('AppRole authentication successful', {
      operation: 'vault:auth:approle',
      status: 'success',
    });
  }

  /**
   * Kubernetes authentication
   */
  async authenticateWithKubernetes() {
    try {
      const serviceToken = await fs.readFile(
        '/var/run/secrets/kubernetes.io/serviceaccount/token',
        'utf8'
      );

      const result = await this.client.kubernetesLogin({
        jwt: serviceToken,
        role: process.env.VAULT_K8S_ROLE || 'wrfcoin-app',
      });

      this.client.token = result.auth.client_token;
      securityLogger.info('Kubernetes authentication successful', {
        operation: 'vault:auth:kubernetes',
        status: 'success',
        role: process.env.VAULT_K8S_ROLE || 'wrfcoin-app',
      });
    } catch (error) {
      securityLogger.error('Kubernetes authentication failed', {
        operation: 'vault:auth:kubernetes',
        error: { name: error.name, message: error.message },
      });
      throw new Error(`Kubernetes authentication failed: ${error.message}`);
    }
  }

  /**
   * Verify Vault connection and permissions
   */
  async verifyConnection() {
    try {
      const health = await this.client.health();
      if (!health.initialized) {
        throw new Error('Vault is not initialized');
      }

      if (health.sealed) {
        throw new Error('Vault is sealed');
      }

      // Test token capabilities (do not log the token itself)
      const tokenInfo = await this.client.tokenLookupSelf();
      securityLogger.info('Token verified', {
        operation: 'vault:verify',
        ttl: tokenInfo.data.ttl,
        policies: tokenInfo.data.policies,
      });
    } catch (error) {
      securityLogger.error('Vault connection verification failed', {
        operation: 'vault:verify',
        error: { name: error.name, message: error.message },
      });
      throw new Error(`Vault connection verification failed: ${error.message}`);
    }
  }

  /**
   * Setup required secret engines
   */
  async setupSecretEngines() {
    try {
      // Enable KV v2 secret engine if not exists
      const mounts = await this.client.mounts();

      if (!mounts.data[`${this.config.mountPath}/`]) {
        await this.client.mount({
          mount_point: this.config.mountPath,
          type: 'kv',
          options: { version: '2' },
        });
        securityLogger.info('KV v2 secret engine enabled', {
          operation: 'vault:setup:kv',
          mountPath: this.config.mountPath,
        });
      }

      // Enable database secrets engine for dynamic credentials
      if (!mounts.data['database/']) {
        await this.client.mount({
          mount_point: 'database',
          type: 'database',
        });
        securityLogger.info('Database secrets engine enabled', {
          operation: 'vault:setup:database',
        });
      }
    } catch (error) {
      securityLogger.warn('Could not setup secret engines (may already exist)', {
        operation: 'vault:setup',
        error: { name: error.name, message: error.message },
      });
    }
  }

  /**
   * Setup audit logging
   */
  async setupAuditLogging() {
    try {
      const auditDevices = await this.client.auditList();

      if (!auditDevices.data['file/']) {
        await this.client.auditEnable({
          type: 'file',
          options: {
            file_path: '/vault/logs/audit.log',
          },
        });
        securityLogger.info('File audit logging enabled', {
          operation: 'vault:setup:audit',
          path: '/vault/logs/audit.log',
        });
      }
    } catch (error) {
      securityLogger.warn('Could not setup audit logging', {
        operation: 'vault:setup:audit',
        error: { name: error.name, message: error.message },
      });
    }
  }

  /**
   * Initialize secret rotation schedules
   */
  async initializeRotationSchedules() {
    // JWT secrets - rotate every 24 hours
    this.scheduleRotation('jwt-secret', 24 * 60 * 60 * 1000);

    // Database passwords - rotate every 7 days
    this.scheduleRotation('database-password', 7 * 24 * 60 * 60 * 1000);

    // API keys - rotate every 30 days
    this.scheduleRotation('api-keys', 30 * 24 * 60 * 60 * 1000);

    securityLogger.info('Secret rotation schedules initialized', {
      operation: 'vault:rotation:init',
      schedules: ['jwt-secret', 'database-password', 'api-keys'],
    });
  }

  /**
   * Store a secret in Vault
   */
  async storeSecret(path, secretData, metadata = {}) {
    this.ensureInitialized();

    try {
      const fullPath = `${this.config.mountPath}/data/${path}`;

      const result = await this.client.write(fullPath, {
        data: secretData,
        metadata: {
          created_by: 'wrfcoin-platform',
          created_at: new Date().toISOString(),
          ...metadata,
        },
      });

      this.logAuditEvent('SECRET_STORED', 'system', `Secret stored at ${path}`);

      // Update cache
      this.secretCache.set(path, {
        data: secretData,
        version: result.data.version,
        created_time: result.data.created_time,
      });

      return result;
    } catch (error) {
      this.logAuditEvent(
        'SECRET_STORE_FAILED',
        'system',
        `Failed to store secret at ${path}: ${error.message}`
      );
      throw new Error(`Failed to store secret: ${error.message}`);
    }
  }

  /**
   * Retrieve a secret from Vault
   */
  async getSecret(path, version = null) {
    this.ensureInitialized();

    try {
      // Check cache first
      const cached = this.secretCache.get(path);
      if (cached && !version) {
        this.logAuditEvent(
          'SECRET_RETRIEVED_CACHE',
          'system',
          `Secret retrieved from cache: ${path}`
        );
        return cached.data;
      }

      const fullPath = `${this.config.mountPath}/data/${path}`;
      const options = version ? { version } : {};

      const result = await this.client.read(fullPath, options);

      if (!result || !result.data || !result.data.data) {
        throw new Error(`Secret not found at path: ${path}`);
      }

      this.logAuditEvent(
        'SECRET_RETRIEVED',
        'system',
        `Secret retrieved: ${path}`
      );

      // Update cache
      this.secretCache.set(path, {
        data: result.data.data,
        version: result.data.metadata.version,
        created_time: result.data.metadata.created_time,
      });

      return result.data.data;
    } catch (error) {
      this.logAuditEvent(
        'SECRET_RETRIEVAL_FAILED',
        'system',
        `Failed to retrieve secret ${path}: ${error.message}`
      );
      throw new Error(`Failed to retrieve secret: ${error.message}`);
    }
  }

  /**
   * Generate dynamic database credentials
   */
  async getDynamicDBCredentials(role = 'readonly') {
    this.ensureInitialized();

    try {
      const result = await this.client.read(`database/creds/${role}`);

      this.logAuditEvent(
        'DYNAMIC_CREDS_GENERATED',
        'system',
        `Dynamic DB credentials generated for role: ${role}`
      );

      return {
        username: result.data.username,
        password: result.data.password,
        lease_id: result.lease_id,
        lease_duration: result.lease_duration,
      };
    } catch (error) {
      this.logAuditEvent(
        'DYNAMIC_CREDS_FAILED',
        'system',
        `Failed to generate dynamic credentials: ${error.message}`
      );
      throw new Error(
        `Failed to generate dynamic credentials: ${error.message}`
      );
    }
  }

  /**
   * Rotate a secret
   */
  async rotateSecret(path, generator = null) {
    this.ensureInitialized();

    try {
      securityLogger.info('Rotating secret', {
        operation: 'vault:secret:rotate',
        path,
      });

      // Get current secret for backup
      let currentSecret = null;
      try {
        currentSecret = await this.getSecret(path);
      } catch (error) {
        // Secret might not exist yet
      }

      // Generate new secret value
      let newSecret;
      if (generator && typeof generator === 'function') {
        newSecret = await generator();
      } else {
        newSecret = this.generateSecureSecret();
      }

      // Store new secret
      await this.storeSecret(
        path,
        { value: newSecret },
        {
          rotated_at: new Date().toISOString(),
          previous_version: currentSecret ? 'backed_up' : 'none',
        }
      );

      // Store previous version as backup if it existed
      if (currentSecret) {
        await this.storeSecret(`${path}_backup`, currentSecret, {
          backup_of: path,
          backed_up_at: new Date().toISOString(),
        });
      }

      this.logAuditEvent('SECRET_ROTATED', 'system', `Secret rotated: ${path}`);

      return newSecret;
    } catch (error) {
      this.logAuditEvent(
        'SECRET_ROTATION_FAILED',
        'system',
        `Secret rotation failed for ${path}: ${error.message}`
      );
      throw new Error(`Secret rotation failed: ${error.message}`);
    }
  }

  /**
   * Schedule automatic secret rotation
   */
  scheduleRotation(path, intervalMs, generator = null) {
    if (this.rotationSchedule.has(path)) {
      clearInterval(this.rotationSchedule.get(path));
    }

    const interval = setInterval(async () => {
      try {
        await this.rotateSecret(path, generator);
        securityLogger.info('Automatic rotation completed', {
          operation: 'vault:secret:rotate:auto',
          path,
          status: 'success',
        });
      } catch (error) {
        securityLogger.error('Automatic rotation failed', {
          operation: 'vault:secret:rotate:auto',
          path,
          error: { name: error.name, message: error.message },
        });
      }
    }, intervalMs);

    this.rotationSchedule.set(path, interval);
    securityLogger.info('Rotation scheduled', {
      operation: 'vault:rotation:schedule',
      path,
      intervalSeconds: intervalMs / 1000,
    });
  }

  /**
   * Generate a cryptographically secure secret
   */
  generateSecureSecret(length = 64) {
    return crypto.randomBytes(length).toString('base64');
  }

  /**
   * Create or update access policy
   */
  async createPolicy(name, policy) {
    this.ensureInitialized();

    try {
      await this.client.addPolicy({
        name,
        policy,
      });

      this.accessPolicies.set(name, policy);
      this.logAuditEvent(
        'POLICY_CREATED',
        'system',
        `Access policy created: ${name}`
      );

      securityLogger.info('Access policy created', {
        operation: 'vault:policy:create',
        policyName: name,
      });
    } catch (error) {
      this.logAuditEvent(
        'POLICY_CREATION_FAILED',
        'system',
        `Failed to create policy ${name}: ${error.message}`
      );
      throw new Error(`Failed to create policy: ${error.message}`);
    }
  }

  /**
   * Revoke a lease (for dynamic secrets)
   */
  async revokeLease(leaseId) {
    this.ensureInitialized();

    try {
      await this.client.revoke({ lease_id: leaseId });
      this.logAuditEvent(
        'LEASE_REVOKED',
        'system',
        `Lease revoked: ${leaseId}`
      );
    } catch (error) {
      this.logAuditEvent(
        'LEASE_REVOCATION_FAILED',
        'system',
        `Failed to revoke lease ${leaseId}: ${error.message}`
      );
      throw new Error(`Failed to revoke lease: ${error.message}`);
    }
  }

  /**
   * Get audit logs
   */
  getAuditLogs(limit = 100) {
    return this.auditLog.slice(-limit).reverse();
  }

  /**
   * Log audit event
   */
  logAuditEvent(action, user, details) {
    const event = {
      timestamp: new Date().toISOString(),
      action,
      user,
      details,
      session_id: this.generateSessionId(),
    };

    this.auditLog.push(event);

    // Keep only last 1000 events in memory
    if (this.auditLog.length > 1000) {
      this.auditLog = this.auditLog.slice(-1000);
    }

    // Log audit events to structured logger (without sensitive data)
    logSecurityEvent(action, { details, sessionId: event.session_id }, 'info');
  }

  /**
   * Generate session ID for audit tracking
   */
  generateSessionId() {
    return crypto.randomBytes(8).toString('hex');
  }

  /**
   * Ensure Vault is initialized
   */
  ensureInitialized() {
    if (!this.isInitialized) {
      throw new Error(
        'Vault integration not initialized. Call initialize() first.'
      );
    }
  }

  /**
   * Get Vault status and health information
   */
  async getStatus() {
    try {
      const health = await this.client.health();
      const tokenInfo = await this.client.tokenLookupSelf();

      return {
        initialized: this.isInitialized,
        vault_status: {
          sealed: health.sealed,
          standby: health.standby,
          version: health.version,
        },
        token_info: {
          ttl: tokenInfo.data.ttl,
          policies: tokenInfo.data.policies,
          renewable: tokenInfo.data.renewable,
        },
        cache_size: this.secretCache.size,
        scheduled_rotations: this.rotationSchedule.size,
        audit_events: this.auditLog.length,
      };
    } catch (error) {
      return {
        initialized: this.isInitialized,
        error: error.message,
      };
    }
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    securityLogger.info('Cleaning up Vault integration', {
      operation: 'vault:cleanup',
    });

    // Clear rotation schedules
    for (const [path, interval] of this.rotationSchedule) {
      clearInterval(interval);
    }
    this.rotationSchedule.clear();

    // Clear cache
    this.secretCache.clear();

    // Log cleanup
    this.logAuditEvent(
      'VAULT_CLEANUP',
      'system',
      'Vault integration cleaned up'
    );

    this.isInitialized = false;
    securityLogger.info('Vault integration cleanup completed', {
      operation: 'vault:cleanup',
      status: 'success',
    });
  }
}

module.exports = VaultIntegration;
