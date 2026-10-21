/**
 * Proof of Publishing (PoP) Controller — LOCAL IN-MEMORY SIMULATOR
 *
 * !!! IMPORTANT !!!
 * This is a self-contained, in-process simulation of PoP consensus. It keeps
 * all state in the `Map()`s below (submissions/validations/rewards) — nothing
 * here is persisted to a real chain, and it has no connection to core4's real
 * consensus engine. `calculateRewards()` issues fixed, fabricated amounts
 * (`REWARD_TYPES.SUBMISSION` = 50, `REWARD_TYPES.VALIDATION` = 10 per
 * validator) — these are not real WRF token transfers.
 *
 * Useful for local development/demo of the PoP submission→validation→reward
 * flow without a live chain, but its only caller (`server/routes/popRoutes.ts`)
 * is unmounted as of 2026-09, so this is currently unreachable in production.
 * See backend#1124.
 *
 * This module coordinates the local Proof of Publishing consensus simulation.
 * It manages submissions, validations, and simulated rewards for environmental
 * data.
 */

const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const { validateSubmission } = require('./validator');
const {
  ENV_DATA_TYPES,
  VALIDATION_STATES,
  VALIDATION_METHODS,
  REWARD_TYPES,
} = require('./types');
const logger = require('../../../utils/logger');

// Create dedicated logger
const popLogger = logger('pop:controller');

/**
 * PoP Consensus Controller
 *
 * Manages the Proof of Publishing consensus process
 */
class PopConsensusController extends EventEmitter {
  constructor(storage, options = {}) {
    super();

    this.storage = storage;
    this.submissions = new Map();
    this.validations = new Map();
    this.rewards = new Map();

    // Configuration options
    this.options = {
      validationTimeout: options.validationTimeout || 300000, // 5 minutes
      minValidations: options.minValidations || 3,
      validationTargetCount: options.validationTargetCount || 5,
      enablePeriodicChecks: options.enablePeriodicChecks !== false,
      checkInterval: options.checkInterval || 60000, // 1 minute
      ...options,
    };

    this.type = 'ProofOfPublishing';
    this.status = 'INITIALIZING';

    // Start periodic validation checks if enabled
    if (this.options.enablePeriodicChecks) {
      this.startPeriodicChecks();
    }

    this.status = 'ACTIVE';
    popLogger.info('Proof of Publishing controller initialized', {
      options: this.options,
    });
  }

  /**
   * Start periodic validation checks
   */
  startPeriodicChecks() {
    popLogger.info('Starting periodic validation checks', {
      interval: this.options.checkInterval,
    });

    this.checkInterval = setInterval(() => {
      this.checkPendingValidations();
    }, this.options.checkInterval);
  }

