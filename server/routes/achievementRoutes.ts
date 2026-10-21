/**
 * Achievement Routes for Wrfcoin Core
 *
 * This file defines the API routes for managing achievements, badges,
 * and WrfView app integration.
 */

import express from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import { walletMayOnlyUseOwnUserId } from '../middleware/wallet-ownership.js';
import * as achievementController from '../controllers/achievementController.js';
import { requireWiredStorage } from '../middleware/require-wired-storage.js';

const router = express.Router();

// All achievement operations require authentication (#231)
router.use(authenticateJWT);
// backend#1297: a wallet-login caller may address only its own users row.
router.param('userId', walletMayOnlyUseOwnUserId);

// backend#1145: every handler below (getUserAchievements(number),
// calculateGovernanceWeight, calculateReputationBoost, awardAchievement, …)
// is a "Mock implementation" computed from the userId; no storage implements
// the achievement methods. Answer 501 until a real implementation is injected.
router.use(requireWiredStorage('achievement', { see: 'wrfcoin/backend#1145' }));
import { createLogger } from '../../utils/logger.js';
const logger = createLogger('routes:achievements');

function sendInternalServerError(
  res: express.Response,
  context: string,
  error: unknown
): express.Response {
  const errorMessage =
    error instanceof Error ? error.message : 'Unknown error occurred';
  const errorString =
    error instanceof Error ? error.toString() : String(error);

  logger.error(context, { error: errorString, message: errorMessage });

  return res.status(500).json({
    error: 'Internal server error',
    message: 'An unexpected error occurred',
  });
}

/**
 * Get all achievements for a user
 * GET /api/achievement/:userId
 */
router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    logger.info(`Getting achievements for user ${userId}`);
    const result = await achievementController.getUserAchievements(
      parseInt(userId, 10)
    );

    return res.json(result);
  } catch (error: unknown) {
    return sendInternalServerError(res, 'Error getting achievements for user', error);
  }
});

/**
 * Get governance weight for a user
 * GET /api/achievement/:userId/governanceWeight
 */
router.get('/:userId/governanceWeight', async (req, res) => {
  try {
    const { userId } = req.params;

    logger.info(`Getting governance weight for user ${userId}`);
    const governanceWeight =
      await achievementController.calculateGovernanceWeight(
        parseInt(userId, 10)
      );

    return res.json({
      success: true,
      userId: parseInt(userId, 10),
      governanceWeight,
    });
  } catch (error: unknown) {
    return sendInternalServerError(res, 'Error getting governance weight', error);
  }
});

/**
 * Get reputation boost for a user
 * GET /api/achievement/:userId/reputationBoost
 */
router.get('/:userId/reputationBoost', async (req, res) => {
  try {
    const { userId } = req.params;

    logger.info(`Getting reputation boost for user ${userId}`);
    const reputationBoost =
      await achievementController.calculateReputationBoost(
        parseInt(userId, 10)
      );

    return res.json({
      success: true,
      userId: parseInt(userId, 10),
      reputationBoost,
    });
  } catch (error: unknown) {
    return sendInternalServerError(res, 'Error getting reputation boost', error);
  }
});

/**
 * Award achievement to a user
 * POST /api/achievement/:userId/award
 * Body: { achievementId, walletAddress, evidenceData }
 */
router.post('/:userId/award', async (req, res) => {
  try {
    const { userId } = req.params;
    const { achievementId, walletAddress, evidenceData } = req.body;

    if (!achievementId || !walletAddress) {
      return res
        .status(400)
        .json({
          error: 'Missing required fields: achievementId and walletAddress',
        });
    }

    logger.info(`Awarding achievement ${achievementId} to user ${userId}`);
    const result = await achievementController.awardAchievement(
      parseInt(userId, 10),
      walletAddress,
      achievementId,
      evidenceData || {}
    );

    return res.status(201).json({
      success: true,
      message: 'Achievement awarded successfully',
      data: result,
    });
  } catch (error: unknown) {
    return sendInternalServerError(res, 'Error awarding achievement', error);
  }
});

/**
 * Update achievement progress
 * POST /api/achievement/:userId/progress
 * Body: { achievementId, walletAddress, progressValue }
 */
router.post('/:userId/progress', async (req, res) => {
  try {
    const { userId } = req.params;
    const { achievementId, walletAddress, progressValue } = req.body;

    if (!achievementId || !walletAddress || progressValue === undefined) {
      return res
        .status(400)
        .json({
          error:
            'Missing required fields: achievementId, walletAddress, and progressValue',
        });
    }

    logger.info(
      `Updating progress for achievement ${achievementId} for user ${userId}`
    );
    const result = await achievementController.updateAchievementProgress(
      parseInt(userId, 10),
      walletAddress,
      achievementId,
      parseInt(progressValue, 10)
    );

    return res.status(200).json({
      success: true,
      message: 'Achievement progress updated successfully',
      data: result,
    });
  } catch (error: unknown) {
    return sendInternalServerError(res, 'Error updating achievement progress', error);
  }
});

/**
 * Get upgrade path for a badge
 * GET /api/achievement/badges/:badgeId/upgradePath
 * Query: { currentTier }
 */
router.get('/badges/:badgeId/upgradePath', async (req, res) => {
  try {
    const { badgeId } = req.params;
    const { currentTier } = req.query;

    if (!currentTier) {
      return res
        .status(400)
        .json({ error: 'Missing required query parameter: currentTier' });
    }

    logger.info(
      `Getting upgrade path for badge ${badgeId} from tier ${currentTier}`
    );
    const result = await achievementController.getBadgeUpgradePath(
      badgeId,
      currentTier as string
    );

    return res.status(200).json({
      success: true,
      message: 'Badge upgrade path retrieved successfully',
      data: result,
    });
  } catch (error: unknown) {
    return sendInternalServerError(res, 'Error getting badge upgrade path', error);
  }
});

/**
 * Sync achievement with WrfView app
 * POST /api/achievement/sync
 * Body: { userAchievementId }
 */
router.post('/sync', async (req, res) => {
  try {
    const { userAchievementId } = req.body;

    if (!userAchievementId) {
      return res
        .status(400)
        .json({ error: 'Missing required field: userAchievementId' });
    }

    logger.info(
      `Syncing user achievement ${userAchievementId} with WrfView app`
    );
    const result =
      await achievementController.syncWithWrfView(userAchievementId);

    return res.status(200).json({
      success: true,
      message: 'Achievement synced with WrfView successfully',
      data: result,
    });
  } catch (error: unknown) {
    return sendInternalServerError(res, 'Error syncing with WrfView app', error);
  }
});

/**
 * Recalculate all metrics for a user
 * POST /api/achievement/:userId/recalculate
 */
router.post('/:userId/recalculate', async (req, res) => {
  try {
    const { userId } = req.params;

    logger.info(`Recalculating metrics for user ${userId}`);
    const result = await achievementController.recalculateUserMetrics(
      parseInt(userId, 10)
    );

    return res.status(200).json({
      success: true,
      message: 'User metrics recalculated successfully',
      data: result,
    });
  } catch (error: unknown) {
    return sendInternalServerError(res, 'Error recalculating user metrics', error);
  }
});

// NOTE: The categories endpoint is now defined directly in server.js to avoid route conflicts

export default router;
