/**
 * Wrfcoin Axelar Bridge Service
 *
 * This module provides bridge service for facilitating cross-chain communication
 * between Wrfcoin and other blockchains via the Axelar Amplifier protocol.
 *
 * Task 103.4: Error sanitization implemented to prevent information disclosure
 * Issue #376: Config-driven addresses, deterministic statuses, in-memory tx log
 */

// Winston logger for structured logging
const { crossChainLogger: logger } = require('../utils/logger.js');
const crypto = require('crypto');
const config = require('./config');
const axelarApiClient = require('./api-client');

// ---------------------------------------------------------------------------
// Config-driven addresses — fall back to sensible defaults (#376)
// ---------------------------------------------------------------------------
const BRIDGE_OPERATOR_ADDRESS =
  process.env.AXELAR_BRIDGE_OPERATOR_ADDRESS || '0xAxOperator0000000000000000000000000000001';
const BRIDGE_RECIPIENT_DEFAULT =
  process.env.AXELAR_BRIDGE_RECIPIENT_DEFAULT || '0xAxRecipient000000000000000000000000000002';

// ---------------------------------------------------------------------------
// In-memory transaction log — keyed by transaction / transfer / call ID
// ---------------------------------------------------------------------------
const transactionLog = new Map();

/**
 * Deterministic hash helper — produces a stable hex digest for any string.
 * @param {string} input
 * @returns {string} 64-char hex string
 */
function deterministicHash(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

/**
 * Derive a deterministic ID from a prefix and the current high-res timestamp
 * combined with caller-supplied entropy so that repeated calls still differ.
 * @param {string} prefix
 * @param {string} [entropy]
 * @returns {string}
 */
function stableId(prefix, entropy = '') {
  const hash = deterministicHash(`${prefix}:${Date.now()}:${entropy}`);
  return `${prefix}-${hash.slice(0, 16)}`;
}

/**
 * Task 103.4: Error sanitization utility
 * Returns generic error message for clients while logging full details internally
 */
const isProduction = () => process.env.NODE_ENV === 'production';

function sanitizeError(error, operation) {
  // Always log full error internally for debugging
  logger.error(`[Internal Error - ${operation}]`, {
    message: error.message,
    stack: error.stack,
    code: error.code,
  });

  // Return sanitized error for client
  if (isProduction()) {
    const sanitizedError = new Error(`${operation} failed. Please try again or contact support.`);
    sanitizedError.code = 'BRIDGE_ERROR';
    return sanitizedError;
  }

  // In development, still sanitize sensitive paths
  const sanitizedMessage = error.message
    .replace(/\/[a-zA-Z0-9_\-/.]+\.(js|ts|json)/g, '[file]')
    .replace(/at\s+[^\s]+\s+\([^)]+\)/g, 'at [location]');
  const sanitizedError = new Error(sanitizedMessage);
  sanitizedError.code = error.code || 'BRIDGE_ERROR';
  return sanitizedError;
}

/**
 * Initialize connection to Axelar network
 * @param {string} network - Network to connect to (mainnet, testnet, devnet)
 * @returns {Object} - Connection details
 */
