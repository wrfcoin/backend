/**
 * Validator API Routes
 *
 * This file contains API routes for handling validator data.
 * It provides endpoints for retrieving validators, validator activity,
 * and slashing events.
 */

const express = require('express');
const router = express.Router();
const { db } = require('../db');
const {
  validators,
  validatorActivity,
  slashEvents,
  validatorRewards,
  validatorDelegations,
} = require('../../shared/schema');

// Currency helpers — matches core4 WRF_UNITS_PER_COIN = 10^8
const WRF_UNITS_PER_COIN = 100_000_000n;
/** @param {number} displayAmount @returns {bigint} */
function wrfToBaseUnits(displayAmount) {
  const [whole, frac = ''] = Math.abs(displayAmount).toString().split('.');
  const paddedFrac = frac.padEnd(8, '0').slice(0, 8);
  return BigInt(whole) * WRF_UNITS_PER_COIN + BigInt(paddedFrac);
}
/** @param {bigint} baseUnits @returns {string} */
function baseUnitsToWrf(baseUnits) {
  const whole = baseUnits / WRF_UNITS_PER_COIN;
  const frac = (baseUnits % WRF_UNITS_PER_COIN).toString().padStart(8, '0');
  return `${whole}.${frac}`.replace(/\.?0+$/, '');
}
const { eq, desc, and, gte, lte, count, sql } = require('drizzle-orm');
const { blockchainLogger } = require('../utils/logger');
const { createApiError, paginatedResponse } = require('../utils/api-error');

/**
 * @route   GET /api/validators
 * @desc    Get all validators
 * @access  Public
 */
router.get('/', async (req, res) => {
  try {
    const {
      role,
      status,
      region,
      sortBy = 'staked_amount',
      order = 'desc',
      limit: limitQuery = 50,
      offset: offsetQuery = 0,
    } = req.query;
    const limit = Math.max(1, Number.parseInt(String(limitQuery), 10) || 50);
    const offset = Math.max(0, Number.parseInt(String(offsetQuery), 10) || 0);

    let query = db.select().from(validators);

    // Apply filters if provided
    if (role) {
      query = query.where(eq(validators.role, role));
    }

    if (status) {
      query = query.where(eq(validators.status, status));
    }

    // Apply sorting
    if (sortBy && validators[sortBy]) {
      query =
        order === 'asc'
          ? query.orderBy(validators[sortBy])
          : query.orderBy(desc(validators[sortBy]));
    }

    // Apply pagination
    query = query.limit(limit).offset(offset);

    const validatorsList = await query;

    // Get total count for pagination metadata (#458)
    let totalCountQuery = db.select({ count: count() }).from(validators);
    if (role) totalCountQuery = totalCountQuery.where(eq(validators.role, role));
    if (status) totalCountQuery = totalCountQuery.where(eq(validators.status, status));
    const [{ count: total }] = await totalCountQuery;

    const pageNum = Math.floor(offset / limit) + 1;
    res.json(paginatedResponse(validatorsList, Number(total), pageNum, limit));
  } catch (error) {
    const errorMessage = error ? error.message || 'Unknown error' : 'Unknown error';
    blockchainLogger.error('Error fetching validators', { error: errorMessage });
    res.status(500).json(createApiError('VALIDATORS_FETCH_ERROR', 'Failed to fetch validators'));
  }
});

/**
 * @route   GET /api/validators/:id
 * @desc    Get validator by ID
 * @access  Public
 */
router.get('/:id', async (req, res) => {
  try {
    const validatorId = req.params.id;

    // Get validator details
    const [validator] = await db
      .select()
      .from(validators)
      .where(eq(validators.id, validatorId));

    if (!validator) {
      return res.status(404).json(createApiError('VALIDATOR_NOT_FOUND', 'Validator not found'));
    }

    // Get recent activity
    const activity = await db
      .select()
      .from(validatorActivity)
      .where(eq(validatorActivity.validatorId, validatorId))
      .orderBy(desc(validatorActivity.timestamp))
      .limit(10);

    // Get slash events
    const slashes = await db
      .select()
      .from(slashEvents)
      .where(eq(slashEvents.validatorId, validatorId))
      .orderBy(desc(slashEvents.timestamp))
      .limit(10);

    // Get validator rewards
    const rewards = await db
      .select()
      .from(validatorRewards)
      .where(eq(validatorRewards.validatorId, validatorId))
      .orderBy(desc(validatorRewards.timestamp))
      .limit(10);

    res.json({
      success: true,
      data: {
        validator,
        activity,
        slashes,
        rewards,
      },
    });
  } catch (error) {
    const errorMessage = error
      ? error.message || 'Unknown error'
      : 'Unknown error';
    blockchainLogger.error('Error fetching validator', { error: errorMessage });
    res.status(500).json(createApiError('VALIDATOR_DETAIL_ERROR', 'Failed to fetch validator details'));
  }
});

