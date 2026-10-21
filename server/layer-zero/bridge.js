/**
 * Wrfcoin LayerZero Bridge Service
 *
 * This module provides a bridge service for facilitating cross-chain communication
 * between Wrfcoin and other blockchains via the LayerZero protocol.
 *
 * Issue #376: Config-driven addresses, deterministic statuses, in-memory tracking.
 */

const { sql } = require('drizzle-orm');
const crypto = require('crypto');
// Winston logger for structured logging
const { crossChainLogger: logger } = require('../utils/logger.js');
const config = require('./config');
const evmAdapter = require('./evm-adapter');
const solanaAdapter = require('./solana-adapter');
const lzApiClient = require('./api-client');

// ---------------------------------------------------------------------------
// Config-driven addresses (#376)
// ---------------------------------------------------------------------------
const LZ_SENDER_DEFAULT =
  process.env.LZ_BRIDGE_SENDER_ADDRESS || '0xLzSender00000000000000000000000000000001';
const LZ_RECEIVER_DEFAULT =
  process.env.LZ_BRIDGE_RECEIVER_ADDRESS || '0xLzReceiver000000000000000000000000000002';

// ---------------------------------------------------------------------------
// In-memory tracking maps
// ---------------------------------------------------------------------------
const messageLog = new Map();
const transferLog = new Map();

/**
 * Deterministic hash helper.
 * @param {string} input
 * @returns {string} 64-char hex
 */
