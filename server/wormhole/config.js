/**
 * Wormhole Configuration for Wrfcoin
 *
 * This module provides configuration values for the Wormhole integration,
 * including network endpoints, contract addresses, and supported chains.
 *
 * Required environment variables:
 *   WORMHOLE_EVM_RPC_URL     - RPC endpoint for EVM chains
 *   WORMHOLE_SOLANA_RPC_URL  - RPC endpoint for Solana
 *   WORMHOLE_GUARDIAN_RPC    - RPC endpoint for the Wormhole Guardian network
 */

const REQUIRED_ENV_VARS = [
  'WORMHOLE_EVM_RPC_URL',
  'WORMHOLE_SOLANA_RPC_URL',
  'WORMHOLE_GUARDIAN_RPC',
];

/**
 * Validate that required environment variables are set.
 * @throws {Error} If any required env var is missing
 */
function validateEnvVars() {
  const missing = REQUIRED_ENV_VARS.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required Wormhole environment variables: ${missing.join(', ')}. ` +
        'Set these before using the Wormhole bridge.'
    );
  }
}

/**
 * Network configurations for different environments
 */
const networks = {
  mainnet: {
    endpoint: 'https://wormhole-v2-mainnet-api.wormhole.com',
    coreBridge: '0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B',
    tokenBridge: '0x3ee18B2214AFF97000D974cf647E7C347E8fa585',
    nftBridge: '0x6FFd7EdE62328b3Af38FCD61461Bbfc52F5651fE',
  },
  testnet: {
    endpoint: 'https://wormhole-v2-testnet-api.wormhole.com',
    coreBridge: '0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78',
    tokenBridge: '0x7b18698094851df265Bf9e4605A1A2035c694eb4',
    nftBridge: '0x26b4afb60d6c903165150c6f0aa14f8016be4aec',
  },
  devnet: {
    endpoint: 'https://wormhole-v2-devnet-api.wormhole.com',
    coreBridge: '0xC89Ce4735882C9F0f0FE26686c53074E09B0D550',
    tokenBridge: '0x0290FB167208Af455bB137780163b7B7a9a10C16',
    nftBridge: '0x26b4afb60d6c903165150c6f0aa14f8016be4aec',
  },
};

/**
 * Supported chains configuration
 */
const chains = {
  ethereum: {
    id: 2,
    name: 'Ethereum',
    rpc: {
      mainnet: process.env.WORMHOLE_EVM_RPC_URL || '',
      testnet: process.env.WORMHOLE_EVM_RPC_URL || '',
      devnet: process.env.DEVNET_RPC_URL || 'http://localhost:8545',
    },
    nativeCurrency: 'ETH',
    nativeDecimals: 18,
    contracts: {
      mainnet: {
        coreBridge: '0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B',
        tokenBridge: '0x3ee18B2214AFF97000D974cf647E7C347E8fa585',
        nftBridge: '0x6FFd7EdE62328b3Af38FCD61461Bbfc52F5651fE',
      },
      testnet: {
        coreBridge: '0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78',
        tokenBridge: '0x7b18698094851df265Bf9e4605A1A2035c694eb4',
        nftBridge: '0x26b4afb60d6c903165150c6f0aa14f8016be4aec',
      },
    },
  },
  solana: {
    id: 1,
    name: 'Solana',
    rpc: {
      mainnet: process.env.WORMHOLE_SOLANA_RPC_URL || '',
      testnet: process.env.WORMHOLE_SOLANA_RPC_URL || '',
      devnet: 'https://api.devnet.solana.com',
    },
    nativeCurrency: 'SOL',
    nativeDecimals: 9,
    contracts: {
      mainnet: {
        coreBridge: 'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth',
        tokenBridge: 'wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb',
        nftBridge: 'WnFt12ZrnzZrFZkt2xsNsaNWoQribnuQ5B5FrDbwDhD',
      },
      testnet: {
        coreBridge: 'WormT3McKhFJ2RkiGpdw9GKvqEWiSPU3i2Rmp2jhUNY',
        tokenBridge: 'DZnkkTmCiFWfYTfT9N1Et5XZCy7XJAbNU3jdkGCXsqJF',
        nftBridge: 'A3KDsSDrUYMNxvq3qSQkiysCRnqvmZjEZSFHwMpghtvF',
      },
    },
  },
  polygon: {
    id: 5,
    name: 'Polygon',
    rpc: {
      mainnet: 'https://polygon-rpc.com',
      testnet: 'https://rpc-mumbai.maticvigil.com',
      devnet: process.env.DEVNET_RPC_URL || 'http://localhost:8545',
    },
    nativeCurrency: 'MATIC',
    nativeDecimals: 18,
    contracts: {
      mainnet: {
        coreBridge: '0x7A4B5a56256163F07b2C80A7cA55aBE66c4ec4d7',
        tokenBridge: '0x5a58505a96D1dbf8dF91cB21B54419FC36e93fdE',
        nftBridge: '0x90BBd86a6Fe93D3bc3ed6335935447E75fAb7fCf',
      },
      testnet: {
        coreBridge: '0x0CBE91CF822c73C2315FB05100C2F714765d5c20',
        tokenBridge: '0x377D55a7928c046E18eEbb61977e714d2a76472a',
        nftBridge: '0x51a02d0dcb5e52F5b92bdAA38FA013C91c7309A9',
      },
    },
  },
  bsc: {
    id: 4,
    name: 'Binance Smart Chain',
    rpc: {
      mainnet: 'https://bsc-dataseed.binance.org',
      testnet: 'https://data-seed-prebsc-1-s1.binance.org:8545',
      devnet: process.env.DEVNET_RPC_URL || 'http://localhost:8545',
    },
    nativeCurrency: 'BNB',
    nativeDecimals: 18,
    contracts: {
      mainnet: {
        coreBridge: '0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B',
        tokenBridge: '0xB6F6D86a8f9879A9c87f643768d9efc38c1Da6E7',
        nftBridge: '0x5a58505a96D1dbf8dF91cB21B54419FC36e93fdE',
      },
      testnet: {
        coreBridge: '0x68605AD7b15c732a30b1BbC62BE8F2A509D74b4D',
        tokenBridge: '0x9dcF9D205C9De35334D646BeE44b2D2859712A09',
        nftBridge: '0xcD16E5613EF35599dc82B24Cb45B5A93D779f1EE',
      },
    },
  },
  avalanche: {
    id: 6,
    name: 'Avalanche',
    rpc: {
      mainnet: 'https://api.avax.network/ext/bc/C/rpc',
      testnet: 'https://api.avax-test.network/ext/bc/C/rpc',
      devnet: process.env.DEVNET_RPC_URL || 'http://localhost:8545',
    },
    nativeCurrency: 'AVAX',
    nativeDecimals: 18,
    contracts: {
      mainnet: {
        coreBridge: '0x54a8e5f9c4CbA08F9943965859F6c34eAF03E26c',
        tokenBridge: '0x0e082F06FF657D94310cB8cE8B0D9a04541d8052',
        nftBridge: '0xf7B6737Ca9c4e08aE573F75A97B73D7a813f5De5',
      },
      testnet: {
        coreBridge: '0x7bbcE28e64B3F8b84d876Ab298393c38ad7aac4C',
        tokenBridge: '0x61E44E506Ca5659E6c0bba9b678586FA2d729756',
        nftBridge: '0xD601BAf2EEE3C028344471684F6b27E789D9075D',
      },
    },
  },
  wrfcoin: {
    id: 31337, // Custom chain ID for Wrfcoin
    name: 'Wrfcoin',
    rpc: {
      mainnet: 'https://rpc.wrfcoin.example/mainnet',
      testnet: 'https://rpc.wrfcoin.example/testnet',
      devnet: process.env.DEVNET_RPC_URL || 'http://localhost:8545',
    },
    nativeCurrency: 'WRF',
    nativeDecimals: 18,
    contracts: {
      mainnet: {
        coreBridge: '0x54a8e5f9c4CbA08F9943965859F6c34eAF03E26c',
        tokenBridge: '0x0e082F06FF657D94310cB8cE8B0D9a04541d8052',
        nftBridge: '0xf7B6737Ca9c4e08aE573F75A97B73D7a813f5De5',
      },
      testnet: {
        coreBridge: '0x7bbcE28e64B3F8b84d876Ab298393c38ad7aac4C',
        tokenBridge: '0x61E44E506Ca5659E6c0bba9b678586FA2d729756',
        nftBridge: '0xD601BAf2EEE3C028344471684F6b27E789D9075D',
      },
    },
  },
};

/**
 * Supported tokens for cross-chain transfers
 */
const tokens = {
  USDC: {
    name: 'USD Coin',
    symbol: 'USDC',
    decimals: 6,
    addresses: {
      ethereum: {
        mainnet: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        testnet: '0x07865c6e87b9f70255377e024ace6630c1eaa37f',
      },
      solana: {
        mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        testnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      },
      polygon: {
        mainnet: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
        testnet: '0x0fa8781a83e46826621b3bc094ea2a0212e71b23',
      },
      bsc: {
        mainnet: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
        testnet: '0x64544969ed7EBf5f083679233325356EbE738930',
      },
      avalanche: {
        mainnet: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
        testnet: '0x5425890298aed601595a70AB815c96711a31Bc65',
      },
      wrfcoin: {
        mainnet: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        testnet: '0x07865c6e87b9f70255377e024ace6630c1eaa37f',
      },
    },
  },
  USDT: {
    name: 'Tether USD',
    symbol: 'USDT',
    decimals: 6,
    addresses: {
      ethereum: {
        mainnet: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        testnet: '0x110a13FC3efE6A245B50102D2d79B3E76125Ae83',
      },
      solana: {
        mainnet: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        testnet: '8jpHL5TjMZma2AnNfk8FEXzJQYHPJrj3moyVyW1wGofM',
      },
      polygon: {
        mainnet: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
        testnet: '0x3813e82e6f7098b9583FC0F33a962D02018B6803',
      },
      bsc: {
        mainnet: '0x55d398326f99059fF775485246999027B3197955',
        testnet: '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd',
      },
      avalanche: {
        mainnet: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
        testnet: '0x134Dc38AE8C853D1aa2103d5047591acDAA16682',
      },
      wrfcoin: {
        mainnet: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        testnet: '0x110a13FC3efE6A245B50102D2d79B3E76125Ae83',
      },
    },
  },
  WRF: {
    name: 'Wrfcoin',
    symbol: 'WRF',
    decimals: 18,
    addresses: {
      ethereum: {
        mainnet: '0x7a58c0Be72BE218B41C608b7Fe7C5bB630736C71',
        testnet: '0x123456789abcdef123456789abcdef123456789a',
      },
      solana: {
        mainnet: 'wrfnFU4jQBnRsZV3yeahTQYnwEtxpJiHNVQpvG5qUXA',
        testnet: 'wrftEST4jQBnRsZV3yeahTQYnwEtxpJiHNVQpvGtest',
      },
      polygon: {
        mainnet: '0x7a58c0Be72BE218B41C608b7Fe7C5bB630736C71',
        testnet: '0x123456789abcdef123456789abcdef123456789a',
      },
      bsc: {
        mainnet: '0x7a58c0Be72BE218B41C608b7Fe7C5bB630736C71',
        testnet: '0x123456789abcdef123456789abcdef123456789a',
      },
      avalanche: {
        mainnet: '0x7a58c0Be72BE218B41C608b7Fe7C5bB630736C71',
        testnet: '0x123456789abcdef123456789abcdef123456789a',
      },
      wrfcoin: {
        mainnet: '0x0000000000000000000000000000000000000000', // Native token
        testnet: '0x0000000000000000000000000000000000000000', // Native token
      },
    },
  },
};

/**
 * Fee configuration for different operation types
 */
const fees = {
  TOKEN_TRANSFER: {
    base: 0.01, // Base fee in USD equivalent
    percentage: 0.1, // 0.1% of the transferred amount
    minFee: 0.5, // Minimum fee in USD equivalent
    maxFee: 100, // Maximum fee in USD equivalent
  },
  NFT_TRANSFER: {
    base: 0.02, // Base fee in USD equivalent
    percentage: 0, // No percentage fee for NFT transfers
    minFee: 1, // Minimum fee in USD equivalent
    maxFee: 50, // Maximum fee in USD equivalent
  },
  MESSAGE: {
    base: 0.005, // Base fee in USD equivalent
    byteMultiplier: 0.0001, // Fee per byte of message payload
    minFee: 0.01, // Minimum fee in USD equivalent
    maxFee: 10, // Maximum fee in USD equivalent
  },
};

module.exports = {
  REQUIRED_ENV_VARS,
  validateEnvVars,
  networks,
  chains,
  tokens,
  fees,
  // Get a specific chain configuration
  getChain: (chainName) => chains[chainName.toLowerCase()] || null,
  // Get token configuration by symbol
  getToken: (tokenSymbol) => tokens[tokenSymbol.toUpperCase()] || null,
  // Get fee configuration for an operation type
  getFee: (operationType) => fees[operationType] || null,
  // Get the network configuration for the specified environment
  getNetwork: (network) => networks[network] || networks.testnet,
};
