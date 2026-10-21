/**
 * Proof of Publishing (PoP) Types
 *
 * This module defines the data types and validation states for the PoP consensus mechanism.
 */

/**
 * Environmental Data Types
 * These are the different types of environmental data that can be submitted.
 */
const ENV_DATA_TYPES = {
  WEATHER: 'WEATHER',
  AIR_QUALITY: 'AIR_QUALITY',
  WATER_QUALITY: 'WATER_QUALITY',
  SOIL: 'SOIL',
  CLIMATE: 'CLIMATE',
  BIODIVERSITY: 'BIODIVERSITY',
  ECOSYSTEM: 'ECOSYSTEM',
};

/**
 * Validation States
 * These are the different states a submission can be in during the validation process.
 */
const VALIDATION_STATES = {
  PENDING: 'PENDING', // Initial state, awaiting validation
  IN_PROGRESS: 'IN_PROGRESS', // Validation has begun
  VALIDATED: 'VALIDATED', // Successfully validated
  REJECTED: 'REJECTED', // Validation failed
  EXPIRED: 'EXPIRED', // Timeout reached before validation complete
  DISPUTED: 'DISPUTED', // Results are disputed and under review
};

/**
 * Validation Method Types
 * These are the different methods that can be used to validate submissions.
 */
const VALIDATION_METHODS = {
  CROSS_REFERENCE: 'CROSS_REFERENCE', // Compare with other data sources
  SENSOR_VERIFICATION: 'SENSOR_VERIFICATION', // Verify using physical sensors
  PEER_REVIEW: 'PEER_REVIEW', // Reviewed by other nodes/specialists
  AI_ANALYSIS: 'AI_ANALYSIS', // Analyzed using AI models
  HISTORICAL_COMPARISON: 'HISTORICAL_COMPARISON', // Compare with historical data
  REDUNDANT_SOURCES: 'REDUNDANT_SOURCES', // Verified against multiple sources
};

/**
 * Reward Types
 * These are the different types of rewards that can be given for participation.
 */
const REWARD_TYPES = {
  SUBMISSION: 'SUBMISSION', // Reward for submitting data
  VALIDATION: 'VALIDATION', // Reward for validating submissions
  ACCURACY_BONUS: 'ACCURACY_BONUS', // Bonus for highly accurate data
  CONSISTENCY_BONUS: 'CONSISTENCY_BONUS', // Bonus for consistent submissions
  EARLY_VERIFICATION: 'EARLY_VERIFICATION', // Bonus for quick verification
  CRITICAL_DATA: 'CRITICAL_DATA', // Bonus for data in critical areas
};

/**
 * Confidence Levels
 * These represent the confidence level in the validation result.
 */
const CONFIDENCE_LEVELS = {
  LOW: 'LOW', // 0-0.33
  MEDIUM: 'MEDIUM', // 0.34-0.66
  HIGH: 'HIGH', // 0.67-0.89
  VERY_HIGH: 'VERY_HIGH', // 0.9-1.0
};

/**
 * Calculate confidence level from score
 * @param {number} score - A decimal number between 0 and 1
 * @returns {string} The corresponding confidence level
 */
function getConfidenceLevel(score) {
  if (score >= 0.9) return CONFIDENCE_LEVELS.VERY_HIGH;
  if (score >= 0.67) return CONFIDENCE_LEVELS.HIGH;
  if (score >= 0.34) return CONFIDENCE_LEVELS.MEDIUM;
  return CONFIDENCE_LEVELS.LOW;
}

module.exports = {
  ENV_DATA_TYPES,
  VALIDATION_STATES,
  VALIDATION_METHODS,
  REWARD_TYPES,
  CONFIDENCE_LEVELS,
  getConfidenceLevel,
};
