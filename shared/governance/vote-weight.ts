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

import { db } from '../../server/db.js';
import { appLogger } from '../../server/utils/logger.js';
import { eq, sql } from 'drizzle-orm';
// We use raw queries instead of the Drizzle ORM for more flexible access patterns
import { QueryResult } from '@neondatabase/serverless';

// Constants
export const ACHIEVEMENT_WEIGHT_MULTIPLIER = 0.2;
export const REPUTATION_WEIGHT_MULTIPLIER = 0.3;
export const WRFCOIN_FOUNDATION_LAUNCH_DATE = new Date('2025-01-01');
export const FOUNDATION_CONTROL_YEARS = 10;

// TTL cache for slowly-changing achievement/reputation weights (5 min)
const CACHE_TTL_MS = 5 * 60 * 1000;
const weightCache = new Map<string, { value: number; expires: number }>();

function getCached(key: string): number | undefined {
  const entry = weightCache.get(key);
  if (entry && entry.expires > Date.now()) return entry.value;
  if (entry) weightCache.delete(key);
  return undefined;
}

function setCache(key: string, value: number): void {
  weightCache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

/**
 * Calculate the foundation veto expiry date
 * @returns Date when the foundation's veto power expires
 */
export function calculateFoundationVetoExpiry(): Date {
  const expiryDate = new Date(WRFCOIN_FOUNDATION_LAUNCH_DATE);
  expiryDate.setFullYear(expiryDate.getFullYear() + FOUNDATION_CONTROL_YEARS);
  return expiryDate;
}

/**
 * Check if foundation veto power is still active
 * @returns Boolean indicating if veto power is still active
 */
export function isFoundationVetoActive(): boolean {
  const now = new Date();
  return now < calculateFoundationVetoExpiry();
}

/**
 * Calculate quadratic voting weight from token amount
 * Weight = sqrt(tokens)
 *
 * @param tokenAmount The amount of tokens held by the voter
 * @returns The quadratic voting weight
 */
export function calculateQuadraticWeight(tokenAmount: number): number {
  return Math.sqrt(tokenAmount);
}

/**
 * Calculate achievement badge weight
 *
 * @param userAddress The address of the voter
 * @returns The achievement weight modifier (0.0 - 1.0)
 */
export async function calculateAchievementWeight(
  userAddress: string
): Promise<number> {
  const cached = getCached(`ach:${userAddress}`);
  if (cached !== undefined) return cached;

  try {
    const userAchievements = await db.execute(
      sql`SELECT category FROM achievements WHERE user_address = ${userAddress} LIMIT 100`
    );

    // Check if we got any achievements back
    if (
      !userAchievements ||
      userAchievements.length === 0
    ) {
      return 0;
    }

    // Calculate weight based on achievements
    // Different achievements have different weights
    let totalWeight = 0;

    for (const achievement of userAchievements) {
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
    const result = Math.min(totalWeight, 1.0);
    setCache(`ach:${userAddress}`, result);
    return result;
  } catch (error) {
    appLogger.error('Error calculating achievement weight', { module: 'VoteWeight', error: error instanceof Error ? error.message : String(error) });
    return 0;
  }
}

/**
 * Calculate reputation weight based on node operations
 *
 * @param userAddress The address of the voter
 * @returns The reputation weight modifier (0.0 - 1.0)
 */
export async function calculateReputationWeight(
  userAddress: string
): Promise<number> {
  const cached = getCached(`rep:${userAddress}`);
  if (cached !== undefined) return cached;

  try {
    const nodeReputation = await getNodeReputation(userAddress);
    const result = Math.min(nodeReputation / 100, 1.0);
    setCache(`rep:${userAddress}`, result);
    return result;
  } catch (error) {
    appLogger.error('Error calculating reputation weight', { module: 'VoteWeight', error: error instanceof Error ? error.message : String(error) });
    return 0;
  }
}

/**
 * Calculate the total voting weight for a user
 *
 * @param userAddress The address of the voter
 * @param tokenAmount The amount of tokens held by the voter
 * @returns The total voting weight
 */
export async function calculateTotalVoteWeight(
  userAddress: string,
  tokenAmount: number
): Promise<number> {
  // Calculate base weight using quadratic voting
  const baseWeight = calculateQuadraticWeight(tokenAmount);

  // Fetch achievement and reputation weights in parallel (independent DB queries)
  const [achievementWeight, reputationWeight] = await Promise.all([
    calculateAchievementWeight(userAddress),
    calculateReputationWeight(userAddress),
  ]);

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
 * @param userAddress The address of the user
 * @returns Boolean indicating if user has veto rights
 */
export async function hasVetoRights(userAddress: string): Promise<boolean> {
  try {
    // Only check if foundation veto is still active
    if (!isFoundationVetoActive()) {
      return false;
    }

    // Check if user is a foundation member with veto rights
    // Using prepared statements for security
    const result = await db.execute(
      sql`SELECT * FROM governance_foundation_members WHERE address = ${userAddress} AND veto_rights = true LIMIT 1`
    );

    return result && result.length > 0;
  } catch (error) {
    appLogger.error('Error checking veto rights', { module: 'VoteWeight', error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/**
 * Get node reputation score from the node reputation system
 *
 * @param userAddress The address of the node operator
 * @returns Reputation score (0-100)
 */
async function getNodeReputation(userAddress: string): Promise<number> {
  // In a real implementation, this would query your node reputation database
  // For demonstration purposes, this is simplified

  try {
    // Query node reputation scores from the database using prepared statement for security
    const result = await db.execute(
      sql`SELECT reputation_score FROM node_reputation WHERE address = ${userAddress} LIMIT 1`
    );

    if (result && result.length > 0) {
      const score = result[0].reputation_score;
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