/**
 * @route   GET /api/validators/stats/overview
 * @desc    Get validator statistics overview
 * @access  Public
 */
router.get('/stats/overview', async (req, res) => {
  try {
    // Get total active validators
    const activeCountResult = await db
      .select({ count: count() })
      .from(validators)
      .where(eq(validators.status, 'ACTIVE'));
    const activeCount = activeCountResult[0]?.count || 0;

    // Get total validators
    const totalCountResult = await db
      .select({ count: count() })
      .from(validators);
    const totalCount = totalCountResult[0]?.count || 0;

    // Get total staked amount
    const totalStakedResult = await db
      .select({ total: sql`SUM(${validators.stakedAmount})` })
      .from(validators);
    const totalStaked = totalStakedResult[0]?.total || 0;

    // Get validators by role
    const roleDistribution = await db
      .select({
        role: validators.role,
        count: count(),
      })
      .from(validators)
      .groupBy(validators.role);

    res.json({
      success: true,
      data: {
        activeValidators: activeCount || 0,
        totalValidators: totalCount || 0,
        totalStaked: totalStaked || 0,
        roleDistribution: roleDistribution || [],
      },
    });
  } catch (error) {
    const errorMessage = error
      ? error.message || 'Unknown error'
      : 'Unknown error';
    blockchainLogger.error('Error fetching validator stats', { error: errorMessage });
    res.status(500).json(createApiError('VALIDATOR_STATS_ERROR', 'Failed to fetch validator statistics'));
  }
});

/**
 * @route   GET /api/validators/:id/rewards
 * @desc    Get rewards for a validator
 * @access  Public
 */
router.get('/:id/rewards', async (req, res) => {
  try {
    const validatorId = req.params.id;
    const { startDate, endDate, rewardType } = req.query;

    let query = db
      .select()
      .from(validatorRewards)
      .where(eq(validatorRewards.validatorId, validatorId));

    // Apply date filters if provided
    if (startDate) {
      query = query.where(gte(validatorRewards.timestamp, new Date(startDate)));
    }

    if (endDate) {
      query = query.where(lte(validatorRewards.timestamp, new Date(endDate)));
    }

    // Filter by reward type if provided
    if (rewardType) {
      query = query.where(eq(validatorRewards.reward_type, rewardType));
    }

    // Order by timestamp
    query = query.orderBy(desc(validatorRewards.timestamp));

    const rewards = await query;

    // Calculate total rewards in base units (avoids float precision loss)
    const totalRewardsUnits = rewards.reduce(
      (sum, reward) => sum + wrfToBaseUnits(Number(reward.amount)),
      0n
    );
    const totalRewards = baseUnitsToWrf(totalRewardsUnits);

    // Group rewards by type (base units per type, then display string)
    const rewardsByTypeUnits = rewards.reduce((acc, reward) => {
      const type = reward.reward_type;
      if (!acc[type]) {
        acc[type] = 0n;
      }
      acc[type] += wrfToBaseUnits(Number(reward.amount));
      return acc;
    }, {});
    const rewardsByType = Object.fromEntries(
      Object.entries(rewardsByTypeUnits).map(([type, units]) => [type, baseUnitsToWrf(units)])
    );

    res.json({
      success: true,
      data: {
        rewards,
        totalRewards,
        rewardsByType,
      },
    });
  } catch (error) {
    const errorMessage = error
      ? error.message || 'Unknown error'
      : 'Unknown error';
    blockchainLogger.error('Error fetching validator rewards', { error: errorMessage });
    res.status(500).json(createApiError('VALIDATOR_REWARDS_ERROR', 'Failed to fetch validator rewards'));
  }
});

