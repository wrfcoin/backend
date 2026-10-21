import vault from 'node-vault';
import { logger } from '../utils/logger.js';
import { requireEnv } from '../../config/environment.js';

// Configuration object that will hold all secrets
interface AppSecrets {
  database: {
    url: string;
    password: string;
  };
  jwt: {
    secret: string;
    refreshSecret: string;
  };
  encryption: {
    key: string;
  };
  external: {
    s3AccessKey: string;
    s3SecretKey: string;
    clamavHost: string;
    blockchainRpcUrl: string;
  };
  api: {
    perplexityKey?: string;
    openaiKey?: string;
    anthropicKey?: string;
  };
}

// In-memory secrets store (populated at startup)
let appSecrets: AppSecrets | null = null;

// Vault client instance
let vaultClient: any = null;

export async function initializeSecrets(): Promise<void> {
  try {
    logger.info('[Secrets] Initializing secrets management...');

    // Initialize Vault client
    vaultClient = vault({
      apiVersion: 'v1',
      endpoint: process.env.VAULT_ADDR || 'http://localhost:8200',
      token: process.env.VAULT_TOKEN, // For dev/testing
    });

    // For production, use AppRole authentication
    if (process.env.VAULT_ROLE_ID && process.env.VAULT_SECRET_ID) {
      await authenticateWithAppRole();
    } else if (!process.env.VAULT_TOKEN) {
      throw new Error(
        'Either VAULT_TOKEN or VAULT_ROLE_ID/VAULT_SECRET_ID must be provided'
      );
    }

    // Fetch all required secrets
    await fetchSecrets();

    logger.info('[Secrets] Secrets loaded successfully');
  } catch (error) {
    logger.error('[Secrets] Failed to initialize secrets', {
      error: error instanceof Error ? error.message : String(error),
    });

    // In development, fall back to environment variables
    if (process.env.NODE_ENV === 'development') {
      logger.warn(
        '[Secrets] Falling back to environment variables for development'
      );
      loadFromEnvironment();
    } else {
      // In production, fail fast if secrets cannot be loaded
      process.exit(1);
    }
  }
}

async function authenticateWithAppRole(): Promise<void> {
  try {
    const roleId = process.env.VAULT_ROLE_ID!;
    const secretId = process.env.VAULT_SECRET_ID!;

    logger.debug('[Secrets] Authenticating with Vault AppRole');

    const result = await vaultClient.approleLogin({
      role_id: roleId,
      secret_id: secretId,
    });

    // Set the token for subsequent requests
    vaultClient.token = result.auth.client_token;

    logger.debug('[Secrets] Successfully authenticated with Vault');
  } catch (error) {
    throw new Error(
      `Vault AppRole authentication failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function fetchSecrets(): Promise<void> {
  try {
    // Define secret paths for different environments
    const environment = process.env.NODE_ENV || 'development';
    const basePath = `secret/data/wrfcoin/${environment}`;

    // Fetch database secrets
    const dbSecrets = await vaultClient.read(`${basePath}/database`);

    // Fetch JWT secrets
    const jwtSecrets = await vaultClient.read(`${basePath}/jwt`);

    // Fetch encryption secrets
    const encSecrets = await vaultClient.read(`${basePath}/encryption`);

    // Fetch external service secrets
    const extSecrets = await vaultClient.read(`${basePath}/external`);

    // Fetch API keys (optional, may not exist)
    let apiSecrets;
    try {
      apiSecrets = await vaultClient.read(`${basePath}/api`);
    } catch (error) {
      logger.warn('[Secrets] API secrets not found, continuing without them');
      apiSecrets = { data: { data: {} } };
    }

    // Populate the secrets object
    appSecrets = {
      database: {
        url: dbSecrets.data.data.url,
        password: dbSecrets.data.data.password,
      },
      jwt: {
        secret: jwtSecrets.data.data.secret,
        refreshSecret: jwtSecrets.data.data.refresh_secret,
      },
      encryption: {
        key: encSecrets.data.data.key,
      },
      external: {
        s3AccessKey: extSecrets.data.data.s3_access_key,
        s3SecretKey: extSecrets.data.data.s3_secret_key,
        clamavHost: extSecrets.data.data.clamav_host,
        blockchainRpcUrl: extSecrets.data.data.blockchain_rpc_url,
      },
      api: {
        perplexityKey: apiSecrets.data.data.perplexity_key,
        openaiKey: apiSecrets.data.data.openai_key,
        anthropicKey: apiSecrets.data.data.anthropic_key,
      },
    };

    // Validate required secrets
    validateSecrets();

    // Freeze the object to prevent modifications
    Object.freeze(appSecrets);
  } catch (error) {
    throw new Error(
      `Failed to fetch secrets from Vault: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function loadFromEnvironment(): void {
  logger.warn('[Secrets] Loading secrets from environment variables');

  // SECURITY: In production, all secrets MUST come from environment variables
  // or Vault. Dev fallback defaults must NEVER be used in production.
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL must be set in production');
    }
    if (!process.env.ENCRYPTION_KEY) {
      throw new Error('ENCRYPTION_KEY must be set in production');
    }
  }

  appSecrets = {
    database: {
      url: process.env.DATABASE_URL || 'postgresql://localhost:5432/wrfcoin',
      password: requireEnv('DB_PASSWORD'),
    },
    jwt: {
      secret: (() => {
        const secret = process.env.JWT_SECRET;
        if (!secret) {
          throw new Error('JWT_SECRET environment variable is required');
        }
        return secret;
      })(),
      refreshSecret: (() => {
        const refreshSecret = process.env.JWT_REFRESH_SECRET;
        if (!refreshSecret) {
          throw new Error(
            'JWT_REFRESH_SECRET environment variable is required'
          );
        }
        return refreshSecret;
      })(),
    },
    encryption: {
      key: (() => {
        const key = process.env.ENCRYPTION_KEY;
        if (!key) {
          throw new Error(
            'ENCRYPTION_KEY environment variable is required. Refusing to use a development fallback.'
          );
        }
        return key;
      })(),
    },
    external: {
      s3AccessKey: process.env.AWS_ACCESS_KEY_ID || '',
      s3SecretKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      clamavHost: process.env.CLAMAV_HOST || 'localhost',
      blockchainRpcUrl:
        process.env.BLOCKCHAIN_RPC_URL || 'http://localhost:8080',
    },
    api: {
      perplexityKey: process.env.PERPLEXITY_API_KEY,
      openaiKey: process.env.OPENAI_API_KEY,
      anthropicKey: process.env.ANTHROPIC_API_KEY,
    },
  };

  validateSecrets();
  Object.freeze(appSecrets);
}

export function validateSecrets(): void {
  if (!appSecrets) {
    throw new Error('Secrets not loaded');
  }

  const requiredSecrets = [
    'database.url',
    'database.password',
    'jwt.secret',
    'jwt.refreshSecret',
    'encryption.key',
  ];
  const requiredEnvVars = [
    'WRFCOIN_OPERATOR_TOKEN', // core4 auth token — must be set at startup (#485)
  ];

  for (const secretPath of requiredSecrets) {
    const value = getNestedValue(appSecrets, secretPath);
    if (!value || (typeof value === 'string' && value.trim() === '')) {
      throw new Error(`Required secret missing: ${secretPath}`);
    }
  }

  for (const envVarName of requiredEnvVars) {
    const value = process.env[envVarName];
    if (!value || value.trim() === '') {
      throw new Error(`Required environment variable missing: ${envVarName}`);
    }
  }

  // Validate secret formats
  if (appSecrets.encryption.key.length < 32) {
    throw new Error('Encryption key must be at least 32 characters long');
  }

  if (appSecrets.jwt.secret.length < 16) {
    throw new Error('JWT secret must be at least 16 characters long');
  }

  logger.debug('[Secrets] All required secrets validated successfully');
}

function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((current, key) => current && current[key], obj);
}

