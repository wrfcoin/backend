/**
 * ID Generator Utility
 *
 * This module provides functions for generating unique IDs for various entities
 * in the account abstraction wallet layer.
 */

const crypto = require('crypto');

/**
 * Generate a random ID with a given prefix
 * @param {string} prefix - The prefix to use for the generated ID
 * @returns {string} - A unique ID with the given prefix
 */
function generateId(prefix) {
  const randomBytes = crypto.randomBytes(8).toString('hex');
  return `${prefix}-${randomBytes}`;
}

/**
 * Generate a random operation ID
 * @returns {string} - A unique operation ID
 */
function generateOperationId() {
  return generateId('op');
}

/**
 * Generate a random bundle ID
 * @returns {string} - A unique bundle ID
 */
function generateBundleId() {
  return generateId('bundle');
}

/**
 * Generate a random delegation ID
 * @returns {string} - A unique delegation ID
 */
function generateDelegationId() {
  return generateId('delegation');
}

/**
 * Generate a random recovery request ID
 * @returns {string} - A unique recovery request ID
 */
function generateRecoveryRequestId() {
  return generateId('recovery');
}

/**
 * Generate a random transaction ID
 * @returns {string} - A unique transaction ID
 */
function generateTransactionId() {
  return generateId('tx');
}

/**
 * Generate a deterministic ID based on input
 * @param {string} prefix - The prefix to use for the generated ID
 * @param {string} input - The input to use for generating the deterministic ID
 * @returns {string} - A deterministic ID
 */
function generateDeterministicId(prefix, input) {
  const hash = crypto
    .createHash('sha256')
    .update(input)
    .digest('hex')
    .slice(0, 8);
  return `${prefix}-${hash}`;
}

module.exports = {
  generateOperationId,
  generateBundleId,
  generateDelegationId,
  generateRecoveryRequestId,
  generateTransactionId,
  generateDeterministicId,
};
