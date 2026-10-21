/**
 * Cryptographic utilities for wallet authentication
 *
 * This module provides functions for cryptographic operations related to
 * wallet authentication, signature verification, and key management.
 */

const { ethers } = require('ethers');
const { logger } = require('./logger');

/**
 * Verifies an Ethereum-style signature
 *
 * @param {string} address - The wallet address that signed the message
 * @param {string} signature - The signature to verify
 * @param {string} message - The original message that was signed
 * @returns {Promise<boolean>} - Whether the signature is valid
 */
async function verifySignature(address, signature, message) {
  try {
    const normalizedAddress = ethers.getAddress(address);
    const recoveredAddress = ethers.verifyMessage(message, signature);

    // Check if the recovered address matches the provided address
    const isValid = ethers.getAddress(recoveredAddress) === normalizedAddress;

    logger.debug('Signature verification', {
      address: normalizedAddress.toLowerCase(),
      recoveredAddress: recoveredAddress.toLowerCase(),
      isValid,
    });

    return isValid;
  } catch (error) {
    logger.error('Error verifying signature', {
      address,
      error: error.message,
      stack: error.stack,
    });

    return false;
  }
}

/**
 * Generates a random nonce
 *
 * @returns {string} - A random nonce
 */
function generateNonce() {
  const timestamp = Date.now();
  const randomBytes = ethers.randomBytes(16);
  const randomHex = ethers.hexlify(randomBytes);
  return `${timestamp}:${randomHex}`;
}

/**
 * Hashes a message using Keccak256
 *
 * @param {string} message - The message to hash
 * @returns {string} - The hashed message
 */
function hashMessage(message) {
  return ethers.hashMessage(message);
}

module.exports = {
  verifySignature,
  generateNonce,
  hashMessage,
};