function deterministicHash(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

/**
 * Generate a deterministic ID with a prefix.
 * @param {string} prefix
 * @param {string} [entropy]
 * @returns {string}
 */
function stableId(prefix, entropy = '') {
  const hash = deterministicHash(`${prefix}:${Date.now()}:${entropy}`);
  return `${prefix}-${hash.slice(0, 16)}`;
}

/**
 * Get the appropriate adapter for a chain
 * @param {number} chainId - LayerZero chain ID
 * @returns {Object|null} - Chain adapter or null if not supported
 */
async function getAdapterForChain(chainId) {
  try {
    // For now, we have a simple mapping of chain IDs to adapters
    // In the future, this could be dynamically loaded from the database
    if (chainId >= 1 && chainId <= 9) {
      // EVM chains (Ethereum, BSC, Avalanche, etc.)
      return evmAdapter;
    } else if (chainId >= 9990 && chainId <= 9999) {
      // Solana adapter
      return solanaAdapter;
    }

    logger.warn(`No adapter available for chain ID ${chainId}`);
    return null;
  } catch (error) {
    logger.error(`Error getting adapter for chain ID ${chainId}:`, error);
    throw error;
  }
}

/**
 * Send a message from one chain to another
 * @param {Object} params - Message parameters
 * @returns {Promise<Object>} - Message details
 */
async function sendMessage(params) {
  try {
    const {
      sourceChainId,
      destinationChainId,
      sender,
      receiver,
      payload,
      adapterParams,
    } = params;

    // Get source chain adapter
    const sourceAdapter = await getAdapterForChain(sourceChainId);
    if (!sourceAdapter) {
      throw new Error(`Source chain (${sourceChainId}) not supported`);
    }

    // Get destination chain adapter
    const destinationAdapter = await getAdapterForChain(destinationChainId);
    if (!destinationAdapter) {
      throw new Error(
        `Destination chain (${destinationChainId}) not supported`
      );
    }

    // Generate deterministic message ID
    const messageId = stableId('msg', `${sourceChainId}:${destinationChainId}:${sender}`);

    const record = {
      messageId,
      sourceChainId,
      destinationChainId,
      sender,
      receiver,
      payload,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
      deliveredAt: null,
      transactionHash: null,
      errorMessage: null,
      gasUsed: null,
      adapterParams: adapterParams || null,
      verificationProof: null,
    };

    messageLog.set(messageId, record);
    return record;
  } catch (error) {
    logger.error('Error sending cross-chain message:', error);
    throw error;
  }
}

/**
 * Transfer tokens from one chain to another
 * @param {Object} params - Transfer parameters
 * @returns {Promise<Object>} - Transfer details
 */
async function transferTokens(params) {
  try {
    const {
      sourceChainId,
      destinationChainId,
      tokenType,
      tokenAddress,
      senderAddress,
      recipientAddress,
      amount,
      adapterParams,
    } = params;

    // Get source chain adapter
    const sourceAdapter = await getAdapterForChain(sourceChainId);
    if (!sourceAdapter) {
      throw new Error(`Source chain (${sourceChainId}) not supported`);
    }

    // Get destination chain adapter
    const destinationAdapter = await getAdapterForChain(destinationChainId);
    if (!destinationAdapter) {
      throw new Error(
        `Destination chain (${destinationChainId}) not supported`
      );
    }

    // Generate deterministic transfer ID
    const transferId = stableId('transfer', `${sourceChainId}:${destinationChainId}:${senderAddress}:${amount}`);

    const record = {
      transferId,
      sourceChainId,
      destinationChainId,
      tokenType,
      tokenAddress,
      senderAddress,
      recipientAddress,
      amount,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
      completedAt: null,
      sourceTransactionHash: null,
      destinationTransactionHash: null,
      errorMessage: null,
      gasUsed: null,
      fee: null,
      adapterParams: adapterParams || null,
      verificationProof: null,
    };

    transferLog.set(transferId, record);
    return record;
  } catch (error) {
    logger.error('Error transferring tokens:', error);
    throw error;
  }
}

/**
 * Estimate fee for cross-chain operation
 * @param {number} sourceChainId - Source chain ID
 * @param {number} destinationChainId - Destination chain ID
 * @param {string} operationType - Operation type (MESSAGE, TOKEN, NFT)
 * @param {string} amount - Amount for token transfers
 * @returns {Promise<Object>} - Fee estimation
 */
async function estimateFee(
  sourceChainId,
  destinationChainId,
  operationType,
  amount
) {
  try {
    // Get source chain adapter
    const sourceAdapter = await getAdapterForChain(sourceChainId);
    if (!sourceAdapter) {
      throw new Error(`Source chain (${sourceChainId}) not supported`);
    }

    // Get destination chain adapter
    const destinationAdapter = await getAdapterForChain(destinationChainId);
    if (!destinationAdapter) {
      throw new Error(
        `Destination chain (${destinationChainId}) not supported`
      );
    }

    // For testing, return a mock fee estimate
    const baseFee =
      operationType === 'MESSAGE'
        ? 0.01
        : operationType === 'TOKEN'
          ? 0.05
          : operationType === 'NFT'
            ? 0.2
            : 0.1;

    // Scale fee by amount for token transfers
    const scaledFee =
      operationType === 'TOKEN' && amount
        ? baseFee + parseFloat(amount) * 0.001
        : baseFee;

    const gasLimit =
      operationType === 'MESSAGE'
        ? 100000
        : operationType === 'TOKEN'
          ? 150000
          : operationType === 'NFT'
            ? 250000
            : 125000;

    const nativeToken =
      sourceChainId === 1
        ? 'ETH'
        : sourceChainId === 2
          ? 'BNB'
          : sourceChainId === 1399811149
            ? 'SOL'
            : 'WRF';

    return {
      sourceChainId,
      destinationChainId,
      operationType,
      baseFee,
      gasPrice: '50 gwei',
      gasLimit,
      estimatedGas: gasLimit,
      fee: scaledFee.toFixed(6),
      totalFee: scaledFee.toFixed(6),
      nativeToken,
      nativeCurrency: nativeToken,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    logger.error('Error estimating cross-chain fee:', error);
    throw error;
  }
}

/**
 * Get the status of a message
 *
 * Returns the tracked record when available, otherwise derives a
 * deterministic result from the message ID hash.
 *
 * The LayerZero api client is a parameter rather than a module-level reference
 * so a caller can supply its own. Tests used to swap it by mutating Jest's
 * module registry (`jest.doMock('./api-client')` + `jest.resetModules()`), which
 * made every assertion depend on a registry operation nothing asserted —
 * backend#1017. Production callers pass nothing and get the module-level
 * client, unchanged.
 *
 * @param {string} messageId - Message ID
 * @param {{apiClient?: Object}} [deps] - Injected dependencies
 * @returns {Promise<Object>} - Message status
 */
async function getMessageStatus(messageId, { apiClient = lzApiClient } = {}) {
  try {
    if (messageLog.has(messageId)) {
      return messageLog.get(messageId);
    }

    // When real bridges are enabled, query the LayerZero scan API.
    if (apiClient.isRealBridgesEnabled()) {
      const real = await apiClient.trackMessage(messageId);
      if (real) {
        return real;
      }
    }

    // Deterministic fallback
    const hash = deterministicHash(messageId);
    const statusIdx = parseInt(hash.slice(0, 2), 16) % 3;
    const status = ['PENDING', 'DELIVERED', 'FAILED'][statusIdx];
    const gasUsed = 150000 + parseInt(hash.slice(2, 6), 16) % 200000;

    return {
      messageId,
      status,
      sourceChainId: 1,
      destinationChainId: 9999,
      sender: LZ_SENDER_DEFAULT,
      receiver: LZ_RECEIVER_DEFAULT,
      payload: { message: 'Hello LayerZero from Wrfcoin' },
      createdAt: new Date(Date.now() - 600000).toISOString(),
      deliveredAt: status === 'DELIVERED' ? new Date().toISOString() : null,
      transactionHash: `0x${hash.slice(0, 64)}`,
      errorMessage: status === 'FAILED' ? 'Simulated failure for deterministic test ID' : null,
      gasUsed,
      verificationProof: null,
    };
  } catch (error) {
    logger.error(`Error getting message status for ${messageId}:`, error);
    throw error;
  }
}

/**
 * Get the status of a token transfer
 *
 * Returns the tracked record when available, otherwise derives a
 * deterministic result from the transfer ID hash.
 *
 * @param {string} transferId - Transfer ID
 * @returns {Promise<Object>} - Transfer status
 */
async function getTransferStatus(transferId) {
  try {
    if (transferLog.has(transferId)) {
      return transferLog.get(transferId);
    }

    // Deterministic fallback
    const hash = deterministicHash(transferId);
    const statusIdx = parseInt(hash.slice(0, 2), 16) % 3;
    const status = ['PENDING', 'COMPLETED', 'FAILED'][statusIdx];

    return {
      transferId,
      status,
      sourceChainId: 9999,
      destinationChainId: 1,
      tokenType: 'ERC20',
      tokenAddress: `0x${hash.slice(2, 42)}`,
      senderAddress: LZ_SENDER_DEFAULT,
      recipientAddress: LZ_RECEIVER_DEFAULT,
      amount: '100.5',
      createdAt: new Date(Date.now() - 600000).toISOString(),
      completedAt: status === 'COMPLETED' ? new Date().toISOString() : null,
      sourceTransactionHash: `0x${hash.slice(0, 64)}`,
      destinationTransactionHash: status === 'COMPLETED' ? `0x${hash.slice(4, 68)}` : null,
      errorMessage: status === 'FAILED' ? 'Simulated failure for deterministic test ID' : null,
    };
  } catch (error) {
    logger.error(`Error getting transfer status for ${transferId}:`, error);
    throw error;
  }
}

/**
 * Get recent messages
 *
 * Returns messages from the in-memory log or deterministic placeholders.
 *
 * @param {number} limit - Maximum number of messages to return
 * @returns {Promise<Array>} - Recent messages
 */
async function getRecentMessages(limit = 10) {
  try {
    if (messageLog.size > 0) {
      return Array.from(messageLog.values())
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, limit);
    }

    const messages = [];
    for (let i = 0; i < limit; i++) {
      const hash = deterministicHash(`lz-msg:${i}`);
      const statusIdx = parseInt(hash.slice(0, 2), 16) % 3;
      messages.push({
        messageId: `msg-recent-${hash.slice(0, 12)}`,
        status: ['PENDING', 'DELIVERED', 'FAILED'][statusIdx],
        sourceChainId: 1,
        destinationChainId: 9999,
        sender: LZ_SENDER_DEFAULT,
        receiver: LZ_RECEIVER_DEFAULT,
        payload: { message: `Message ${i}` },
        createdAt: new Date(Date.now() - i * 60000).toISOString(),
        deliveredAt: statusIdx === 1 ? new Date(Date.now() - i * 30000).toISOString() : null,
        transactionHash: `0x${hash.slice(0, 64)}`,
      });
    }
    return messages;
  } catch (error) {
    logger.error('Error getting recent messages:', error);
    throw error;
  }
}

/**
 * Get recent token transfers
 *
 * Returns transfers from the in-memory log or deterministic placeholders.
 *
 * @param {number} limit - Maximum number of transfers to return
 * @returns {Promise<Array>} - Recent transfers
 */
async function getRecentTransfers(limit = 10) {
  try {
    if (transferLog.size > 0) {
      return Array.from(transferLog.values())
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, limit);
    }

    const transfers = [];
    const tokenTypes = ['NATIVE', 'ERC20', 'ERC721', 'SPL', 'WRFNFT'];

    for (let i = 0; i < limit; i++) {
      const hash = deterministicHash(`lz-transfer:${i}`);
      const statusIdx = parseInt(hash.slice(0, 2), 16) % 3;
      const typeIdx = parseInt(hash.slice(2, 4), 16) % tokenTypes.length;
      transfers.push({
        transferId: `transfer-recent-${hash.slice(0, 12)}`,
        status: ['PENDING', 'COMPLETED', 'FAILED'][statusIdx],
        sourceChainId: 9999,
        destinationChainId: 1,
        tokenType: tokenTypes[typeIdx],
        tokenAddress: `0x${hash.slice(4, 44)}`,
        senderAddress: LZ_SENDER_DEFAULT,
        recipientAddress: LZ_RECEIVER_DEFAULT,
        amount: (100 + (parseInt(hash.slice(44, 48), 16) % 900)).toFixed(2),
        createdAt: new Date(Date.now() - i * 60000).toISOString(),
        completedAt: statusIdx === 1 ? new Date(Date.now() - i * 30000).toISOString() : null,
        sourceTransactionHash: `0x${hash.slice(0, 64)}`,
      });
    }
    return transfers;
  } catch (error) {
    logger.error('Error getting recent transfers:', error);
    throw error;
  }
}

