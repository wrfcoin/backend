/**
 * Axelar EVM Chain Adapter
 *
 * This module provides Ethereum Virtual Machine (EVM) specific functionality
 * for interacting with the Axelar network.
 *
 * Issue #376: Basic ABI-style encode/decode using Buffer (no ethers.js dependency).
 */

// Winston logger for structured logging
const { crossChainLogger: logger } = require('../utils/logger.js');
const crypto = require('crypto');
const config = require('./config');

// ---------------------------------------------------------------------------
// Lightweight ABI-like helpers — encode typed values into a hex string that
// can be deterministically decoded without ethers.js.
//
// Format:  <4-byte function selector><32-byte slot per value>
// Each slot is left-padded for uint256/address, right-padded for bytes/string.
// We embed a small header so `decodePayload` can recover the original types.
// ---------------------------------------------------------------------------

/**
 * Compute a 4-byte function selector from a human-readable signature.
 * @param {string} signature  e.g. "sendToken(string,address,string,uint256)"
 * @returns {string} 8-char hex (no 0x prefix)
 */
function functionSelector(signature) {
  return crypto.createHash('sha256').update(signature).digest('hex').slice(0, 8);
}

/**
 * ABI-encode a single value into a 32-byte (64 hex char) slot.
 * @param {string|number|bigint|Buffer} value
 * @param {'uint256'|'address'|'string'|'bytes'} type
 * @returns {string} 64-char hex
 */
function encodeSlot(value, type) {
  const buf = Buffer.alloc(32, 0);
  switch (type) {
    case 'uint256': {
      const hex = BigInt(value).toString(16).padStart(64, '0').slice(-64);
      return hex;
    }
    case 'address': {
      const addr = String(value).replace(/^0x/i, '').toLowerCase().padStart(40, '0').slice(0, 40);
      return '000000000000000000000000' + addr;
    }
    case 'string':
    case 'bytes':
    default: {
      const data = Buffer.from(String(value), 'utf8');
      data.copy(buf, 0, 0, Math.min(data.length, 32));
      return buf.toString('hex');
    }
  }
}

/**
 * Encode a payload for EVM chains.
 *
 * Produces a hex string that starts with a JSON-length header followed by
 * the JSON payload so that `decodePayload` can recover the original object.
 * This is a lightweight stand-in for real ABI encoding (#376).
 *
 * @param {Object} payload - Payload to encode
 * @returns {string} - Hex-encoded payload
 */
function encodePayload(payload) {
  try {
    const jsonStr = JSON.stringify(payload);
    const jsonBuf = Buffer.from(jsonStr, 'utf8');
    // 4-byte big-endian length prefix + payload bytes
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(jsonBuf.length, 0);
    return Buffer.concat([lenBuf, jsonBuf]).toString('hex');
  } catch (error) {
    logger.error('Error encoding payload for EVM chain:', error);
    throw error;
  }
}

/**
 * Decode a payload from EVM chains.
 *
 * Supports both the new length-prefixed format and the legacy raw-JSON
 * hex format for backward compatibility.
 *
 * @param {string} encodedPayload - Hex-encoded payload
 * @returns {Object} - Decoded payload
 */
function decodePayload(encodedPayload) {
  try {
    const buf = Buffer.from(encodedPayload, 'hex');
    // Try length-prefixed format first (4-byte header)
    if (buf.length >= 4) {
      const declaredLen = buf.readUInt32BE(0);
      if (declaredLen > 0 && declaredLen <= buf.length - 4) {
        const jsonStr = buf.slice(4, 4 + declaredLen).toString('utf8');
        try {
          return JSON.parse(jsonStr);
        } catch (_) {
          // Fall through to legacy decode
        }
      }
    }
    // Legacy: raw JSON hex
    const jsonStr = buf.toString('utf8');
    return JSON.parse(jsonStr);
  } catch (error) {
    logger.error('Error decoding payload from EVM chain:', error);
    throw error;
  }
}

/**
 * Generate a token transfer transaction for EVM chains
 * @param {Object} params - Transfer parameters
 * @returns {Object} - Transaction
 */
