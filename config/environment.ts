/**
 * Environment Configuration Manager
 * Task 115.2: Unified environment configuration loader
 *
 * Loads environment-specific configuration based on WRFCOIN_ENV.
 * Supports: development, staging, production
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// Types
// ============================================================================

export type Environment = 'development' | 'staging' | 'production';

export interface ServerConfig {
  host: string;
  port: number;
  trustProxy: boolean;
  requestTimeout: number;
  keepAliveTimeout: number;
}

export interface DatabaseConfig {
  ssl: boolean;
  poolSize: number;
  connectionTimeout: number;
  idleTimeout: number;
  logging: boolean;
}

export interface RedisConfig {
  enabled: boolean;
  host: string;
  port: number;
  db: number;
  keyPrefix: string;
  tls?: boolean;
  cluster?: boolean;
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  format: 'json' | 'pretty';
  includeTimestamp: boolean;
  includeStackTrace: boolean;
  sensitiveDataMasking: boolean;
}

export interface RateLimitConfig {
  enabled: boolean;
  windowMs: number;
  max: number;
}

export interface CorsConfig {
  enabled: boolean;
  origins: string[];
  credentials: boolean;
}

export interface SecurityConfig {
  hsmRequired: boolean;
  mfaRequired: boolean;
  sessionDuration: number;
  rateLimit: RateLimitConfig;
  cors: CorsConfig;
}

export interface BlockchainConfig {
  network: 'mainnet' | 'testnet';
  confirmations: number;
  gasMultiplier: number;
  defaultGasLimit: number;
}

export interface FeaturesConfig {
  experimentalBridges: boolean;
  betaAiModels: boolean;
  newCarbonCalculation: boolean;
  physicsValidationProfile: 'realtime' | 'operational' | 'climate';
}

export interface IoTConfig {
  dataValidationLevel: 'relaxed' | 'moderate' | 'strict';
  sensorTimeout: number;
  maxDataAge: number;
}

export interface MonitoringConfig {
  metricsEnabled: boolean;
  tracingEnabled: boolean;
  healthCheckInterval: number;
}

export interface EnvironmentConfig {
  environment: Environment;
  description: string;
  server: ServerConfig;
  database: DatabaseConfig;
  redis: RedisConfig;
  logging: LoggingConfig;
  security: SecurityConfig;
  blockchain: BlockchainConfig;
  features: FeaturesConfig;
  iot: IoTConfig;
  monitoring: MonitoringConfig;
}

// ============================================================================
// Default Configuration
// ============================================================================

const defaultConfig: EnvironmentConfig = {
  environment: 'development',
  description: 'Default configuration',
  server: {
    host: '0.0.0.0',
    port: 4001,
    trustProxy: false,
    requestTimeout: 30000,
    keepAliveTimeout: 5000,
  },
  database: {
    ssl: false,
    poolSize: 10,
    connectionTimeout: 10000,
    idleTimeout: 30000,
    logging: true,
  },
  redis: {
    enabled: true,
    host: 'localhost',
    port: 6379,
    db: 0,
    keyPrefix: 'wrfcoin:',
  },
  logging: {
    level: 'debug',
    format: 'pretty',
    includeTimestamp: true,
    includeStackTrace: true,
    sensitiveDataMasking: true,
  },
  security: {
    hsmRequired: false,
    mfaRequired: false,
    sessionDuration: 86400,
    rateLimit: {
      enabled: true,
      windowMs: 60000,
      max: 1000,
    },
    cors: {
      enabled: true,
      origins: ['http://localhost:5000', 'http://localhost:3000'],
      credentials: true,
    },
  },
  blockchain: {
    network: 'testnet',
    confirmations: 6,
    gasMultiplier: 1.1,
    defaultGasLimit: 500000,
  },
  features: {
    experimentalBridges: false,
    betaAiModels: true,
    newCarbonCalculation: true,
    physicsValidationProfile: 'realtime',
  },
  iot: {
    dataValidationLevel: 'strict',
    sensorTimeout: 60000,
    maxDataAge: 3600000,
  },
  monitoring: {
    metricsEnabled: true,
    tracingEnabled: false,
    healthCheckInterval: 30000,
  },
};

// ============================================================================
// Configuration Loading
// ============================================================================

/**
 * Determine the current environment from WRFCOIN_ENV or NODE_ENV
 */
export function getEnvironment(): Environment {
  const wrfcoinEnv = process.env.WRFCOIN_ENV;
  const nodeEnv = process.env.NODE_ENV;

  // WRFCOIN_ENV takes precedence
  if (wrfcoinEnv) {
    if (['development', 'staging', 'production'].includes(wrfcoinEnv)) {
      return wrfcoinEnv as Environment;
    }
    console.warn(`Invalid WRFCOIN_ENV: ${wrfcoinEnv}, falling back to development`);
  }

  // Fall back to NODE_ENV mapping
  if (nodeEnv === 'production') {
    return 'production';
  }
  if (nodeEnv === 'staging' || nodeEnv === 'test') {
    return 'staging';
  }

  return 'development';
}

/**
 * Get the path to the config file for a given environment
 */
