/**
 * Vote Weight Calculator for Wrfcoin Governance
 *
 * This module handles the calculation of voting weights based on multiple factors:
 * - Token holdings (with quadratic voting)
 * - Achievement badges
 * - Node reputation
 *
 * The Wrfcoin governance model uses a sophisticated weighting system that
 * balances token ownership with demonstrated contribution to the network.
 */

const { db } = require('../../server/db');
const { appLogger } = require('../../server/utils/logger.js');

// Constants
const ACHIEVEMENT_WEIGHT_MULTIPLIER = 0.2;
const REPUTATION_WEIGHT_MULTIPLIER = 0.3;
const WRFCOIN_FOUNDATION_LAUNCH_DATE = new Date('2025-01-01');
const FOUNDATION_CONTROL_YEARS = 10;

/**
 * Calculate the foundation veto expiry date
 * @returns Date when the foundation's veto power expires
 */
function calculateFoundationVetoExpiry() {
  const expiryDate = new Date(WRFCOIN_FOUNDATION_LAUNCH_DATE);
  expiryDate.setFullYear(expiryDate.getFullYear() + FOUNDATION_CONTROL_YEARS);
  return expiryDate;
}

/**
 * Check if foundation veto power is still active
 * @returns Boolean indicating if veto power is still active
 */
function isFoundationVetoActive() {
  const now = new Date();
  return now < calculateFoundationVetoExpiry();
}

/**
 * Calculate quadratic voting weight from token amount
 * Weight = sqrt(tokens)
 *
 * @param {number} tokenAmount The amount of tokens held by the voter
 * @returns {number} The quadratic voting weight
 */
function calculateQuadraticWeight(tokenAmount) {
  return Math.sqrt(tokenAmount);
}

/**
 * Calculate achievement badge weight
 *
 * @param {string} userAddress The address of the voter
 * @returns {Promise<number>} The achievement weight modifier (0.0 - 1.0)
 */
async function calculateAchievementWeight(userAddress) {
  try {
    // Get user achievements using parameterized query to prevent SQL injection
    const query = 'SELECT * FROM achievements WHERE user_address = $1';
    const userAchievements = await db.execute(query, [userAddress]);

    // Check if we got any achievements back
    if (
      !userAchievements ||
      !userAchievements.rows ||
      userAchievements.rows.length === 0
    ) {
      return 0;
    }

    // Calculate weight based on achievements
    // Different achievements have different weights
    let totalWeight = 0;

    for (const achievement of userAchievements.rows) {
      // Get the achievement category or type
      const achievementCategory = achievement.category
        ? String(achievement.category)
        : 'OTHER';

      switch (achievementCategory) {
        case 'DATA_CONTRIBUTOR':
          totalWeight += 0.5;
          break;
        case 'VALIDATOR':
          totalWeight += 0.7;
          break;
        case 'FORECASTER':
          totalWeight += 0.6;
          break;
        case 'DEVELOPER':
          totalWeight += 0.8;
          break;
        case 'GOVERNANCE_PARTICIPANT':
          totalWeight += 0.4;
          break;
        default:
          totalWeight += 0.1;
      }
    }

    // Cap the total achievement weight at 1.0
    return Math.min(totalWeight, 1.0);
  } catch (error) {
    appLogger.error('Error calculating achievement weight', { module: 'VoteWeight', error: error instanceof Error ? error.message : String(error) });
    return 0;
  }
}

/**
 * Calculate reputation weight based on node operations
 *
 * @param {string} userAddress The address of the voter
 * @returns {Promise<number>} The reputation weight modifier (0.0 - 1.0)
 */
async function calculateReputationWeight(userAddress) {
  try {
    // Get node reputation from the node reputation system
    const nodeReputation = await getNodeReputation(userAddress);

    // Normalize reputation to 0.0 - 1.0
    return Math.min(nodeReputation / 100, 1.0);
  } catch (error) {
    appLogger.error('Error calculating reputation weight', { module: 'VoteWeight', error: error instanceof Error ? error.message : String(error) });
    return 0;
  }
}

/**
 * Calculate the total voting weight for a user
 *
 * @param {string} userAddress The address of the voter
 * @param {number} tokenAmount The amount of tokens held by the voter
 * @returns {Promise<number>} The total voting weight
 */
async function calculateTotalVoteWeight(userAddress, tokenAmount) {
  // Calculate base weight using quadratic voting
  const baseWeight = calculateQuadraticWeight(tokenAmount);

  // Get achievement weight
  const achievementWeight = await calculateAchievementWeight(userAddress);

  // Get reputation weight
  const reputationWeight = await calculateReputationWeight(userAddress);

  // Calculate total weight
  // Base formula: baseWeight * (1 + achievementBonus + reputationBonus)
  const totalWeight =
    baseWeight *
    (1 +
      achievementWeight * ACHIEVEMENT_WEIGHT_MULTIPLIER +
      reputationWeight * REPUTATION_WEIGHT_MULTIPLIER);

  return totalWeight;
}

/**
 * Check if a user is a foundation member with veto rights
 *
 * @param {string} userAddress The address of the user
 * @returns {Promise<boolean>} Boolean indicating if user has veto rights
 */
async function hasVetoRights(userAddress) {
  try {
    // Only check if foundation veto is still active
    if (!isFoundationVetoActive()) {
      return false;
    }

    // Check if user is a foundation member with veto rights using parameterized query
    const query = `
      SELECT * FROM governance_foundation_members 
      WHERE address = $1 
      AND veto_rights = true 
      AND active = true 
      LIMIT 1
    `;
    const result = await db.execute(query, [userAddress]);

    return result.rows && result.rows.length > 0;
  } catch (error) {
    appLogger.error('Error checking veto rights', { module: 'VoteWeight', error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/**
 * Get node reputation score from the node reputation system
 *
 * @param {string} userAddress The address of the node operator
 * @returns {Promise<number>} Reputation score (0-100)
 */
async function getNodeReputation(userAddress) {
  // In a real implementation, this would query your node reputation database
  // For demonstration purposes, this is simplified

  try {
    // Query node reputation scores from the database using parameterized query
    const query =
      'SELECT reputation_score FROM node_reputation WHERE address = $1 LIMIT 1';
    const result = await db.execute(query, [userAddress]);

    if (result.rows && result.rows.length > 0) {
      const score = result.rows[0].reputation_score;
      return typeof score === 'string'
        ? parseFloat(score)
        : typeof score === 'number'
          ? score
          : 0;
    }

    return 0; // Default if no reputation data found
  } catch (error) {
    appLogger.error('Error retrieving node reputation', { module: 'VoteWeight', error: error instanceof Error ? error.message : String(error) });
    return 0;
  }
}

// Export all needed functions
module.exports = {
  calculateQuadraticWeight,
  calculateAchievementWeight,
  calculateReputationWeight,
  calculateTotalVoteWeight,
  hasVetoRights,
  isFoundationVetoActive,
  calculateFoundationVetoExpiry,
  ACHIEVEMENT_WEIGHT_MULTIPLIER,
  REPUTATION_WEIGHT_MULTIPLIER,
  WRFCOIN_FOUNDATION_LAUNCH_DATE,
  FOUNDATION_CONTROL_YEARS,
};
