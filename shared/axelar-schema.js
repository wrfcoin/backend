/**
 * Database Schema for Axelar Bridge Integration
 *
 * This file defines the database schema for the Axelar Amplifier bridge service.
 */

// Define tables for storing Axelar-related data
const AXELAR_TABLES = {
  // Table for storing cross-chain transfers via Axelar
  axelar_transfers: `
    CREATE TABLE IF NOT EXISTS axelar_transfers (
      id SERIAL PRIMARY KEY,
      transaction_id VARCHAR(255) NOT NULL,
      user_id INTEGER,
      metadata JSONB,
      source_chain VARCHAR(50) NOT NULL,
      destination_chain VARCHAR(50) NOT NULL,
      sender_address VARCHAR(255) NOT NULL,
      recipient_address VARCHAR(255) NOT NULL,
      token_address VARCHAR(255),
      token_type VARCHAR(50) NOT NULL,
      token_id VARCHAR(255),
      amount VARCHAR(255),
      fee VARCHAR(255),
      gas_used INTEGER,
      bridge_id VARCHAR(50) NOT NULL,
      relayer_address VARCHAR(255),
      oracle_signatures JSONB,
      source_tx_hash VARCHAR(255),
      destination_tx_hash VARCHAR(255),
      verification_proof TEXT,
      status VARCHAR(50) NOT NULL,
      error_message TEXT,
      timestamp TIMESTAMP NOT NULL,
      completed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT axelar_transfers_transaction_id_unique UNIQUE (transaction_id)
    )
  `,

  // Table for storing Axelar GMP (General Message Passing) messages
  axelar_messages: `
    CREATE TABLE IF NOT EXISTS axelar_messages (
      id SERIAL PRIMARY KEY,
      message_id VARCHAR(255) NOT NULL,
      user_id INTEGER,
      metadata JSONB,
      source_chain VARCHAR(50) NOT NULL,
      destination_chain VARCHAR(50) NOT NULL,
      sender_address VARCHAR(255) NOT NULL,
      receiver_address VARCHAR(255) NOT NULL,
      contract_address VARCHAR(255),
      message_type VARCHAR(50) NOT NULL,
      message_content TEXT,
      gas_used INTEGER,
      fee VARCHAR(255),
      source_tx_hash VARCHAR(255),
      destination_tx_hash VARCHAR(255),
      status VARCHAR(50) NOT NULL,
      error_message TEXT,
      timestamp TIMESTAMP NOT NULL,
      completed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT axelar_messages_message_id_unique UNIQUE (message_id)
    )
  `,

  // Table for storing supported chains in the Axelar network
  axelar_chains: `
    CREATE TABLE IF NOT EXISTS axelar_chains (
      id SERIAL PRIMARY KEY,
      chain_id VARCHAR(50) NOT NULL,
      name VARCHAR(100) NOT NULL,
      rpc_url VARCHAR(255),
      gateway_address VARCHAR(255),
      gas_service_address VARCHAR(255),
      token_addresses JSONB,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT axelar_chains_chain_id_unique UNIQUE (chain_id)
    )
  `,

  // Table for storing supported tokens in the Axelar network
  axelar_tokens: `
    CREATE TABLE IF NOT EXISTS axelar_tokens (
      id SERIAL PRIMARY KEY,
      symbol VARCHAR(50) NOT NULL,
      name VARCHAR(100) NOT NULL,
      decimals INTEGER NOT NULL,
      addresses JSONB,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT axelar_tokens_symbol_unique UNIQUE (symbol)
    )
  `,
};

