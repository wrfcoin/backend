/**
 * Proof of Publishing (PoP) Blockchain Integration
 *
 * This module provides integration between the PoP consensus mechanism and the blockchain.
 * It converts validated environmental data submissions into blockchain transactions
 * and manages the reward distribution for validators.
 */

const { v4: uuidv4 } = require('uuid');
const { ValidationState } = require('./types');
const blockchainModules = require('../../modules/blockchain_modules');
const websocketModule = require('../../websocket');

/**
 * Convert a validated PoP submission into a blockchain transaction
 * @param {Object} submission - The validated submission
 * @param {Object} options - Transaction options
 * @returns {Promise<Object>} The created transaction
 */
async function createTransactionFromSubmission(submission, options = {}) {
  // Validate that the submission is validated
  if (submission.validationState !== ValidationState.VALIDATED) {
    throw new Error(
      `Cannot create transaction for submission with state: ${submission.validationState}`
    );
  }

  try {
    // Extract submission data
    const {
      submissionId,
      dataType,
      submitter,
      measurements,
      location,
      reliability,
      metadata,
    } = submission;

    // Generate transaction ID
    const txId = options.txId || `tx${uuidv4().substring(0, 8)}`;

    // Create a new transaction object
    const transaction = {
      id: txId,
      timestamp: new Date().toISOString(),
      type: 'Environmental',
      subtype: dataType,
      data: {
        submissionId,
        dataType,
        reliability: reliability || 0,
        location: location
          ? {
              latitude: location.latitude,
              longitude: location.longitude,
            }
          : null,
        measurements: measurements.map(m => ({
          parameter: m.parameter,
          value: m.value,
          unit: m.unit,
        })),
        metadata: {
          source: metadata?.source || 'PoP Consensus',
          version: metadata?.version || '1.0',
        },
      },
      submitter:
        typeof submitter === 'object' ? submitter.walletAddress : submitter,
      status: 'confirmed',
      fee: (Math.random() * 0.1).toFixed(4),
    };

    // If we have access to the mempool module, add the transaction there
    if (blockchainModules.mempool && blockchainModules.mempool.initialized) {
      blockchainModules.mempool.addTransaction({
        ...transaction,
        timestamp: new Date(transaction.timestamp),
        status: 'PENDING',
      });
    }

    // Broadcast the transaction using websocket
    if (websocketModule && websocketModule.broadcastTransaction) {
      websocketModule.broadcastTransaction(transaction);
      console.log(`Broadcasted PoP transaction: ${transaction.id}`);
    }

    return transaction;
  } catch (error) {
    console.error('Error creating transaction from submission:', error);
    throw error;
  }
}

/**
 * Create reward transactions for validators
 * @param {Object} submission - The validated submission
 * @param {Array} attestations - The validator attestations
 * @param {Object} options - Transaction options
 * @returns {Promise<Array>} The created reward transactions
 */
async function createRewardTransactions(
  submission,
  attestations,
  options = {}
) {
  // Only create rewards for validated submissions
  if (submission.validationState !== ValidationState.VALIDATED) {
    throw new Error(
      `Cannot create rewards for submission with state: ${submission.validationState}`
    );
  }

  try {
    const rewardTransactions = [];

    // Create a reward transaction for the submitter
    const submitterReward = calculateSubmitterReward(submission);
    const submitterTx = {
      id: `tx${uuidv4().substring(0, 8)}`,
      timestamp: new Date().toISOString(),
      type: 'Reward',
      subtype: 'PoP_Submitter',
      data: {
        submissionId: submission.submissionId,
        rewardType: 'SUBMISSION',
        dataType: submission.dataType,
        reliability: submission.reliability || 0,
      },
      recipient:
        typeof submission.submitter === 'object'
          ? submission.submitter.walletAddress
          : submission.submitter,
      amount: submitterReward,
      status: 'confirmed',
      fee: '0.0000', // No fee for reward transactions
    };

    rewardTransactions.push(submitterTx);

    // Create reward transactions for valid attestations
    const validAttestations = attestations.filter(
      a => a.isValid && a.validatorId !== 0
    );

    for (const attestation of validAttestations) {
      const validatorReward = calculateValidatorReward(attestation, submission);
      const validatorTx = {
        id: `tx${uuidv4().substring(0, 8)}`,
        timestamp: new Date().toISOString(),
        type: 'Reward',
        subtype: 'PoP_Validator',
        data: {
          submissionId: submission.submissionId,
          attestationId: attestation.attestationId,
          rewardType: 'VALIDATION',
          validationScore: attestation.validationScore,
        },
        recipient:
          attestation.validatorAddress ||
          `WrfValidator${attestation.validatorId}`,
        amount: validatorReward,
        status: 'confirmed',
        fee: '0.0000', // No fee for reward transactions
      };

      rewardTransactions.push(validatorTx);
    }

    // Broadcast the reward transactions
    for (const tx of rewardTransactions) {
      if (websocketModule && websocketModule.broadcastTransaction) {
        websocketModule.broadcastTransaction(tx);
        console.log(`Broadcasted reward transaction: ${tx.id}`);
      }
    }

    return rewardTransactions;
  } catch (error) {
    console.error('Error creating reward transactions:', error);
    throw error;
  }
}

/**
 * Calculate reward for submission
 * @param {Object} submission - The validated submission
 * @returns {number} The reward amount
 */
function calculateSubmitterReward(submission) {
  // Base reward amount
  let reward = 10; // Base reward for all submissions

  // Adjust based on reliability score
  if (submission.reliability) {
    reward *= submission.reliability;
  }

  // Adjust based on data type importance
  // For example, certain types of data might be more valuable
  const dataTypeMultipliers = {
    WEATHER: 1.0,
    AIR_QUALITY: 1.2,
    WATER_QUALITY: 1.2,
    SOIL: 1.1,
    CLIMATE: 1.3,
    BIODIVERSITY: 1.4,
    ECOSYSTEM: 1.5,
  };

  const multiplier = dataTypeMultipliers[submission.dataType] || 1.0;
  reward *= multiplier;

  // Round to whole number
  return Math.floor(reward);
}

/**
 * Calculate reward for validator
 * @param {Object} attestation - The validation attestation
 * @param {Object} submission - The validated submission
 * @returns {number} The reward amount
 */
function calculateValidatorReward(attestation, submission) {
  // Base reward for validation
  let reward = 2;

  // Adjust based on validation score
  if (attestation.validationScore) {
    reward *= attestation.validationScore;
  }

  // Adjust based on submission importance
  if (submission.reliability) {
    reward *= 1 + submission.reliability / 10;
  }

  // Round to whole number
  return Math.floor(reward);
}

module.exports = {
  createTransactionFromSubmission,
  createRewardTransactions,
};