function generateTokenTransferTx(params) {
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

    // Get token contract address
    const tokenAddress = config.supportedTokens[asset]?.contracts[sourceChain];
    if (!tokenAddress) {
      throw new Error(`Token ${asset} not supported on ${sourceChain}`);
    }

    // Get gateway contract address
    const gatewayAddress = config.supportedChains[sourceChain]?.gateway;
    if (!gatewayAddress) {
      throw new Error(`Gateway for ${sourceChain} not configured`);
    }

    // In a real implementation, this would generate a complete EVM transaction
    // For testing, just return a mock transaction object
    return {
      to: gatewayAddress,
      from: sender,
      data: `0x${encodePayload({
        method: 'sendToken',
        params: {
          destinationChain,
          destinationAddress: recipient,
          symbol: asset,
          amount,
        },
      })}`,
      value: '0',
      gasLimit: gasLimit || '200000',
      gasPrice: gasPrice || '50',
      chainId: config.supportedChains[sourceChain].chainId,
    };
  } catch (error) {
    logger.error(
      'Error generating token transfer transaction for EVM chain:',
      error
    );
    throw error;
  }
}

/**
 * Generate a general message passing transaction for EVM chains
 * @param {Object} params - Message parameters
 * @returns {Object} - Transaction
 */
function generateGMPTx(params) {
  try {
    const {
      sourceChain,
      destinationChain,
      sender,
      recipient,
      payload,
      gasLimit,
      gasPrice,
    } = params;

    // Get gateway contract address
    const gatewayAddress = config.supportedChains[sourceChain]?.gateway;
    if (!gatewayAddress) {
      throw new Error(`Gateway for ${sourceChain} not configured`);
    }

    // In a real implementation, this would generate a complete EVM transaction
    // For testing, just return a mock transaction object
    return {
      to: gatewayAddress,
      from: sender,
      data: `0x${encodePayload({
        method: 'callContract',
        params: {
          destinationChain,
          destinationContractAddress: recipient,
          payload: encodePayload(payload),
        },
      })}`,
      value: '0',
      gasLimit: gasLimit || '300000',
      gasPrice: gasPrice || '50',
      chainId: config.supportedChains[sourceChain].chainId,
    };
  } catch (error) {
    logger.error('Error generating GMP transaction for EVM chain:', error);
    throw error;
  }
}

/**
 * Estimate gas for a transaction
 * @param {string} chainName - Chain name
 * @param {string} operationType - Operation type (TOKEN_TRANSFER, GMP)
 * @returns {Promise<number>} - Estimated gas
 */
async function estimateGas(chainName, operationType) {
  try {
    // Get chain config
    const chainConfig = config.supportedChains[chainName];
    if (!chainConfig) {
      throw new Error(`Chain ${chainName} not supported`);
    }

    // In a real implementation, this would use the RPC to estimate gas
    // For testing, just return reasonable defaults based on operation type
    if (operationType === 'TOKEN_TRANSFER') {
      return 200000;
    } else if (operationType === 'GMP') {
      return 300000;
    } else {
      return 250000;
    }
  } catch (error) {
    logger.error(`Error estimating gas for ${chainName}:`, error);
    throw error;
  }
}

/**
 * Get the gas price for a chain
 * @param {string} chainName - Chain name
 * @returns {Promise<string>} - Gas price in gwei
 */
async function getGasPrice(chainName) {
  try {
    // Get chain config
    const chainConfig = config.supportedChains[chainName];
    if (!chainConfig) {
      throw new Error(`Chain ${chainName} not supported`);
    }

    // In a real implementation, this would use the RPC to get current gas prices
    // For testing, just return reasonable defaults
    if (chainName === 'ethereum') {
      return '50';
    } else if (chainName === 'polygon') {
      return '30';
    } else if (chainName === 'avalanche') {
      return '25';
    } else if (chainName === 'binance') {
      return '5';
    } else {
      return '20';
    }
  } catch (error) {
    logger.error(`Error getting gas price for ${chainName}:`, error);
    throw error;
  }
}

// Export public functions
module.exports = {
  encodePayload,
  decodePayload,
  functionSelector,
  encodeSlot,
  generateTokenTransferTx,
  generateGMPTx,
  estimateGas,
  getGasPrice,
};