function getConfigPath(environment: Environment): string {
  // Project root is two levels up from backend/config/
  const projectRoot = path.resolve(__dirname, '../../..');
  return path.join(projectRoot, 'configs', environment, 'config.json');
}

/**
 * Load and parse a JSON config file
 */
function loadConfigFile(filePath: string): Partial<EnvironmentConfig> | null {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`Config file not found: ${filePath}`);
      return null;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`Failed to load config from ${filePath}:`, error);
    return null;
  }
}

/**
 * Deep merge two objects, with source taking precedence
 */
function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key];
      const targetValue = target[key];

      if (
        sourceValue !== null &&
        typeof sourceValue === 'object' &&
        !Array.isArray(sourceValue) &&
        targetValue !== null &&
        typeof targetValue === 'object' &&
        !Array.isArray(targetValue)
      ) {
        // Recursively merge nested objects
        result[key] = deepMerge(targetValue, sourceValue as any);
      } else if (sourceValue !== undefined) {
        result[key] = sourceValue as any;
      }
    }
  }

  return result;
}

/**
 * Load configuration for the current environment
 */
export function loadConfig(environment?: Environment): EnvironmentConfig {
  const env = environment || getEnvironment();
  const configPath = getConfigPath(env);

  // Load environment-specific config
  const envConfig = loadConfigFile(configPath);

  if (!envConfig) {
    console.warn(`Using default config for environment: ${env}`);
    return { ...defaultConfig, environment: env };
  }

  // Merge with defaults
  const mergedConfig = deepMerge(defaultConfig, envConfig);
  mergedConfig.environment = env;

  return mergedConfig;
}

// ============================================================================
// Singleton Configuration Instance
// ============================================================================

let cachedConfig: EnvironmentConfig | null = null;

/**
 * Get the configuration singleton
 * Loads config on first call and caches it
 */
export function getConfig(): EnvironmentConfig {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

/**
 * Reload configuration (useful for testing or dynamic reloads)
 */
export function reloadConfig(): EnvironmentConfig {
  cachedConfig = loadConfig();
  return cachedConfig;
}

/**
 * Check if running in production
 */
export function isProduction(): boolean {
  return getConfig().environment === 'production';
}

/**
 * Check if running in development
 */
export function isDevelopment(): boolean {
  return getConfig().environment === 'development';
}

/**
 * Check if running in staging
 */
export function isStaging(): boolean {
  return getConfig().environment === 'staging';
}

// ============================================================================
// Configuration Validation
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate the configuration for production readiness
 */
export function validateConfig(config?: EnvironmentConfig): ValidationResult {
  const cfg = config || getConfig();
  const errors: string[] = [];
  const warnings: string[] = [];

  // Production-specific validations
  if (cfg.environment === 'production') {
    if (!cfg.security.hsmRequired) {
      errors.push('HSM is required for production');
    }
    if (!cfg.security.mfaRequired) {
      errors.push('MFA is required for production');
    }
    if (cfg.database.logging) {
      warnings.push('Database logging should be disabled in production');
    }
    if (cfg.logging.includeStackTrace) {
      warnings.push('Stack traces should be disabled in production logs');
    }
    if (!cfg.logging.sensitiveDataMasking) {
      errors.push('Sensitive data masking must be enabled in production');
    }
    if (cfg.blockchain.network !== 'mainnet') {
      errors.push('Production must use mainnet blockchain network');
    }
    if (cfg.features.experimentalBridges) {
      warnings.push('Experimental bridges should be disabled in production');
    }
    if (cfg.features.betaAiModels) {
      warnings.push('Beta AI models should be disabled in production');
    }
  }

  // General validations
  if (cfg.server.port < 1 || cfg.server.port > 65535) {
    errors.push(`Invalid port number: ${cfg.server.port}`);
  }
  if (cfg.database.poolSize < 1) {
    errors.push(`Invalid database pool size: ${cfg.database.poolSize}`);
  }
  if (cfg.security.sessionDuration < 300) {
    warnings.push('Session duration is very short (< 5 minutes)');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ============================================================================
// Environment Variable Helpers
// ============================================================================

/**
 * Get a required environment variable or throw
 */
export function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * Get an optional environment variable with a default
 */
export function getEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

/**
 * Get an environment variable as a number
 */
export function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Get an environment variable as a boolean
 */
export function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

// ============================================================================
// Export Default Config Instance
// ============================================================================

export default getConfig();

// ============================================================================
// Production Guard
// ============================================================================

// Validate configuration at module load and fail fast in production if critical
// settings are missing or unsafe (#435).
(function enforceProductionSafety() {
  const result = validateConfig();
  if (!result.valid) {
    const msg = `FATAL: Configuration validation failed:\n  ${result.errors.join('\n  ')}`;
    if (getConfig().environment === 'production') {
      // Hard-fail in production so misconfigured deployments never start.
      console.error(msg);
      process.exit(1);
    } else {
      // Warn in other environments to catch issues during development.
      console.warn(msg);
    }
  }
  if (result.warnings.length > 0) {
    console.warn(`Config warnings:\n  ${result.warnings.join('\n  ')}`);
  }
}());
