/**
 * Axelar Integration Configuration
 *
 * This file contains configuration settings for the Axelar Amplifier integration.
 */

module.exports = {
  // Endpoints for main Axelar networks
  endpoints: {
    mainnet: 'https://axelar-mainnet.api.gmp.axelarscan.io',
    testnet: 'https://axelar-testnet.api.gmp.axelarscan.io',
    devnet: 'https://devnet.api.gmp.axelarscan.io',
  },

  // Supported chains in Axelar network
  supportedChains: {
    ethereum: {
      name: 'Ethereum',
      chainId: 1,
      rpc: 'https://ethereum.rpc.axelar.dev',
      gasService: '0x2d5d7d31F671F86C782533cc367F14109a082712',
      gateway: '0x4F4495243837681061C4743b74B3eEdf548D56A5',
    },
    polygon: {
      name: 'Polygon',
      chainId: 137,
      rpc: 'https://polygon.rpc.axelar.dev',
      gasService: '0x2d5d7d31F671F86C782533cc367F14109a082712',
      gateway: '0x6f015F16De9fC8791b234eF68D486d2bF203FBA8',
    },
    avalanche: {
      name: 'Avalanche',
      chainId: 43114,
      rpc: 'https://avalanche.rpc.axelar.dev',
      gasService: '0x2d5d7d31F671F86C782533cc367F14109a082712',
      gateway: '0x5029C0EFf6C34351a0CEc334542cDb22c7928f78',
    },
    binance: {
      name: 'BNB Chain',
      chainId: 56,
      rpc: 'https://binance.rpc.axelar.dev',
      gasService: '0x2d5d7d31F671F86C782533cc367F14109a082712',
      gateway: '0x304acf330bbE08d1e512eefaa92F6a57871fD895',
    },
    fantom: {
      name: 'Fantom',
      chainId: 250,
      rpc: 'https://fantom.rpc.axelar.dev',
      gasService: '0x2d5d7d31F671F86C782533cc367F14109a082712',
      gateway: '0x304acf330bbE08d1e512eefaa92F6a57871fD895',
    },
    arbitrum: {
      name: 'Arbitrum',
      chainId: 42161,
      rpc: 'https://arbitrum.rpc.axelar.dev',
      gasService: '0x2d5d7d31F671F86C782533cc367F14109a082712',
      gateway: '0xe432150cce91c13a887f7D836923d5597adD8E31',
    },
    optimism: {
      name: 'Optimism',
      chainId: 10,
      rpc: 'https://optimism.rpc.axelar.dev',
      gasService: '0x2d5d7d31F671F86C782533cc367F14109a082712',
      gateway: '0xe432150cce91c13a887f7D836923d5597adD8E31',
    },
    wrfcoin: {
      name: 'Wrfcoin',
      chainId: 9000,
      rpc: 'https://rpc.wrfcoin.dev',
      gasService: '0x2d5d7d31F671F86C782533cc367F14109a082712', // Placeholder, would need to be deployed
      gateway: '0xe432150cce91c13a887f7D836923d5597adD8E31', // Placeholder, would need to be deployed
    },
  },

  // Axelar GMP integration settings
  gmp: {
    apiBase: 'https://api.gmp.axelarscan.io',
    scanBase: 'https://axelarscan.io/gmp',
    gasMultiplier: 1.5, // Multiplier for estimating gas
    confirmations: {
      default: 1,
      ethereum: 12, // Ethereum requires more confirmations
      binance: 15,
    },
  },

  // Supported tokens on Axelar
  supportedTokens: {
    axlUSDC: {
      name: 'Axelar USDC',
      decimals: 6,
      symbol: 'axlUSDC',
      contracts: {
        ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        polygon: '0x750e4C4984a9e0f12978eA6742Bc1c5D248f40ed',
        avalanche: '0xfaB550568C688d5D8A52C7d794cb93Edc26eC0eC',
        binance: '0x4268B8F0B87b6Eae5d897996E6b845ddbD99Adf3',
        fantom: '0x1B6382DBDEa11d97f24495C9A90b7c88469134a4',
        arbitrum: '0xEB466342C4d449BC9f53A865D5Cb90586f405215',
        optimism: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607',
        wrfcoin: '0x750e4C4984a9e0f12978eA6742Bc1c5D248f40ed', // Placeholder, would need to be deployed
      },
    },
    axlWBTC: {
      name: 'Axelar Wrapped Bitcoin',
      decimals: 8,
      symbol: 'axlWBTC',
      contracts: {
        ethereum: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
        polygon: '0x86Bb63148d17d445Ed5Cd2Ea6B0270F3bDBB33A0',
        avalanche: '0x5817D4F0b62A59b17f75207DA1848C2cE75e7AF4',
        binance: '0x2fA5dAF6Fe0708fBD63b1A7D1592577284f52256',
        fantom: '0x448d59B4302aE566c9B7169d86Fc6Ef0E5fb9142',
        arbitrum: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
        optimism: '0x68f180fcCe6836688e9084f035309E29Bf0A2095',
        wrfcoin: '0x86Bb63148d17d445Ed5Cd2Ea6B0270F3bDBB33A0', // Placeholder, would need to be deployed
      },
    },
    WRF: {
      name: 'Wrfcoin',
      decimals: 18,
      symbol: 'WRF',
      contracts: {
        ethereum: '0x000000000000000000000000000000000000dEaD', // Placeholder, would need to be deployed
        polygon: '0x000000000000000000000000000000000000dEaD', // Placeholder, would need to be deployed
        avalanche: '0x000000000000000000000000000000000000dEaD', // Placeholder, would need to be deployed
        binance: '0x000000000000000000000000000000000000dEaD', // Placeholder, would need to be deployed
        fantom: '0x000000000000000000000000000000000000dEaD', // Placeholder, would need to be deployed
        arbitrum: '0x000000000000000000000000000000000000dEaD', // Placeholder, would need to be deployed
        optimism: '0x000000000000000000000000000000000000dEaD', // Placeholder, would need to be deployed
        wrfcoin: '0x000000000000000000000000000000000000dEaD', // Native token
      },
    },
  },

  // Connection settings
  connection: {
    timeout: 30000, // 30 seconds
    retryAttempts: 3,
    retryDelay: 2000, // 2 seconds
  },
};