  /**
   * Stop periodic validation checks
   */
  stopPeriodicChecks() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      popLogger.info('Stopped periodic validation checks');
    }
  }

  /**
   * Check all pending validations for timeouts
   */
  checkPendingValidations() {
    const now = Date.now();
    let expiredCount = 0;

    for (const [submissionId, submission] of this.submissions.entries()) {
      // Skip if not in pending or in-progress state
      if (
        submission.validationState !== VALIDATION_STATES.PENDING &&
        submission.validationState !== VALIDATION_STATES.IN_PROGRESS
      ) {
        continue;
      }

      // Check if validation has timed out
      const elapsed = now - submission.timestamp;
      if (elapsed > this.options.validationTimeout) {
        popLogger.info(`Validation timeout for submission ${submissionId}`, {
          elapsed,
          timeout: this.options.validationTimeout,
        });

        submission.validationState = VALIDATION_STATES.EXPIRED;
        expiredCount++;

        // Emit validation timeout event
        this.emit('validationTimeout', submissionId, submission);
      }
    }

    if (expiredCount > 0) {
      popLogger.info(`Found ${expiredCount} expired validations`);
    }
  }

  /**
   * Create a new environmental data submission
   * @param {Object} data - The submission data
   * @returns {Object} The created submission
   */
  createSubmission(data) {
    // Validate submission data
    if (!data || !data.dataType || !data.location || !data.measurements) {
      throw new Error('Invalid submission data');
    }

    // Check if data type is supported
    if (!Object.values(ENV_DATA_TYPES).includes(data.dataType)) {
      throw new Error(`Unsupported data type: ${data.dataType}`);
    }

    // Create submission object
    const submissionId = data.submissionId || `pop-${uuidv4()}`;
    const timestamp = data.timestamp
      ? new Date(data.timestamp).getTime()
      : Date.now();

    const submission = {
      submissionId,
      dataType: data.dataType,
      submitterId: data.submitterId,
      location: data.location,
      measurements: data.measurements,
      metadata: data.metadata || {},
      timestamp,
      validationState: VALIDATION_STATES.PENDING,
      validations: [],
      rewards: [],
    };

    // Store submission
    this.submissions.set(submissionId, submission);

    popLogger.info(`Created new ${data.dataType} submission: ${submissionId}`, {
      submitter: data.submitterId,
      measurementCount: data.measurements.length,
    });

    // Emit submission created event
    this.emit('submissionCreated', submission);

    return submission;
  }

  /**
   * Get a submission by ID
   * @param {string} submissionId - The submission ID
   * @returns {Object} The submission
   */
  getSubmission(submissionId) {
    const submission = this.submissions.get(submissionId);
    if (!submission) {
      return null;
    }
    return submission;
  }

  /**
   * Get all submissions
   * @param {Object} filters - Optional filters
   * @returns {Array} Array of submissions
   */
  getSubmissions(filters = {}) {
    let submissions = Array.from(this.submissions.values());

    // Apply filters if provided
    if (filters.dataType) {
      submissions = submissions.filter(s => s.dataType === filters.dataType);
    }

    if (filters.submitterId) {
      submissions = submissions.filter(
        s => s.submitterId === filters.submitterId
      );
    }

    if (filters.validationState) {
      submissions = submissions.filter(
        s => s.validationState === filters.validationState
      );
    }

    if (filters.fromTimestamp) {
      submissions = submissions.filter(
        s => s.timestamp >= filters.fromTimestamp
      );
    }

    if (filters.toTimestamp) {
      submissions = submissions.filter(s => s.timestamp <= filters.toTimestamp);
    }

    // Sort by timestamp (most recent first)
    submissions.sort((a, b) => b.timestamp - a.timestamp);

    // Apply limit if provided
    if (filters.limit && filters.limit > 0) {
      submissions = submissions.slice(0, filters.limit);
    }

    return submissions;
  }

  /**
   * Add a validation attestation for a submission
   * @param {string} submissionId - The submission ID
   * @param {Object} attestation - The validation attestation
   * @returns {Object} The updated submission
   */
  addValidation(submissionId, attestation) {
    const submission = this.submissions.get(submissionId);
    if (!submission) {
      throw new Error(`Submission not found: ${submissionId}`);
    }

    // Check if submission can be validated
    if (
      submission.validationState !== VALIDATION_STATES.PENDING &&
      submission.validationState !== VALIDATION_STATES.IN_PROGRESS
    ) {
      throw new Error(
        `Submission cannot be validated: ${submission.validationState}`
      );
    }

    // Check if validator has already validated this submission
    if (
      submission.validations.some(
        v => v.validatorId === attestation.validatorId
      )
    ) {
      throw new Error(
        `Validator has already validated this submission: ${attestation.validatorId}`
      );
    }

    // Create validation object
    const attestationId = attestation.attestationId || `att-${uuidv4()}`;
    const timestamp = attestation.timestamp
      ? new Date(attestation.timestamp).getTime()
      : Date.now();

    const validation = {
      attestationId,
      validatorId: attestation.validatorId,
      validationResult: attestation.validationResult,
      confidenceScore: attestation.confidenceScore || 0.5,
      attestationMethod:
        attestation.attestationMethod || VALIDATION_METHODS.CROSS_REFERENCE,
      notes: attestation.notes || '',
      metadata: attestation.metadata || {},
      timestamp,
    };

    // Add validation to submission
    submission.validations.push(validation);

    // Update validation state if this is the first validation
    if (submission.validationState === VALIDATION_STATES.PENDING) {
      submission.validationState = VALIDATION_STATES.IN_PROGRESS;
    }

    popLogger.info(
      `Added validation ${attestationId} for submission ${submissionId}`,
      {
        validationResult: attestation.validationResult,
        confidenceScore: attestation.confidenceScore,
        attestationMethod: attestation.attestationMethod,
      }
    );

    // Emit validation update event
    this.emit('validationUpdate', submissionId, validation);

    // Check if we have enough validations to finalize
    this.checkValidationCompletion(submissionId);

    return submission;
  }

  /**
   * Check if a submission has received enough validations to finalize
   * @param {string} submissionId - The submission ID
   * @returns {boolean} Whether validation is complete
   */
  checkValidationCompletion(submissionId) {
    const submission = this.submissions.get(submissionId);
    if (!submission) {
      return false;
    }

    // Skip if not in progress
    if (submission.validationState !== VALIDATION_STATES.IN_PROGRESS) {
      return false;
    }

    // Check if we have enough validations
    if (submission.validations.length < this.options.minValidations) {
      return false;
    }

    // Check if we have reached the target count
    const targetReached =
      submission.validations.length >= this.options.validationTargetCount;

    // Calculate validation result
    const validCount = submission.validations.filter(
      v => v.validationResult
    ).length;
    const totalCount = submission.validations.length;
    const validRatio = validCount / totalCount;

    // Require at least 2/3 majority for validation to pass
    const isValid = validRatio >= 2 / 3;

    // If target reached or we have a decisive majority, finalize validation
    if (
      targetReached ||
      validCount >= this.options.minValidations ||
      totalCount - validCount >= this.options.minValidations
    ) {
      submission.validationState = isValid
        ? VALIDATION_STATES.VALIDATED
        : VALIDATION_STATES.REJECTED;

      popLogger.info(`Validation completed for submission ${submissionId}`, {
        validCount,
        totalCount,
        validRatio,
        result: submission.validationState,
      });

      // Calculate and issue rewards if validated
      let rewards = [];
      if (isValid) {
        rewards = this.calculateRewards(submissionId);
      }

      // Emit validation completed event
      this.emit('validationCompleted', submissionId, isValid, rewards);

      return true;
    }

    return false;
  }

  /**
   * Force finalize validation for a submission
   * @param {string} submissionId - The submission ID
   * @returns {Object} Finalization result
   */
  finalizeValidation(submissionId) {
    const submission = this.submissions.get(submissionId);
    if (!submission) {
      throw new Error(`Submission not found: ${submissionId}`);
    }

    // Skip if already finalized
    if (
      submission.validationState === VALIDATION_STATES.VALIDATED ||
      submission.validationState === VALIDATION_STATES.REJECTED
    ) {
      return {
        submissionId,
        validationState: submission.validationState,
        skipped: true,
        message: 'Validation already finalized',
      };
    }

    // Calculate validation result
    const validCount = submission.validations.filter(
      v => v.validationResult
    ).length;
    const totalCount = submission.validations.length;

    // Require at least 2/3 majority for validation to pass, and minimum validations
    const validRatio = totalCount > 0 ? validCount / totalCount : 0;
    const hasMinValidations = totalCount >= this.options.minValidations;
    const isValid = hasMinValidations && validRatio >= 2 / 3;

    submission.validationState = isValid
      ? VALIDATION_STATES.VALIDATED
      : hasMinValidations
        ? VALIDATION_STATES.REJECTED
        : VALIDATION_STATES.EXPIRED;

    popLogger.info(
      `Manually finalized validation for submission ${submissionId}`,
      {
        validCount,
        totalCount,
        validRatio,
        hasMinValidations,
        result: submission.validationState,
      }
    );

    // Calculate and issue rewards if validated
    let rewards = [];
    if (isValid) {
      rewards = this.calculateRewards(submissionId);
    }

    // Emit validation completed event
    this.emit('validationCompleted', submissionId, isValid, rewards);

    return {
      submissionId,
      validationState: submission.validationState,
      isValid,
      validCount,
      totalCount,
      validRatio,
      rewards,
    };
  }

  /**
   * Calculate rewards for a validated submission
   * @param {string} submissionId - The submission ID
   * @returns {Array} Calculated rewards
   */
  calculateRewards(submissionId) {
    const submission = this.submissions.get(submissionId);
    if (!submission) {
      return [];
    }

    const rewards = [];

    // Only calculate rewards for validated submissions
    if (submission.validationState !== VALIDATION_STATES.VALIDATED) {
      return rewards;
    }

    // Create reward for submitter
    const submitterReward = {
      rewardId: `reward-${uuidv4()}`,
      submissionId,
      recipientId: submission.submitterId,
      amount: 50, // Base reward for submitting
      type: REWARD_TYPES.SUBMISSION,
      timestamp: Date.now(),
    };

    rewards.push(submitterReward);

    // Create rewards for validators
    for (const validation of submission.validations) {
      // Only reward validators who correctly validated
      const correctValidation = validation.validationResult === true;

      if (correctValidation) {
        const validatorReward = {
          rewardId: `reward-${uuidv4()}`,
          submissionId,
          recipientId: validation.validatorId,
          amount: 10, // Base reward for validation
          type: REWARD_TYPES.VALIDATION,
          timestamp: Date.now(),
        };

        rewards.push(validatorReward);
      }
    }

    // Store rewards
    for (const reward of rewards) {
      this.rewards.set(reward.rewardId, reward);
    }

    // Add rewards to submission
    submission.rewards = [...submission.rewards, ...rewards];

    popLogger.info(
      `Calculated ${rewards.length} rewards for submission ${submissionId}`,
      {
        submitterReward: rewards.filter(r => r.type === REWARD_TYPES.SUBMISSION)
          .length,
        validatorRewards: rewards.filter(
          r => r.type === REWARD_TYPES.VALIDATION
        ).length,
      }
    );

    return rewards;
  }

  /**
   * Get rewards for a submission
   * @param {string} submissionId - The submission ID
   * @returns {Array} Rewards for the submission
   */
  getRewards(submissionId) {
    const submission = this.submissions.get(submissionId);
    if (!submission) {
      return [];
    }

    return submission.rewards;
  }

  /**
   * Get statistics about the PoP consensus mechanism
   * @returns {Object} Statistics
   */
  getStats() {
    const submissions = Array.from(this.submissions.values());

    // Count submissions by state
    const submissionsByState = {};
    for (const state of Object.values(VALIDATION_STATES)) {
      submissionsByState[state] = submissions.filter(
        s => s.validationState === state
      ).length;
    }

    // Count submissions by data type
    const submissionsByType = {};
    for (const type of Object.values(ENV_DATA_TYPES)) {
      submissionsByType[type] = submissions.filter(
        s => s.dataType === type
      ).length;
    }

    // Calculate validation statistics
    const validationCount = submissions.reduce(
      (sum, s) => sum + s.validations.length,
      0
    );
    const avgValidationsPerSubmission =
      submissions.length > 0 ? validationCount / submissions.length : 0;

    // Calculate reward statistics
    const rewardCount = Array.from(this.rewards.values()).length;
    const rewardsByType = {};
    for (const type of Object.values(REWARD_TYPES)) {
      rewardsByType[type] = Array.from(this.rewards.values()).filter(
        r => r.type === type
      ).length;
    }

    return {
      totalSubmissions: submissions.length,
      submissionsByState,
      submissionsByType,
      validationCount,
      avgValidationsPerSubmission,
      rewardCount,
      rewardsByType,
      activeValidations: submissions.filter(
        s =>
          s.validationState === VALIDATION_STATES.PENDING ||
          s.validationState === VALIDATION_STATES.IN_PROGRESS
      ).length,
    };
  }

  /**
   * Clean up the controller
   */
  cleanup() {
    this.stopPeriodicChecks();
    this.removeAllListeners();
    this.status = 'STOPPED';
    popLogger.info('Proof of Publishing controller cleanup complete');
  }
}

module.exports = PopConsensusController;