// Define seed data for Axelar chains
const AXELAR_CHAINS_SEED = [
  {
    chain_id: 'ethereum',
    name: 'Ethereum',
    rpc_url: 'https://ethereum.rpc.axelar.dev',
    gateway_address: '0x4F4495243837681061C4743b74B3eEdf548D56A5',
    gas_service_address: '0x2d5d7d31F671F86C782533cc367F14109a082712',
    token_addresses: {
      axlUSDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      axlWBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    },
    is_active: true,
  },
  {
    chain_id: 'polygon',
    name: 'Polygon',
    rpc_url: 'https://polygon.rpc.axelar.dev',
    gateway_address: '0x6f015F16De9fC8791b234eF68D486d2bF203FBA8',
    gas_service_address: '0x2d5d7d31F671F86C782533cc367F14109a082712',
    token_addresses: {
      axlUSDC: '0x750e4C4984a9e0f12978eA6742Bc1c5D248f40ed',
      axlWBTC: '0x86Bb63148d17d445Ed5Cd2Ea6B0270F3bDBB33A0',
    },
    is_active: true,
  },
  {
    chain_id: 'avalanche',
    name: 'Avalanche',
    rpc_url: 'https://avalanche.rpc.axelar.dev',
    gateway_address: '0x5029C0EFf6C34351a0CEc334542cDb22c7928f78',
    gas_service_address: '0x2d5d7d31F671F86C782533cc367F14109a082712',
    token_addresses: {
      axlUSDC: '0xfaB550568C688d5D8A52C7d794cb93Edc26eC0eC',
      axlWBTC: '0x5817D4F0b62A59b17f75207DA1848C2cE75e7AF4',
    },
    is_active: true,
  },
  {
    chain_id: 'binance',
    name: 'BNB Chain',
    rpc_url: 'https://binance.rpc.axelar.dev',
    gateway_address: '0x304acf330bbE08d1e512eefaa92F6a57871fD895',
    gas_service_address: '0x2d5d7d31F671F86C782533cc367F14109a082712',
    token_addresses: {
      axlUSDC: '0x4268B8F0B87b6Eae5d897996E6b845ddbD99Adf3',
      axlWBTC: '0x2fA5dAF6Fe0708fBD63b1A7D1592577284f52256',
    },
    is_active: true,
  },
  {
    chain_id: 'fantom',
    name: 'Fantom',
    rpc_url: 'https://fantom.rpc.axelar.dev',
    gateway_address: '0x304acf330bbE08d1e512eefaa92F6a57871fD895',
    gas_service_address: '0x2d5d7d31F671F86C782533cc367F14109a082712',
    token_addresses: {
      axlUSDC: '0x1B6382DBDEa11d97f24495C9A90b7c88469134a4',
      axlWBTC: '0x448d59B4302aE566c9B7169d86Fc6Ef0E5fb9142',
    },
    is_active: true,
  },
  {
    chain_id: 'arbitrum',
    name: 'Arbitrum',
    rpc_url: 'https://arbitrum.rpc.axelar.dev',
    gateway_address: '0xe432150cce91c13a887f7D836923d5597adD8E31',
    gas_service_address: '0x2d5d7d31F671F86C782533cc367F14109a082712',
    token_addresses: {
      axlUSDC: '0xEB466342C4d449BC9f53A865D5Cb90586f405215',
      axlWBTC: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
    },
    is_active: true,
  },
  {
    chain_id: 'optimism',
    name: 'Optimism',
    rpc_url: 'https://optimism.rpc.axelar.dev',
    gateway_address: '0xe432150cce91c13a887f7D836923d5597adD8E31',
    gas_service_address: '0x2d5d7d31F671F86C782533cc367F14109a082712',
    token_addresses: {
      axlUSDC: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607',
      axlWBTC: '0x68f180fcCe6836688e9084f035309E29Bf0A2095',
    },
    is_active: true,
  },
  {
    chain_id: 'wrfcoin',
    name: 'Wrfcoin',
    rpc_url: 'https://rpc.wrfcoin.dev',
    gateway_address: '0xe432150cce91c13a887f7D836923d5597adD8E31',
    gas_service_address: '0x2d5d7d31F671F86C782533cc367F14109a082712',
    token_addresses: {
      axlUSDC: '0x750e4C4984a9e0f12978eA6742Bc1c5D248f40ed',
      axlWBTC: '0x86Bb63148d17d445Ed5Cd2Ea6B0270F3bDBB33A0',
    },
    is_active: true,
  },
];

// Define seed data for Axelar tokens
const AXELAR_TOKENS_SEED = [
  {
    symbol: 'axlUSDC',
    name: 'Axelar USDC',
    decimals: 6,
    addresses: {
      ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      polygon: '0x750e4C4984a9e0f12978eA6742Bc1c5D248f40ed',
      avalanche: '0xfaB550568C688d5D8A52C7d794cb93Edc26eC0eC',
      binance: '0x4268B8F0B87b6Eae5d897996E6b845ddbD99Adf3',
      fantom: '0x1B6382DBDEa11d97f24495C9A90b7c88469134a4',
      arbitrum: '0xEB466342C4d449BC9f53A865D5Cb90586f405215',
      optimism: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607',
      wrfcoin: '0x750e4C4984a9e0f12978eA6742Bc1c5D248f40ed',
    },
    is_active: true,
  },
  {
    symbol: 'axlWBTC',
    name: 'Axelar Wrapped Bitcoin',
    decimals: 8,
    addresses: {
      ethereum: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
      polygon: '0x86Bb63148d17d445Ed5Cd2Ea6B0270F3bDBB33A0',
      avalanche: '0x5817D4F0b62A59b17f75207DA1848C2cE75e7AF4',
      binance: '0x2fA5dAF6Fe0708fBD63b1A7D1592577284f52256',
      fantom: '0x448d59B4302aE566c9B7169d86Fc6Ef0E5fb9142',
      arbitrum: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
      optimism: '0x68f180fcCe6836688e9084f035309E29Bf0A2095',
      wrfcoin: '0x86Bb63148d17d445Ed5Cd2Ea6B0270F3bDBB33A0',
    },
    is_active: true,
  },
  {
    symbol: 'WRF',
    name: 'Wrfcoin',
    decimals: 18,
    addresses: {
      ethereum: '0x000000000000000000000000000000000000dEaD',
      polygon: '0x000000000000000000000000000000000000dEaD',
      avalanche: '0x000000000000000000000000000000000000dEaD',
      binance: '0x000000000000000000000000000000000000dEaD',
      fantom: '0x000000000000000000000000000000000000dEaD',
      arbitrum: '0x000000000000000000000000000000000000dEaD',
      optimism: '0x000000000000000000000000000000000000dEaD',
      wrfcoin: '0x000000000000000000000000000000000000dEaD',
    },
    is_active: true,
  },
];

module.exports = {
  AXELAR_TABLES,
  AXELAR_CHAINS_SEED,
  AXELAR_TOKENS_SEED,
};
