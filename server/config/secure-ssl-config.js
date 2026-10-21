/**
 * Secure SSL/TLS Configuration Module
 * Provides production-grade SSL configuration for database and service connections
 *
 * SECURITY: This module enforces strict certificate validation to prevent
 * man-in-the-middle attacks. All production connections MUST validate certificates.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { securityLogger } = require('../utils/logger');

/**
 * Minimum TLS version - TLS 1.2 is required for security compliance
 */
const MIN_TLS_VERSION = 'TLSv1.2';

/**
 * Secure cipher suites for TLS connections
 * Excludes weak ciphers and prioritizes forward secrecy
 */
const SECURE_CIPHERS = [
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'TLS_AES_128_GCM_SHA256',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-RSA-CHACHA20-POLY1305',
].join(':');

/**
 * Load certificate file safely with validation
 * @param {string} envVar - Environment variable name containing the cert path or content
 * @param {string} description - Description for error messages
 * @returns {string|undefined} Certificate content or undefined
 */
function loadCertificate(envVar, description) {
  const value = process.env[envVar];
  if (!value) {
    return undefined;
  }

  // Check if it's a file path or the certificate content itself
  if (value.includes('-----BEGIN')) {
    // It's the certificate content directly
    return value;
  }

  // It's a file path - read the file
  try {
    const certPath = path.resolve(value);
    if (!fs.existsSync(certPath)) {
      securityLogger.warn('Certificate file not found', { module: 'SSLConfig', description, certPath });
      return undefined;
    }
    return fs.readFileSync(certPath, 'utf8');
  } catch (error) {
    securityLogger.error('Error loading certificate', { module: 'SSLConfig', description, error: error.message });
    return undefined;
  }
}

/**
 * Create secure SSL configuration for PostgreSQL connections
 * CRITICAL: Always enables rejectUnauthorized in production
 *
 * @param {Object} options - Configuration options
 * @param {boolean} options.requireCerts - Whether to require client certificates
 * @param {string} options.caEnvVar - Environment variable for CA certificate
 * @param {string} options.certEnvVar - Environment variable for client certificate
 * @param {string} options.keyEnvVar - Environment variable for client private key
 * @returns {Object|false} SSL configuration object or false for development
 */
function createDatabaseSSLConfig(options = {}) {
  const {
    requireCerts = false,
    caEnvVar = 'DB_CA_CERT',
    certEnvVar = 'DB_CLIENT_CERT',
    keyEnvVar = 'DB_CLIENT_KEY',
  } = options;

  // In development without SSL requirement, disable SSL
  if (process.env.NODE_ENV !== 'production' && !process.env.FORCE_SSL) {
    securityLogger.info('SSL disabled in development mode', { module: 'SSLConfig', hint: 'Set FORCE_SSL=true to enable' });
    return false;
  }

  // Production: Always require strict certificate validation
  const sslConfig = {
    // CRITICAL: Always true in production to prevent MITM attacks
    rejectUnauthorized: true,
    minVersion: MIN_TLS_VERSION,
  };

  // Load CA certificate if provided
  const caCert = loadCertificate(caEnvVar, 'CA certificate');
  if (caCert) {
    sslConfig.ca = caCert;
  } else if (process.env.NODE_ENV === 'production') {
    // In production, warn if no CA cert is provided
    // The system CA store will be used as fallback
    console.warn(
      '[SSL Config] Warning: No CA certificate provided. Using system CA store.'
    );
  }

  // Load client certificates if required or provided
  const clientCert = loadCertificate(certEnvVar, 'client certificate');
  const clientKey = loadCertificate(keyEnvVar, 'client private key');

  if (clientCert && clientKey) {
    sslConfig.cert = clientCert;
    sslConfig.key = clientKey;
  } else if (requireCerts) {
    throw new Error(
      '[SSL Config] Client certificates required but not provided'
    );
  }

  return sslConfig;
}

/**
 * Create secure SSL configuration for Redis connections
 * @param {Object} options - Configuration options
 * @returns {Object|undefined} TLS configuration object or undefined
 */
