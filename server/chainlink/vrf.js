/**
 * Chainlink VRF (Verifiable Random Function) Client for Wrfcoin
 *
 * This module provides functions to interact with Chainlink VRF,
 * generating verifiable random numbers for applications such as
 * NFT minting, gaming, and randomized rewards.
 */

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const config = require('./config');
const logger = require('../utils/logger');

/**
 * Wrapper for the Chainlink VRF service
 */
class VRFClient {
  /**
   * Create a new VRFClient
   * @param {string} network - Network to use (mainnet, testnet, etc.)
   */
  constructor(network = 'testnet') {
    this.network = network;
    this.networkConfig = config.getNetwork(network);
    this.endpoint = this.networkConfig.endpoint;
    this.vrfConfig = config.getVRFConfig(network);
    this.pendingRequests = new Map();
  }

  /**
   * Request a random number from the VRF service
   * @param {number} numWords - Number of random values to generate (1-10)
   * @param {Function} callback - Callback for when the random number is ready
   * @returns {string} Request ID
   */
  requestRandomness(numWords = 1, callback) {
    // Validate input
    if (numWords < 1 || numWords > 10) {
      throw new Error('numWords must be between 1 and 10');
    }

    // Generate a unique request ID
    const requestId = uuidv4();
    logger.info(
      `Requesting VRF randomness, requestId: ${requestId}, numWords: ${numWords}`
    );

    // Store the callback for later
    this.pendingRequests.set(requestId, callback);

    // In a real implementation, this would send a transaction to the VRF Coordinator
    // For this simulation, we'll just use a timeout to simulate the blockchain response time
    setTimeout(() => {
      this._simulateFulfillRandomness(requestId, numWords);
    }, 3000);

    return requestId;
  }

  /**
   * Request a random number within a specific range
   * @param {number} min - Minimum value (inclusive)
   * @param {number} max - Maximum value (inclusive)
   * @param {Function} callback - Callback for when the random number is ready
   * @returns {string} Request ID
   */
  requestRandomNumberInRange(min, max, callback) {
    // Validate input
    if (min >= max) {
      throw new Error('min must be less than max');
    }

    return this.requestRandomness(1, (err, result) => {
      if (err) {
        callback(err, null);
        return;
      }

      // Scale the random value to the desired range
      const randomValue =
        min + Math.floor(result.randomWords[0] % (max - min + 1));
      callback(null, {
        requestId: result.requestId,
        value: randomValue,
        min,
        max,
        proof: result.proof,
      });
    });
  }

  /**
   * Request multiple random numbers in a single request
   * @param {Array<Object>} requests - Array of request objects with min/max values
   * @param {Function} callback - Callback for when all random numbers are ready
   * @returns {string} Request ID
   */
  requestMultipleRandomNumbers(requests, callback) {
    // Validate input
    if (
      !Array.isArray(requests) ||
      requests.length === 0 ||
      requests.length > 10
    ) {
      throw new Error('requests must be an array with 1-10 elements');
    }

    // Request the appropriate number of random words
    return this.requestRandomness(requests.length, (err, result) => {
      if (err) {
        callback(err, null);
        return;
      }

      // Scale each random value to its desired range
      const values = requests.map((req, index) => {
        const { min, max } = req;
        const randomValue =
          min + Math.floor(result.randomWords[index] % (max - min + 1));
        return {
          value: randomValue,
          min,
          max,
        };
      });

      callback(null, {
        requestId: result.requestId,
        values,
        proof: result.proof,
      });
    });
  }

  /**
   * Get the status of a pending random number request
   * @param {string} requestId - The request ID
   * @returns {Promise<object>} Request status information
   */
  async getRequestStatus(requestId) {
    try {
      const response = await axios.get(
        `${this.endpoint}/vrf/requests/${requestId}`
      );

      if (!response.data || !response.data.success) {
        throw new Error(`Failed to get request status for ${requestId}`);
      }

      return response.data.data;
    } catch (error) {
      logger.error(`Failed to get request status for ${requestId}:`, error);
      throw new Error(`Failed to get request status: ${error.message}`);
    }
  }

  /**
   * Verify a VRF proof
   * @param {string} requestId - The request ID
   * @param {Array<number>} randomWords - The provided random values
   * @param {string} proof - The VRF proof
   * @returns {Promise<boolean>} Whether the proof is valid
   */
  async verifyProof(requestId, randomWords, proof) {
    try {
      const response = await axios.post(`${this.endpoint}/vrf/verify`, {
        requestId,
        randomWords,
        proof,
      });

      if (!response.data || !response.data.success) {
        throw new Error(`Failed to verify proof for ${requestId}`);
      }

      return response.data.data.valid;
    } catch (error) {
      logger.error(`Failed to verify proof for ${requestId}:`, error);
      throw new Error(`Failed to verify proof: ${error.message}`);
    }
  }

  /**
   * Simulate fulfillment of a random number request
   * @private
   * @param {string} requestId - The request ID
   * @param {number} numWords - Number of random values to generate
   */
  _simulateFulfillRandomness(requestId, numWords) {
    logger.info(`Simulating VRF fulfillment for requestId: ${requestId}`);

    // Get the callback for this request
    const callback = this.pendingRequests.get(requestId);
    if (!callback) {
      logger.error(`No callback found for requestId: ${requestId}`);
      return;
    }

    // Generate random values
    const randomWords = Array(numWords)
      .fill(0)
      .map(() => {
        // Generate a large random number (simulating a uint256)
        return (
          BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)) *
          BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER))
        );
      });

    // Generate a fake proof (in real implementation, this would be a cryptographic proof)
    const proof = Buffer.from(uuidv4()).toString('hex');

    // Call the callback with the result
    callback(null, {
      requestId,
      randomWords: randomWords.map(n => n.toString()),
      proof,
    });

    // Remove the request from pending
    this.pendingRequests.delete(requestId);
  }
}

module.exports = VRFClient;
