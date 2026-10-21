/**
 * Solana Chain Adapter for LayerZero Integration
 *
 * This module provides Solana-specific functionality for the LayerZero bridge service.
 * It uses simple hex encoding instead of Base58 to avoid dependency issues.
 */

// Winston logger for structured logging
const { crossChainLogger: logger } = require('../utils/logger.js');
const config = require('./config');

/**
 * Encode a message for Solana
 * @param {Object} message - Message to encode
 * @returns {string} - Encoded message
 */
function encodeMessage(message) {
  try {
    // For testing, just convert to JSON string and do simple hex encoding
    // This avoids the Base58 dependency issues
    const jsonStr = JSON.stringify(message);
    return Buffer.from(jsonStr).toString('hex');
  } catch (error) {
    logger.error('Error encoding message for Solana:', error);
    throw error;
  }
}

/**
 * Decode a message from Solana
 * @param {string} encodedMessage - Encoded message
 * @returns {Object} - Decoded message
 */
function decodeMessage(encodedMessage) {
  try {
    // For testing, just convert from hex encoding
    const jsonStr = Buffer.from(encodedMessage, 'hex').toString();
    return JSON.parse(jsonStr);
  } catch (error) {
    logger.error('Error decoding message from Solana:', error);
    throw error;
  }
}

/**
 * Get the current compute unit price for Solana
 * @returns {Promise<number>} - Compute unit price in micro-lamports
 */
async function getComputeUnitPrice() {
  try {
    // In a real implementation, this would query the Solana network
    // For testing, return a reasonable default
    return 1;
  } catch (error) {
    logger.error('Error getting compute unit price for Solana:', error);
    throw error;
  }
}

/**
 * Estimate compute units for a transaction
 * @param {string} operationType - Operation type (MESSAGE, TOKEN, NFT)
 * @returns {Promise<number>} - Estimated compute units
 */
async function estimateComputeUnits(operationType) {
  try {
    // In a real implementation, this would use Solana's simulate transaction
    // For testing, return reasonable defaults based on operation type
    if (operationType === 'MESSAGE') {
      return 150000;
    } else if (operationType === 'TOKEN') {
      return 180000;
    } else if (operationType === 'NFT') {
      return 250000;
    } else {
      return 200000;
    }
  } catch (error) {
    logger.error(`Error estimating compute units for ${operationType}:`, error);
    throw error;
  }
}

/**
 * Send a transaction to Solana
 * @param {Object} transaction - Transaction to send
 * @returns {Promise<Object>} - Transaction receipt
 */
async function sendTransaction(transaction) {
  try {
    // In a real implementation, this would use @solana/web3.js to send the transaction
    // For testing, just return a mock transaction receipt
    return {
      signature: Buffer.from(
        Math.random().toString(16).substr(2, 64),
        'hex'
      ).toString('hex'),
      blockNumber: Math.floor(Math.random() * 200000000),
      slot: Math.floor(Math.random() * 200000000),
      computeUnits: Math.floor(Math.random() * 200000),
      status: 'CONFIRMED',
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    logger.error('Error sending transaction to Solana:', error);
    throw error;
  }
}

// Export public functions
module.exports = {
  encodeMessage,
  decodeMessage,
  getComputeUnitPrice,
  estimateComputeUnits,
  sendTransaction,
};