function createRedisSSLConfig(options = {}) {
  const {
    caEnvVar = 'REDIS_CA_CERT',
    certEnvVar = 'REDIS_CLIENT_CERT',
    keyEnvVar = 'REDIS_CLIENT_KEY',
  } = options;

  if (process.env.NODE_ENV !== 'production' && !process.env.FORCE_SSL) {
    return undefined;
  }

  const tlsConfig = {
    rejectUnauthorized: true,
    minVersion: MIN_TLS_VERSION,
  };

  const caCert = loadCertificate(caEnvVar, 'Redis CA certificate');
  if (caCert) {
    tlsConfig.ca = caCert;
  }

  const clientCert = loadCertificate(certEnvVar, 'Redis client certificate');
  const clientKey = loadCertificate(keyEnvVar, 'Redis client key');

  if (clientCert && clientKey) {
    tlsConfig.cert = clientCert;
    tlsConfig.key = clientKey;
  }

  return tlsConfig;
}

/**
 * Create secure HTTPS agent configuration for external API calls
 * @param {Object} options - Configuration options
 * @param {string} options.hostname - Target hostname for certificate pinning
 * @param {string} options.pinnedCertFingerprint - Expected SHA256 fingerprint for cert pinning
 * @returns {Object} HTTPS agent options
 */
function createHTTPSAgentConfig(options = {}) {
  const { hostname, pinnedCertFingerprint } = options;

  const agentOptions = {
    rejectUnauthorized: true,
    minVersion: MIN_TLS_VERSION,
    ciphers: SECURE_CIPHERS,
    secureOptions:
      crypto.constants.SSL_OP_NO_SSLv2 |
      crypto.constants.SSL_OP_NO_SSLv3 |
      crypto.constants.SSL_OP_NO_TLSv1 |
      crypto.constants.SSL_OP_NO_TLSv1_1,
  };

  // Certificate pinning if fingerprint provided
  if (hostname && pinnedCertFingerprint) {
    agentOptions.checkServerIdentity = (host, cert) => {
      // Verify hostname matches
      if (host !== hostname) {
        return new Error(`Hostname mismatch: expected ${hostname}, got ${host}`);
      }

      // Verify certificate fingerprint
      const fingerprint = cert.fingerprint256
        .toLowerCase()
        .replace(/:/g, '');
      const expected = pinnedCertFingerprint.toLowerCase().replace(/:/g, '');

      if (fingerprint !== expected) {
        return new Error(
          `Certificate pin mismatch for ${hostname}: expected ${expected}, got ${fingerprint}`
        );
      }

      return undefined; // No error
    };
  }

  return agentOptions;
}

/**
 * Validate SSL configuration for security compliance
 * @param {Object} sslConfig - SSL configuration to validate
 * @returns {Object} Validation result with isValid and issues array
 */
function validateSSLConfig(sslConfig) {
  const issues = [];

  if (!sslConfig) {
    return {
      isValid: process.env.NODE_ENV !== 'production',
      issues:
        process.env.NODE_ENV === 'production'
          ? ['SSL is disabled in production']
          : [],
    };
  }

  // Check rejectUnauthorized
  if (sslConfig.rejectUnauthorized !== true) {
    issues.push(
      'CRITICAL: rejectUnauthorized must be true to prevent MITM attacks'
    );
  }

  // Check minimum TLS version
  if (sslConfig.minVersion) {
    const versionOrder = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'];
    const configVersionIndex = versionOrder.indexOf(sslConfig.minVersion);
    const requiredVersionIndex = versionOrder.indexOf(MIN_TLS_VERSION);

    if (configVersionIndex < requiredVersionIndex) {
      issues.push(
        `Minimum TLS version ${sslConfig.minVersion} is below required ${MIN_TLS_VERSION}`
      );
    }
  }

  return {
    isValid: issues.length === 0,
    issues,
  };
}

/**
 * Get SSL configuration status for health checks
 * @returns {Object} SSL configuration status
 */
function getSSLStatus() {
  return {
    environment: process.env.NODE_ENV || 'development',
    sslEnabled: process.env.NODE_ENV === 'production' || !!process.env.FORCE_SSL,
    minTLSVersion: MIN_TLS_VERSION,
    hasCACert: !!process.env.DB_CA_CERT,
    hasClientCert: !!process.env.DB_CLIENT_CERT,
    hasClientKey: !!process.env.DB_CLIENT_KEY,
    hasRedisCACert: !!process.env.REDIS_CA_CERT,
    strictValidation: true,
  };
}

module.exports = {
  createDatabaseSSLConfig,
  createRedisSSLConfig,
  createHTTPSAgentConfig,
  validateSSLConfig,
  getSSLStatus,
  loadCertificate,
  MIN_TLS_VERSION,
  SECURE_CIPHERS,
};
