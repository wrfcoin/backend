import express from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import climateShieldedPoolsController from '../controllers/climateShieldedPoolsController.js';
import rateLimit from 'express-rate-limit';

const router = express.Router();

// All climate shielded pools operations require authentication (#231)
router.use(authenticateJWT);

// Rate limiting for shielded pool operations
const poolRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // Limit each IP to 50 requests per windowMs
  message: {
    success: false,
    message: 'Too many pool requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict rate limiting for pool creation (more resource intensive)
const strictPoolRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 pool creation requests per windowMs
  message: {
    success: false,
    message:
      'Too many pool creation requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Routes for climate shielded pools

/**
 * @route POST /api/climate-shielded-pools/research
 * @desc Create a climate data research pool
 * @access Public (with strict rate limiting)
 */
(router as any).post(
  '/research',
  strictPoolRateLimit,
  climateShieldedPoolsController.createClimateDataResearchPool
);

/**
 * @route POST /api/climate-shielded-pools/carbon-liquidity
 * @desc Create a carbon credit liquidity pool
 * @access Public (with strict rate limiting)
 */
(router as any).post(
  '/carbon-liquidity',
  strictPoolRateLimit,
  climateShieldedPoolsController.createCarbonCreditLiquidityPool
);

/**
 * @route POST /api/climate-shielded-pools/fund-privacy
 * @desc Create a climate fund privacy pool
 * @access Public (with strict rate limiting)
 */
(router as any).post(
  '/fund-privacy',
  strictPoolRateLimit,
  climateShieldedPoolsController.createClimateFundPrivacyPool
);

/**
 * @route GET /api/climate-shielded-pools
 * @desc Get list of all climate shielded pools
 * @access Public (with rate limiting)
 * @query poolType - Filter by pool type (optional)
 * @query status - Filter by status (optional)
 * @query limit - Number of results per page (default: 50)
 * @query offset - Number of results to skip (default: 0)
 */
(router as any).get('/', poolRateLimit, climateShieldedPoolsController.listPools);

/**
 * @route GET /api/climate-shielded-pools/:poolId
 * @desc Get detailed information about a specific climate shielded pool
 * @access Public (with rate limiting)
 */
(router as any).get(
  '/:poolId',
  poolRateLimit,
  climateShieldedPoolsController.getPoolInfo
);

/**
 * @route GET /api/climate-shielded-pools/:poolId/analytics
 * @desc Get analytics and performance metrics for a specific pool
 * @access Public (with rate limiting)
 * @query timeframe - Time period for analytics (7d, 30d, 90d, 1y)
 */
(router as any).get(
  '/:poolId/analytics',
  poolRateLimit,
  climateShieldedPoolsController.getPoolAnalytics
);

/**
 * @route GET /api/climate-shielded-pools/:poolId/access-requirements
 * @desc Get access requirements and credentials needed for a specific pool
 * @access Public (with rate limiting)
 */
(router as any).get(
  '/:poolId/access-requirements',
  poolRateLimit,
  climateShieldedPoolsController.getPoolAccessRequirements
);

export default router;