/**
 * Update message status
 *
 * Updates the in-memory record if it exists, otherwise creates a new one.
 *
 * @param {string} messageId - Message ID
 * @param {string} status - New status
 * @param {Object} details - Additional details
 * @returns {Promise<Object>} - Updated message
 */
async function updateMessageStatus(messageId, status, details = {}) {
  try {
    const {
      transactionHash,
      error,
      gasUsed,
      adapterParams,
      verificationProof,
    } = details;

    const existing = messageLog.get(messageId) || {
      messageId,
      sourceChainId: 1,
      destinationChainId: 9999,
      sender: LZ_SENDER_DEFAULT,
      receiver: LZ_RECEIVER_DEFAULT,
      payload: { message: 'Hello LayerZero from Wrfcoin' },
      createdAt: new Date(Date.now() - 600000).toISOString(),
    };

    const updated = {
      ...existing,
      status,
      deliveredAt: status === 'DELIVERED' ? new Date().toISOString() : existing.deliveredAt || null,
      transactionHash: transactionHash || existing.transactionHash || null,
      errorMessage: error || null,
      gasUsed: gasUsed || existing.gasUsed || 250000,
      adapterParams: adapterParams || existing.adapterParams || null,
      verificationProof: verificationProof || existing.verificationProof || null,
    };

    messageLog.set(messageId, updated);
    logger.info(`Updated message ${messageId} status to ${status}`);

    return updated;
  } catch (error) {
    logger.error(`Error updating message status for ${messageId}:`, error);
    throw error;
  }
}