// Public interface for accessing secrets
export function getSecrets(): AppSecrets {
  if (!appSecrets) {
    throw new Error('Secrets not initialized. Call initializeSecrets() first.');
  }
  return appSecrets;
}

// Helper functions for specific secret types
export function getDatabaseConfig() {
  const secrets = getSecrets();
  // SECURITY: Return connection URL only. The password is embedded in the URL.
  // Do not expose the raw password separately - it increases the risk of
  // accidental logging or serialization of sensitive credentials.
  return {
    url: secrets.database.url,
  };
}

export function getJWTConfig() {
  const secrets = getSecrets();
  return {
    secret: secrets.jwt.secret,
    refreshSecret: secrets.jwt.refreshSecret,
  };
}

export function getEncryptionKey(): string {
  const secrets = getSecrets();
  return secrets.encryption.key;
}

export function getS3Config() {
  const secrets = getSecrets();
  return {
    accessKeyId: secrets.external.s3AccessKey,
    secretAccessKey: secrets.external.s3SecretKey,
  };
}

export function getExternalServiceConfig() {
  const secrets = getSecrets();
  return {
    clamavHost: secrets.external.clamavHost,
    blockchainRpcUrl: secrets.external.blockchainRpcUrl,
  };
}

export function getAPIKeys() {
  const secrets = getSecrets();
  return {
    perplexity: secrets.api.perplexityKey,
    openai: secrets.api.openaiKey,
    anthropic: secrets.api.anthropicKey,
  };
}

// Secret rotation functions
export async function rotateSecret(
  secretPath: string,
  newValue: string
): Promise<void> {
  try {
    if (!vaultClient) {
      throw new Error('Vault client not initialized');
    }

    // Update secret in Vault
    const environment = process.env.NODE_ENV || 'development';
    const basePath = `secret/data/wrfcoin/${environment}`;

    // This is a simplified example - in practice, you'd need more sophisticated rotation logic
    await vaultClient.write(`${basePath}/temp`, { [secretPath]: newValue });

    logger.info('[Secrets] Secret rotated successfully', { secretPath });
  } catch (error) {
    logger.error('[Secrets] Secret rotation failed', {
      secretPath,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// Health check for secrets system
export function checkSecretsHealth(): { healthy: boolean; message: string } {
  try {
    if (!appSecrets) {
      return { healthy: false, message: 'Secrets not initialized' };
    }

    // Check if all critical secrets are available
    validateSecrets();

    return { healthy: true, message: 'All secrets are healthy' };
  } catch (error) {
    return {
      healthy: false,
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
