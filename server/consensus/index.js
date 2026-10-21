/**
 * Consensus Module Index
 *
 * This file serves as the entry point for all consensus-related functionality,
 * coordinating between different consensus mechanisms including Proof of Work,
 * Proof of Useful Analysis, and Proof of Publishing (PoP).
 */

const { storage } = require('../storage');
const PopConsensusController = require('./pop/controller');
const logger = require('../../utils/logger');

// Create dedicated logger
const consensusLogger = logger('consensus');

// Store controller instances
const controllers = new Map();

/**
 * Initialize a specific consensus module
 * @param {string} mechanism - Name of the consensus mechanism
 * @param {Object} options - Configuration options for the mechanism
 * @returns {Object} - The controller instance
 */
function initializeConsensus(mechanism, options = {}) {
  consensusLogger.info(`Initializing ${mechanism} consensus module`, {
    options,
  });

  let controller;

  switch (mechanism) {
    case 'ProofOfPublishing':
      controller = new PopConsensusController(storage, options);
      break;

    case 'ProofOfWork':
      // To be implemented
      consensusLogger.info('ProofOfWork consensus is currently a placeholder');
      controller = { type: 'ProofOfWork', status: 'PLACEHOLDER' };
      break;

    case 'ProofOfUsefulAnalysis':
      // To be implemented
      consensusLogger.info(
        'ProofOfUsefulAnalysis consensus is currently a placeholder'
      );
      controller = { type: 'ProofOfUsefulAnalysis', status: 'PLACEHOLDER' };
      break;

    default:
      throw new Error(`Unknown consensus mechanism: ${mechanism}`);
  }

  controllers.set(mechanism, controller);
  consensusLogger.info(
    `Successfully initialized ${mechanism} consensus module`
  );

  return controller;
}

/**
 * Get an initialized consensus controller
 * @param {string} mechanism - Name of the consensus mechanism
 * @returns {Object} - The controller instance
 */
function getConsensusController(mechanism) {
  if (!controllers.has(mechanism)) {
    consensusLogger.info(
      `Controller for ${mechanism} not found, initializing with default options`
    );
    return initializeConsensus(mechanism);
  }

  return controllers.get(mechanism);
}

/**
 * Get all initialized consensus controllers
 * @returns {Map<string, Object>} - Map of consensus mechanism names to controller instances
 */
function getAllConsensusControllers() {
  return controllers;
}

/**
 * Get the status of all consensus mechanisms
 * @returns {Object} - Status information for all mechanisms
 */
function getConsensusStatus() {
  const status = {};

  for (const [mechanism, controller] of controllers.entries()) {
    status[mechanism] = {
      active: !!controller,
      type: controller?.type || mechanism,
      status: controller?.status || 'UNKNOWN',
    };
  }

  return status;
}

/**
 * Register a consensus-related event with WebSocket
 * @param {Object} websocketModule - The WebSocket module instance
 */
function registerConsensusEventsWithWebSocket(websocketModule) {
  if (!websocketModule) {
    consensusLogger.warn(
      'Cannot register consensus events: WebSocket module not provided'
    );
    return;
  }

  // Register PoP consensus events
  const popController = getConsensusController('ProofOfPublishing');

  // Event handler for new submissions
  popController.on('submissionCreated', submission => {
    websocketModule.broadcastMessage('consensus', 'POP_SUBMISSION_CREATED', {
      submissionId: submission.submissionId,
      dataType: submission.dataType,
      timestamp: submission.timestamp,
      validationState: submission.validationState,
    });
  });

  // Event handler for validation updates
  popController.on('validationUpdate', (submissionId, attestation) => {
    websocketModule.broadcastMessage('consensus', 'POP_VALIDATION_UPDATE', {
      submissionId,
      attestationId: attestation.attestationId,
      validationResult: attestation.validationResult,
      timestamp: attestation.timestamp,
    });
  });

  // Event handler for validation completion
  popController.on('validationCompleted', (submissionId, isValid, rewards) => {
    websocketModule.broadcastMessage('consensus', 'POP_VALIDATION_COMPLETED', {
      submissionId,
      isValid,
      rewards: rewards
        ? rewards.map(r => ({
            rewardId: r.rewardId,
            recipientId: r.recipientId,
            amount: r.amount,
            type: r.type,
          }))
        : [],
    });
  });

  consensusLogger.info('Registered consensus events with WebSocket module');
}

// Export functions
module.exports = {
  initializeConsensus,
  getConsensusController,
  getAllConsensusControllers,
  getConsensusStatus,
  registerConsensusEventsWithWebSocket,
};