/**
 * @route   GET /api/validators/:id/activity
 * @desc    Get activity for a validator
 * @access  Public
 */
router.get('/:id/activity', async (req, res) => {
  try {
    const validatorId = req.params.id;
    const { startDate, endDate, limit = 50, offset = 0 } = req.query;

    let query = db
      .select()
      .from(validatorActivity)
      .where(eq(validatorActivity.validatorId, validatorId));

    // Apply date filters if provided
    if (startDate) {
      query = query.where(
        gte(validatorActivity.timestamp, new Date(startDate))
      );
    }

    if (endDate) {
      query = query.where(lte(validatorActivity.timestamp, new Date(endDate)));
    }

    // Order by timestamp and apply pagination
    query = query
      .orderBy(desc(validatorActivity.timestamp))
      .limit(limit)
      .offset(offset);

    const activity = await query;

    // Calculate performance metrics
    const totalValidations = activity.reduce(
      (sum, item) => sum + (item.validations || 0),
      0
    );
    const successfulValidations = activity.reduce(
      (sum, item) => sum + (item.successful_validations || 0),
      0
    );
    const validationRate =
      totalValidations > 0
        ? (successfulValidations / totalValidations) * 100
        : 0;

    res.json({
      success: true,
      data: {
        activity,
        totalValidations,
        successfulValidations,
        validationRate: parseFloat(validationRate.toFixed(2)),
      },
    });
  } catch (error) {
    const errorMessage = error
      ? error.message || 'Unknown error'
      : 'Unknown error';
    blockchainLogger.error('Error fetching validator activity', { error: errorMessage });
    res.status(500).json(createApiError('VALIDATOR_ACTIVITY_ERROR', 'Failed to fetch validator activity'));
  }
});

/**
 * @route   GET /api/validators/slashing/events
 * @desc    Get slashing events
 * @access  Public
 */
router.get('/slashing/events', async (req, res) => {
  try {
    const { startDate, endDate, limit = 50, offset = 0 } = req.query;

    // Create a proper joined query with clear aliases
    let query = db
      .select({
        slashEvent: {
          id: slashEvents.id,
          reason: slashEvents.reason,
          severity: slashEvents.severity,
          timestamp: slashEvents.timestamp,
          blockHeight: slashEvents.blockHeight,
          penaltyAmount: slashEvents.penaltyAmount,
          penaltyPercentage: slashEvents.penaltyPercentage,
          details: slashEvents.details,
        },
        validator: {
          id: validators.id,
          validatorId: validators.validatorId,
          name: validators.name,
          walletAddress: validators.walletAddress,
        },
      })
      .from(slashEvents)
      .leftJoin(validators, eq(slashEvents.validatorId, validators.id));

    // Apply date filters if provided
    if (startDate) {
      query = query.where(gte(slashEvents.timestamp, new Date(startDate)));
    }

    if (endDate) {
      query = query.where(lte(slashEvents.timestamp, new Date(endDate)));
    }

    // Order by timestamp and apply pagination
    query = query
      .orderBy(desc(slashEvents.timestamp))
      .limit(limit)
      .offset(offset);

    const events = await query;

    // Map the results to the expected format with proper field access
    const formattedEvents = events.map(event => ({
      id: event.slashEvent.id,
      reason: event.slashEvent.reason,
      severity: event.slashEvent.severity,
      timestamp: event.slashEvent.timestamp,
      blockHeight: event.slashEvent.blockHeight,
      penaltyAmount: event.slashEvent.penaltyAmount,
      penaltyPercentage: event.slashEvent.penaltyPercentage,
      details: event.slashEvent.details,
      validator: {
        id: event.validator.id,
        validatorId: event.validator.validatorId,
        name: event.validator.name,
        walletAddress: event.validator.walletAddress,
      },
    }));

    res.json({
      success: true,
      count: formattedEvents.length,
      data: formattedEvents,
    });
  } catch (error) {
    const errorMessage = error
      ? error.message || 'Unknown error'
      : 'Unknown error';
    blockchainLogger.error('Error fetching slashing events', { error: errorMessage });
    res.status(500).json(createApiError('VALIDATOR_SLASHING_ERROR', 'Failed to fetch slashing events'));
  }
});

module.exports = router;