async function initializeConnection(network = 'testnet') {
  try {
    const endpoint = config.endpoints[network];
    if (!endpoint) {
      throw new Error(`Network ${network} not supported`);
    }

    logger.info(
      `Initializing connection to Axelar ${network} network at ${endpoint}`
    );

    // In a real implementation, this would establish a connection to the Axelar network
    // For testing, just return a mock connection
    return {
      network,
      endpoint,
      connected: true,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    // Task 103.4: Sanitize error before throwing
    throw sanitizeError(error, 'Connection initialization');
  }
}

/**
 * Get supported chains
 * @returns {Object} - Map of chain IDs to chain details
 */
function getSupportedChains() {
  return config.supportedChains;
}

/**
 * Get supported tokens
 * @returns {Object} - Map of token symbols to token details
 */
function getSupportedTokens() {
  return config.supportedTokens;
}

/**
 * Generate a GMP transaction for cross-chain message passing
 * @param {Object} params - Transaction parameters
 * @returns {Promise<Object>} - Transaction details
 */
async function generateGMPTransaction(params) {
  try {
    const {
      sourceChain,
      destinationChain,
      sender,
      recipient,
      asset,
      amount,
      gasLimit,
      gasPrice,
      messageType,
      payload,
    } = params;

    // Validate source chain
    if (!config.supportedChains[sourceChain]) {
      throw new Error(`Source chain ${sourceChain} not supported`);
    }

    // Validate destination chain
    if (!config.supportedChains[destinationChain]) {
      throw new Error(`Destination chain ${destinationChain} not supported`);
    }

    // Validate asset if provided
    if (asset && !config.supportedTokens[asset]) {
      throw new Error(`Asset ${asset} not supported`);
    }

    // Generate deterministic transaction ID
    const transactionId = stableId('axl', `${sourceChain}:${destinationChain}:${sender}:${recipient}`);

    const record = {
      id: transactionId,
      sourceChain,
      destinationChain,
      sender,
      recipient,
      asset: asset || null,
      amount: amount || '0',
      gasLimit: gasLimit || 200000,
      gasPrice: gasPrice || '50',
      messageType: messageType || 'GENERIC',
      payload: payload || {},
      status: 'CREATED',
      createdAt: new Date().toISOString(),
      executedAt: null,
      sourceTransactionHash: null,
      destinationTransactionHash: null,
      gasUsed: null,
      error: null,
    };

    transactionLog.set(transactionId, record);
    return record;
  } catch (error) {
    // Task 103.4: Sanitize error before throwing
    throw sanitizeError(error, 'GMP transaction generation');
  }
}

/**
 * Execute a cross-chain token transfer
 * @param {Object} params - Transfer parameters
 * @returns {Promise<Object>} - Transfer details
 */
async function executeTokenTransfer(params) {
  try {
    const {
      sourceChain,
      destinationChain,
      sender,
      recipient,
      asset,
      amount,
      gasLimit,
      gasPrice,
    } = params;

    // Validate source chain
    if (!config.supportedChains[sourceChain]) {
      throw new Error(`Source chain ${sourceChain} not supported`);
    }

    // Validate destination chain
    if (!config.supportedChains[destinationChain]) {
      throw new Error(`Destination chain ${destinationChain} not supported`);
    }

    // Validate asset
    if (!asset || !config.supportedTokens[asset]) {
      throw new Error(`Asset ${asset} not supported`);
    }

    // Generate deterministic transfer ID
    const transferId = stableId('axl-transfer', `${sourceChain}:${destinationChain}:${sender}:${amount}`);

    const record = {
      id: transferId,
      sourceChain,
      destinationChain,
      sender,
      recipient,
      asset,
      amount,
      gasLimit: gasLimit || 200000,
      gasPrice: gasPrice || '50',
      status: 'PENDING',
      createdAt: new Date().toISOString(),
      completedAt: null,
      sourceTransactionHash: null,
      destinationTransactionHash: null,
      gasUsed: null,
      fee: null,
      error: null,
    };

    transactionLog.set(transferId, record);
    return record;
  } catch (error) {
    // Task 103.4: Sanitize error before throwing
    throw sanitizeError(error, 'Token transfer execution');
  }
}

/**
 * Execute a cross-chain contract call
 * @param {Object} params - Call parameters
 * @returns {Promise<Object>} - Call details
 */
async function executeContractCall(params) {
  try {
    const {
      sourceChain,
      destinationChain,
      sender,
      targetContract,
      targetFunction,
      payload,
      gasLimit,
      gasPrice,
    } = params;

    // Validate source chain
    if (!config.supportedChains[sourceChain]) {
      throw new Error(`Source chain ${sourceChain} not supported`);
    }

    // Validate destination chain
    if (!config.supportedChains[destinationChain]) {
      throw new Error(`Destination chain ${destinationChain} not supported`);
    }

    // Generate deterministic call ID
    const callId = stableId('axl-call', `${sourceChain}:${destinationChain}:${sender}:${targetContract}`);

    const record = {
      id: callId,
      sourceChain,
      destinationChain,
      sender,
      targetContract,
      targetFunction,
      payload: payload || {},
      gasLimit: gasLimit || 300000,
      gasPrice: gasPrice || '50',
      status: 'PENDING',
      createdAt: new Date().toISOString(),
      completedAt: null,
      sourceTransactionHash: null,
      destinationTransactionHash: null,
      gasUsed: null,
      fee: null,
      returnValue: null,
      error: null,
    };

    transactionLog.set(callId, record);
    return record;
  } catch (error) {
    // Task 103.4: Sanitize error before throwing
    throw sanitizeError(error, 'Contract call execution');
  }
}

/**
 * Get transaction status
 *
 * If the transaction exists in the in-memory log it is returned directly.
 * Otherwise a deterministic status is derived from the txHash so the
 * same ID always returns the same status.
 *
 * The Axelar api client is a parameter rather than a module-level reference so
 * a caller can supply its own. Tests used to swap it by mutating Jest's module
 * registry (`jest.doMock('./api-client')` + `jest.resetModules()`), which made
 * every assertion depend on a registry operation nothing asserted — backend#1017.
 * Production callers pass nothing and get the module-level client, unchanged.
 *
 * @param {string} transactionId - Transaction ID
 * @param {{apiClient?: Object}} [deps] - Injected dependencies
 * @returns {Promise<Object>} - Transaction status
 */
async function getTransactionStatus(transactionId, { apiClient = axelarApiClient } = {}) {
  try {
    // Return tracked record when available
    if (transactionLog.has(transactionId)) {
      return transactionLog.get(transactionId);
    }

    // When real bridges are enabled, query the Axelar GMP API.
    if (apiClient.isRealBridgesEnabled()) {
      const real = await apiClient.queryGMPStatus(transactionId);
      if (real) {
        return real;
      }
    }

    // Deterministic status derived from hash of the ID
    const hash = deterministicHash(transactionId);
    const statusIdx = parseInt(hash.slice(0, 2), 16) % 3;
    const status = ['PENDING', 'EXECUTED', 'FAILED'][statusIdx];
    const gasUsed = 100000 + parseInt(hash.slice(2, 6), 16) % 150000;

    return {
      id: transactionId,
      status,
      sourceChain: 'ethereum',
      destinationChain: 'wrfcoin',
      sender: BRIDGE_OPERATOR_ADDRESS,
      recipient: BRIDGE_RECIPIENT_DEFAULT,
      asset: 'axlUSDC',
      amount: '100.0',
      createdAt: new Date(Date.now() - 600000).toISOString(),
      executedAt: status === 'EXECUTED' ? new Date().toISOString() : null,
      sourceTransactionHash: `0x${hash.slice(0, 64)}`,
      destinationTransactionHash: status === 'EXECUTED' ? `0x${hash.slice(4, 68)}` : null,
      gasUsed,
      fee: +(gasUsed * 0.000000001 * 50).toFixed(6),
      error: status === 'FAILED' ? 'Simulated failure for deterministic test ID' : null,
    };
  } catch (error) {
    // Task 103.4: Sanitize error before throwing (don't expose transactionId in production)
    const operation = isProduction() ? 'Transaction status retrieval' : `Transaction status retrieval for ${transactionId}`;
    throw sanitizeError(error, operation);
  }
}

/**
 * Estimate cross-chain transfer fee
 * @param {string} sourceChain - Source chain ID
 * @param {string} destinationChain - Destination chain ID
 * @param {string} asset - Asset symbol
 * @param {string} amount - Amount to transfer
 * @returns {Promise<Object>} - Fee estimation
 */
async function estimateTransferFee(
  sourceChain,
  destinationChain,
  asset,
  amount
) {
  try {
    // Validate source chain
    if (!config.supportedChains[sourceChain]) {
      throw new Error(`Source chain ${sourceChain} not supported`);
    }

    // Validate destination chain
    if (!config.supportedChains[destinationChain]) {
      throw new Error(`Destination chain ${destinationChain} not supported`);
    }

    // Validate asset
    if (!asset || !config.supportedTokens[asset]) {
      throw new Error(`Asset ${asset} not supported`);
    }

    // When real bridges are enabled, query the Axelar GMP API for fee estimation.
    if (axelarApiClient.isRealBridgesEnabled()) {
      const real = await axelarApiClient.estimateFees(sourceChain, destinationChain, asset, amount);
      if (real) {
        return real;
      }
    }

    // Chain-specific base fees and gas estimates (#376)
    const chainBaseFees = {
      ethereum: 0.025,
      polygon: 0.005,
      avalanche: 0.008,
      binance: 0.003,
      fantom: 0.004,
      arbitrum: 0.006,
      optimism: 0.006,
      wrfcoin: 0.001,
    };
    const chainGasEstimates = {
      ethereum: 250000,
      polygon: 180000,
      avalanche: 200000,
      binance: 170000,
      fantom: 190000,
      arbitrum: 220000,
      optimism: 210000,
      wrfcoin: 150000,
    };

    const baseFee = (chainBaseFees[sourceChain] || 0.01) + (chainBaseFees[destinationChain] || 0.01);
    const gasPrice = config.supportedChains[sourceChain].gasPrice || '50';
    const estimatedGas = chainGasEstimates[sourceChain] || 200000;
    const amountValue = parseFloat(amount) || 0;
    const percentageFee = amountValue * 0.001;
    const totalFee = baseFee + percentageFee;

    return {
      sourceChain,
      destinationChain,
      asset,
      amount,
      baseFee,
      gasPrice,
      estimatedGas,
      percentageFee,
      totalFee: totalFee.toFixed(6),
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    // Task 103.4: Sanitize error before throwing
    throw sanitizeError(error, 'Transfer fee estimation');
  }
}

/**
 * Get recent transactions
 *
 * Returns transactions from the in-memory log (most recent first) or
 * generates deterministic placeholder entries when the log is empty.
 *
 * @param {number} limit - Maximum number of transactions to return
 * @returns {Promise<Array>} - Recent transactions
 */
async function getRecentTransactions(limit = 10) {
  try {
    // Prefer in-memory log if it has entries
    if (transactionLog.size > 0) {
      return Array.from(transactionLog.values())
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, limit);
    }

    // Deterministic fallback list
    const chainNames = Object.keys(config.supportedChains);
    const tokenNames = Object.keys(config.supportedTokens);
    const transactions = [];

    for (let i = 0; i < limit; i++) {
      const hash = deterministicHash(`recent:${i}`);
      const statusIdx = parseInt(hash.slice(0, 2), 16) % 3;
      transactions.push({
        id: `axl-recent-${hash.slice(0, 12)}`,
        status: ['PENDING', 'EXECUTED', 'FAILED'][statusIdx],
        sourceChain: chainNames[parseInt(hash.slice(2, 4), 16) % chainNames.length],
        destinationChain: chainNames[parseInt(hash.slice(4, 6), 16) % chainNames.length],
        sender: BRIDGE_OPERATOR_ADDRESS,
        recipient: BRIDGE_RECIPIENT_DEFAULT,
        asset: tokenNames[parseInt(hash.slice(6, 8), 16) % tokenNames.length],
        amount: (100 + (parseInt(hash.slice(8, 12), 16) % 900)).toFixed(2),
        createdAt: new Date(Date.now() - i * 60000).toISOString(),
        executedAt: statusIdx === 1 ? new Date(Date.now() - i * 30000).toISOString() : null,
        sourceTransactionHash: `0x${hash.slice(0, 64)}`,
        destinationTransactionHash: statusIdx === 1 ? `0x${hash.slice(4, 68)}` : null,
      });
    }

    return transactions;
  } catch (error) {
    // Task 103.4: Sanitize error before throwing
    throw sanitizeError(error, 'Recent transactions retrieval');
  }
}

/**
 * Initialization function
 */
async function initialize() {
  try {
    logger.info('Initializing Axelar bridge service');

    // In a real implementation, this would initialize connections to external services
    // For testing, just log the initialization

    logger.info('Axelar bridge service initialized');

    return true;
  } catch (error) {
    // Task 103.4: Sanitize error before throwing
    throw sanitizeError(error, 'Bridge service initialization');
  }
}

// Export public functions
module.exports = {
  initialize,
  initializeConnection,
  getSupportedChains,
  getSupportedTokens,
  generateGMPTransaction,
  executeTokenTransfer,
  executeContractCall,
  getTransactionStatus,
  estimateTransferFee,
  getRecentTransactions,
};
