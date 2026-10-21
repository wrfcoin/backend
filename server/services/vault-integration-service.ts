/**
 * HashiCorp Vault Integration Service for File Permissions
 * Manages secure storage and retrieval of permission keys and encryption secrets
 */

import * as crypto from 'crypto';
import axios, { AxiosInstance } from 'axios';
import { logger } from '../../utils/logger.js';

export interface VaultConfig {
  endpoint: string;
  token: string;
  mount: string;
  namespace?: string;
}

export interface PermissionKey {
  keyId: string;
  purpose: 'FILE_ENCRYPTION' | 'PERMISSION_SIGNING' | 'SHARE_TOKEN_ENCRYPTION';
  algorithm: string;
  keyData: string;
  metadata: Record<string, any>;
  createdAt: Date;
  expiresAt?: Date;
}

export interface VaultSecret {
  path: string;
  data: Record<string, any>;
  metadata?: Record<string, any>;
  version?: number;
}

export class VaultIntegrationService {
  private client: AxiosInstance;
  private config: VaultConfig;
  private isInitialized: boolean = false;

  constructor() {
    this.config = {
      endpoint: process.env.VAULT_ENDPOINT || 'http://localhost:8200',
      token: process.env.VAULT_TOKEN || '',
      mount: process.env.VAULT_MOUNT || 'secret',
      namespace: process.env.VAULT_NAMESPACE,
    };

    this.client = axios.create({
      baseURL: this.config.endpoint,
      headers: {
        'X-Vault-Token': this.config.token,
        'Content-Type': 'application/json',
        ...(this.config.namespace && {
          'X-Vault-Namespace': this.config.namespace,
        }),
      },
      timeout: 10000,
    });

    this.setupInterceptors();
  }

