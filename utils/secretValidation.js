/**
 * Environment-based Secret Management & Validation
 * Task 2.2: Implement secure secret management with validation
 */

const requiredSecrets = [
  'JWT_SECRET',
  'SESSION_SECRET',
  'DATABASE_URL',
  'POSTGRES_PASSWORD',
  'API_KEY_ENCRYPTION_KEY',
];

const optionalSecrets = [
  'PINATA_API_KEY',
  'PINATA_SECRET_KEY',
  'SONM_API_KEY',
  'REDIS_URL',
  'VAULT_TOKEN',
  'VAULT_ADDR',
];

/**
 * Validate that all required environment variables are present
 * Fails fast if any required secrets are missing
 */
function validateRequiredSecrets() {
  const missingSecrets = [];

  for (const secret of requiredSecrets) {
    if (!process.env[secret]) {
      missingSecrets.push(secret);
    }
  }

  if (missingSecrets.length > 0) {
    const errorMessage =
      `Missing required environment variables: ${missingSecrets.join(', ')}\n` +
      'Please set these environment variables before starting the application.\n' +
      'For development, create a .env file with these values.\n' +
      "For production, use your deployment platform's secret management.";

    console.error('🔴 SECURITY ERROR:', errorMessage);
    throw new Error(errorMessage);
  }

  console.log('✅ All required secrets validated');
}

/**
 * Validate secret strength and format
 */
function validateSecretStrength() {
  const warnings = [];

  // Check JWT secret strength
  const jwtSecret = process.env.JWT_SECRET;
  if (jwtSecret && jwtSecret.length < 32) {
    warnings.push('JWT_SECRET should be at least 32 characters long');
  }

  // Check session secret strength
  const sessionSecret = process.env.SESSION_SECRET;
  if (sessionSecret && sessionSecret.length < 32) {
    warnings.push('SESSION_SECRET should be at least 32 characters long');
  }

  // Warn about development secrets
  if (jwtSecret && jwtSecret.includes('development')) {
    warnings.push(
      'JWT_SECRET appears to be a development secret - use secure random value in production'
    );
  }

  if (sessionSecret && sessionSecret.includes('development')) {
    warnings.push(
      'SESSION_SECRET appears to be a development secret - use secure random value in production'
    );
  }

  if (warnings.length > 0) {
    console.warn('⚠️ SECRET WARNINGS:');
    warnings.forEach(warning => console.warn(`  - ${warning}`));
  }
}

/**
 * Get a secret with validation
 */
function getSecret(name, required = true) {
  const value = process.env[name];

  if (required && !value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }

  return value;
}

/**
 * Initialize secret management system
 */
function initializeSecrets() {
  console.log('🔐 Initializing secure secret management...');

  try {
    validateRequiredSecrets();
    validateSecretStrength();

    // Log available optional secrets (without values)
    const availableOptional = optionalSecrets.filter(
      secret => process.env[secret]
    );
    if (availableOptional.length > 0) {
      console.log(
        `📋 Optional secrets configured: ${availableOptional.join(', ')}`
      );
    }

    console.log('✅ Secret management initialized successfully');
    return true;
  } catch (error) {
    console.error('❌ Secret management initialization failed:', error.message);
    process.exit(1);
  }
}

/**
 * Generate secure random secret for development
 */
function generateSecureSecret(length = 64) {
  const crypto = require('crypto');
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Create development .env template
 */
function createEnvTemplate() {
  const template = `# Wrfcoin Environment Variables
# Copy this file to .env and fill in the values

# Required Secrets
JWT_SECRET=${generateSecureSecret(32)}
SESSION_SECRET=${generateSecureSecret(32)}
DATABASE_URL=postgresql://username:password@localhost:5432/wrfcoin
POSTGRES_PASSWORD=${generateSecureSecret(16)}
API_KEY_ENCRYPTION_KEY=${generateSecureSecret(32)}

# Optional Secrets
# PINATA_API_KEY=your_pinata_api_key
# PINATA_SECRET_KEY=your_pinata_secret_key
# SONM_API_KEY=your_sonm_api_key
# REDIS_URL=redis://localhost:6379
# VAULT_TOKEN=your_vault_token
# VAULT_ADDR=https://your-vault-instance.com

# Development Settings
NODE_ENV=development
PORT=3000
`;

  return template;
}

module.exports = {
  validateRequiredSecrets,
  validateSecretStrength,
  getSecret,
  initializeSecrets,
  generateSecureSecret,
  createEnvTemplate,
  requiredSecrets,
  optionalSecrets,
};
