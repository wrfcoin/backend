/**
 * Simulation Routes - Transaction Preflight Endpoints
 * Issue #207: Read-only simulation for governance, rewards, and bridge transfers
 */

import express from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import { createRateLimitMiddleware } from '../../shared/middleware/rate-limit-redis.js';
import {
  simulateGovernanceAction,
  simulateRewardDistribution,
  simulateBridgeTransfer,
} from '../controllers/simulationController.js';

const router = express.Router();

// Rate limiters for simulation endpoints
const governanceRateLimit = createRateLimitMiddleware({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 30,
  keyPrefix: 'ratelimit:sim:governance',
  message: 'Too many governance simulation requests, please try again later.',
});

const rewardRateLimit = createRateLimitMiddleware({
  windowMs: 60 * 1000,
  maxRequests: 30,
  keyPrefix: 'ratelimit:sim:reward',
  message: 'Too many reward simulation requests, please try again later.',
});

const bridgeRateLimit = createRateLimitMiddleware({
  windowMs: 60 * 1000,
  maxRequests: 20,
  keyPrefix: 'ratelimit:sim:bridge',
  message: 'Too many bridge simulation requests, please try again later.',
});

// All simulation endpoints require JWT authentication
router.post('/simulate/governance', authenticateJWT, governanceRateLimit, simulateGovernanceAction);
router.post('/simulate/reward', authenticateJWT, rewardRateLimit, simulateRewardDistribution);
router.post('/simulate/bridge', authenticateJWT, bridgeRateLimit, simulateBridgeTransfer);

export default router;