  /**
   * Initialize the Vault service
   */
  async initialize(): Promise<void> {
    try {
      logger.info('[Vault] Initializing Vault integration service');

      // Test connection to Vault
      await this.healthCheck();

      // Ensure required secret paths exist
      await this.ensureSecretPaths();

      this.isInitialized = true;
      logger.info('[Vault] Vault integration service initialized successfully');
    } catch (error) {
      logger.error('[Vault] Failed to initialize Vault service', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Health check for Vault connection
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.client.get('/v1/sys/health');
      const isHealthy = response.status === 200 && !response.data.sealed;

      if (!isHealthy) {
        logger.warn('[Vault] Vault is not healthy', {
          status: response.status,
          data: response.data,
        });
      }

      return isHealthy;
    } catch (error) {
      logger.error('[Vault] Vault health check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Store a permission key securely in Vault
   */
  async storePermissionKey(
    keyId: string,
    permissionKey: PermissionKey
  ): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('Vault service not initialized');
    }

    try {
      const secretPath = `file-permissions/keys/${keyId}`;

      const secretData = {
        data: {
          keyId: permissionKey.keyId,
          purpose: permissionKey.purpose,
          algorithm: permissionKey.algorithm,
          keyData: permissionKey.keyData,
          metadata: permissionKey.metadata,
          createdAt: permissionKey.createdAt.toISOString(),
          expiresAt: permissionKey.expiresAt?.toISOString(),
        },
        options: {
          max_versions: 5,
        },
      };

      await this.client.post(
        `/v1/${this.config.mount}/data/${secretPath}`,
        secretData
      );

      logger.info('[Vault] Permission key stored successfully', {
        keyId,
        purpose: permissionKey.purpose,
      });
    } catch (error) {
      logger.error('[Vault] Error storing permission key', {
        keyId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Retrieve a permission key from Vault
   */
  async getPermissionKey(keyId: string): Promise<PermissionKey | null> {
    if (!this.isInitialized) {
      throw new Error('Vault service not initialized');
    }

    try {
      const secretPath = `file-permissions/keys/${keyId}`;
      const response = await this.client.get(
        `/v1/${this.config.mount}/data/${secretPath}`
      );

      if (!response.data?.data?.data) {
        return null;
      }

      const secretData = response.data.data.data;

      return {
        keyId: secretData.keyId,
        purpose: secretData.purpose,
        algorithm: secretData.algorithm,
        keyData: secretData.keyData,
        metadata: secretData.metadata || {},
        createdAt: new Date(secretData.createdAt),
        expiresAt: secretData.expiresAt
          ? new Date(secretData.expiresAt)
          : undefined,
      };
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }

      logger.error('[Vault] Error retrieving permission key', {
        keyId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Generate and store a new encryption key for file protection
   */
  async generateFileEncryptionKey(
    fileId: string,
    metadata?: Record<string, any>
  ): Promise<PermissionKey> {
    const keyId = `file_${fileId}_${crypto.randomBytes(8).toString('hex')}`;
    const keyData = crypto.randomBytes(32).toString('base64');

    const permissionKey: PermissionKey = {
      keyId,
      purpose: 'FILE_ENCRYPTION',
      algorithm: 'AES-256-GCM',
      keyData,
      metadata: {
        fileId,
        ...metadata,
      },
      createdAt: new Date(),
    };

    await this.storePermissionKey(keyId, permissionKey);
    return permissionKey;
  }

  /**
   * Generate and store a signing key for permission tokens
   */
  async generatePermissionSigningKey(purpose: string): Promise<PermissionKey> {
    const keyId = `perm_sign_${crypto.randomBytes(8).toString('hex')}`;
    const keyPair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem',
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem',
      },
    });

    const permissionKey: PermissionKey = {
      keyId,
      purpose: 'PERMISSION_SIGNING',
      algorithm: 'RSA-2048',
      keyData: JSON.stringify({
        privateKey: keyPair.privateKey,
        publicKey: keyPair.publicKey,
      }),
      metadata: {
        purpose,
        keyType: 'RSA_PAIR',
      },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
    };

    await this.storePermissionKey(keyId, permissionKey);
    return permissionKey;
  }

  /**
   * Encrypt sensitive data using a specific key
   */
  async encryptData(keyId: string, data: string): Promise<string> {
    const key = await this.getPermissionKey(keyId);
    if (!key) {
      throw new Error(`Encryption key not found: ${keyId}`);
    }

    if (
      key.purpose !== 'FILE_ENCRYPTION' &&
      key.purpose !== 'SHARE_TOKEN_ENCRYPTION'
    ) {
      throw new Error(`Key ${keyId} is not suitable for encryption`);
    }

    try {
      const algorithm = 'aes-256-gcm';
      const keyBuffer = Buffer.from(key.keyData, 'base64');
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv(algorithm, keyBuffer, iv);

      cipher.setAAD(Buffer.from(keyId)); // Additional authenticated data

      let encrypted = cipher.update(data, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      const authTag = cipher.getAuthTag();

      // Combine IV, auth tag, and encrypted data
      const result =
        iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;

      return Buffer.from(result).toString('base64');
    } catch (error) {
      logger.error('[Vault] Error encrypting data', {
        keyId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Decrypt sensitive data using a specific key
   */
  async decryptData(keyId: string, encryptedData: string): Promise<string> {
    const key = await this.getPermissionKey(keyId);
    if (!key) {
      throw new Error(`Decryption key not found: ${keyId}`);
    }

    try {
      const algorithm = 'aes-256-gcm';
      const keyBuffer = Buffer.from(key.keyData, 'base64');
      const decoded = Buffer.from(encryptedData, 'base64').toString();

      const [ivHex, authTagHex, encrypted] = decoded.split(':');
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');

      const decipher = crypto.createDecipheriv(algorithm, keyBuffer, iv);
      decipher.setAuthTag(authTag);
      decipher.setAAD(Buffer.from(keyId));

      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      logger.error('[Vault] Error decrypting data', {
        keyId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Sign permission token using RSA key
   */
  async signPermissionToken(
    keyId: string,
    payload: Record<string, any>
  ): Promise<string> {
    const key = await this.getPermissionKey(keyId);
    if (!key || key.purpose !== 'PERMISSION_SIGNING') {
      throw new Error(`Signing key not found or invalid: ${keyId}`);
    }

    try {
      const keyPair = JSON.parse(key.keyData);
      const dataToSign = JSON.stringify(payload);

      const signature = crypto.sign(
        'sha256',
        Buffer.from(dataToSign),
        keyPair.privateKey
      );

      return signature.toString('base64');
    } catch (error) {
      logger.error('[Vault] Error signing permission token', {
        keyId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Verify permission token signature
   */
  async verifyPermissionToken(
    keyId: string,
    payload: Record<string, any>,
    signature: string
  ): Promise<boolean> {
    const key = await this.getPermissionKey(keyId);
    if (!key || key.purpose !== 'PERMISSION_SIGNING') {
      return false;
    }

    try {
      const keyPair = JSON.parse(key.keyData);
      const dataToVerify = JSON.stringify(payload);

      return crypto.verify(
        'sha256',
        Buffer.from(dataToVerify),
        keyPair.publicKey,
        Buffer.from(signature, 'base64')
      );
    } catch (error) {
      logger.error('[Vault] Error verifying permission token', {
        keyId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Rotate a permission key
   */
  async rotatePermissionKey(keyId: string): Promise<PermissionKey> {
    const existingKey = await this.getPermissionKey(keyId);
    if (!existingKey) {
      throw new Error(`Key not found for rotation: ${keyId}`);
    }

    // Create new key with same properties
    const newKeyId = `${keyId}_rotated_${Date.now()}`;
    let newKeyData: string;

    switch (existingKey.purpose) {
      case 'FILE_ENCRYPTION':
      case 'SHARE_TOKEN_ENCRYPTION':
        newKeyData = crypto.randomBytes(32).toString('base64');
        break;

      case 'PERMISSION_SIGNING':
        const keyPair = crypto.generateKeyPairSync('rsa', {
          modulusLength: 2048,
          publicKeyEncoding: { type: 'spki', format: 'pem' },
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });
        newKeyData = JSON.stringify({
          privateKey: keyPair.privateKey,
          publicKey: keyPair.publicKey,
        });
        break;

      default:
        throw new Error(
          `Unsupported key purpose for rotation: ${existingKey.purpose}`
        );
    }

    const newKey: PermissionKey = {
      keyId: newKeyId,
      purpose: existingKey.purpose,
      algorithm: existingKey.algorithm,
      keyData: newKeyData,
      metadata: {
        ...existingKey.metadata,
        rotatedFrom: keyId,
        rotationDate: new Date().toISOString(),
      },
      createdAt: new Date(),
      expiresAt: existingKey.expiresAt,
    };

    await this.storePermissionKey(newKeyId, newKey);

    logger.info('[Vault] Permission key rotated successfully', {
      oldKeyId: keyId,
      newKeyId,
      purpose: newKey.purpose,
    });

    return newKey;
  }

  /**
   * List all permission keys with optional filtering
   */
  async listPermissionKeys(
    purpose?: PermissionKey['purpose']
  ): Promise<string[]> {
    try {
      const response = await this.client.get(
        `/v1/${this.config.mount}/metadata/file-permissions/keys`,
        {
          params: { list: true },
        }
      );

      let keys = response.data?.data?.keys || [];

      if (purpose) {
        // Filter keys by purpose (requires individual key lookups)
        const filteredKeys: string[] = [];
        for (const keyId of keys) {
          const key = await this.getPermissionKey(keyId);
          if (key && key.purpose === purpose) {
            filteredKeys.push(keyId);
          }
        }
        keys = filteredKeys;
      }

      return keys;
    } catch (error) {
      logger.error('[Vault] Error listing permission keys', {
        purpose,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Setup axios interceptors for error handling and logging
   */
  private setupInterceptors(): void {
    this.client.interceptors.request.use(
      config => {
        logger.debug('[Vault] Making request', {
          method: config.method,
          url: config.url,
        });
        return config;
      },
      error => {
        logger.error('[Vault] Request error', { error: error.message });
        return Promise.reject(error);
      }
    );

    this.client.interceptors.response.use(
      response => {
        logger.debug('[Vault] Response received', {
          status: response.status,
          url: response.config.url,
        });
        return response;
      },
      error => {
        logger.error('[Vault] Response error', {
          status: error.response?.status,
          url: error.config?.url,
          error: error.message,
        });
        return Promise.reject(error);
      }
    );
  }

  /**
   * Ensure required secret paths exist
   */
  private async ensureSecretPaths(): Promise<void> {
    const requiredPaths = [
      'file-permissions/keys',
      'file-permissions/tokens',
      'file-permissions/config',
    ];

    for (const path of requiredPaths) {
      try {
        await this.client.get(`/v1/${this.config.mount}/metadata/${path}`);
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 404) {
          // Path doesn't exist, create it by storing a dummy secret
          await this.client.post(
            `/v1/${this.config.mount}/data/${path}/.init`,
            {
              data: { initialized: true, createdAt: new Date().toISOString() },
            }
          );
          logger.info('[Vault] Created secret path', { path });
        }
      }
    }
  }
}

export const vaultIntegrationService = new VaultIntegrationService();
