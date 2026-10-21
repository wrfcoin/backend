/**
 * Wrfcoin Configuration Loader
 *
 * This file loads the appropriate configuration based on the environment.
 * It defaults to testnet during development unless explicitly set to mainnet.
 */

const mainnetConfig = require('./mainnet');
const testnetConfig = require('./testnet');

// Determine which network configuration to use
// Default to testnet for development unless explicitly set to mainnet
const getNetworkType = () => {
  // Check environment variables
  if (process.env.WRFCOIN_NETWORK === 'mainnet') {
    return 'mainnet';
  }

  // Check command line arguments
  const args = process.argv.slice(2);
  if (args.includes('--mainnet')) {
    return 'mainnet';
  }

  // Default to testnet
  return 'testnet';
};

// Merge configurations with optional overrides
const mergeConfigurations = (baseConfig, overrides = {}) => {
  return {
    ...baseConfig,
    ...overrides,
    // Deep merge for nested objects if needed
    network: {
      ...baseConfig.network,
      ...(overrides.network || {}),
    },
    mining: {
      ...baseConfig.mining,
      ...(overrides.mining || {}),
    },
    transactions: {
      ...baseConfig.transactions,
      ...(overrides.transactions || {}),
    },
    p2p: {
      ...baseConfig.p2p,
      ...(overrides.p2p || {}),
    },
    logging: {
      ...baseConfig.logging,
      ...(overrides.logging || {}),
    },
  };
};

// Load configuration with optional overrides
const loadConfiguration = (overrides = {}) => {
  const networkType = getNetworkType();
  console.log(`Loading Wrfcoin configuration for network: ${networkType}`);

  const baseConfig = networkType === 'mainnet' ? mainnetConfig : testnetConfig;
  return mergeConfigurations(baseConfig, overrides);
};

// Export configuration loader
module.exports = {
  loadConfiguration,
  getNetworkType,
};