/**
 * Update transfer status
 *
 * Updates the in-memory record if it exists, otherwise creates a new one.
 *
 * @param {string} transferId - Transfer ID
 * @param {string} status - New status
 * @param {Object} details - Additional details
 * @returns {Promise<Object>} - Updated transfer
 */
async function updateTransferStatus(transferId, status, details = {}) {
  try {
    const {
      sourceTxHash,
      destinationTxHash,
      error,
      gasUsed,
      fee,
      verificationProof,
    } = details;

    const existing = transferLog.get(transferId) || {
      transferId,
      sourceChainId: 9999,
      destinationChainId: 1,
      tokenType: 'ERC20',
      tokenAddress: `0x${deterministicHash(transferId).slice(0, 40)}`,
      senderAddress: LZ_SENDER_DEFAULT,
      recipientAddress: LZ_RECEIVER_DEFAULT,
      amount: '100.5',
      createdAt: new Date(Date.now() - 600000).toISOString(),
    };

    const updated = {
      ...existing,
      status,
      completedAt: status === 'COMPLETED' ? new Date().toISOString() : existing.completedAt || null,
      sourceTransactionHash: sourceTxHash || existing.sourceTransactionHash || null,
      destinationTransactionHash: destinationTxHash || existing.destinationTransactionHash || null,
      errorMessage: error || null,
      gasUsed: gasUsed || existing.gasUsed || 350000,
      fee: fee || existing.fee || 0.05,
      verificationProof: verificationProof || existing.verificationProof || null,
    };

    transferLog.set(transferId, updated);
    logger.info(`Updated transfer ${transferId} status to ${status}`);

    return updated;
  } catch (error) {
    logger.error(`Error updating transfer status for ${transferId}:`, error);
    throw error;
  }
}

/**
 * Initialize the bridge service
 * @returns {Promise<boolean>} True if initialization successful, false otherwise
 */
async function initialize() {
  try {
    logger.info('Initializing LayerZero bridge service');

    // In the future, this could load configuration from the database,
    // initialize connections to external services, etc.

    logger.info('LayerZero bridge service initialized');
    return true;
  } catch (error) {
    logger.error('Error initializing LayerZero bridge service:', error);
    return false;
  }
}

/**
 * Populate adapter parameters table with default values
 */
async function populateAdapterParams() {
  logger.info('Populating adapter parameters');

  // For testing, this would insert default adapter parameters into the database
  // We're skipping this for now since we're using mock data

  logger.info('Adapter parameters populated');
}

// Export public functions
module.exports = {
  initialize,
  getAdapterForChain,
  sendMessage,
  transferTokens,
  estimateFee,
  getMessageStatus,
  getTransferStatus,
  getRecentMessages,
  getRecentTransfers,
  updateMessageStatus,
  updateTransferStatus,
  populateAdapterParams,
};
