import express from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import climatePrivacyIntegrationController from '../controllers/climatePrivacyIntegrationController.js';
import rateLimit from 'express-rate-limit';

const router = express.Router();

// All climate privacy integration operations require authentication (#231)
router.use(authenticateJWT);

// Rate limiting for privacy integration operations
const integrationRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    success: false,
    message:
      'Too many privacy integration requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict rate limiting for transaction processing (more resource intensive)
const strictIntegrationRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 25, // Limit each IP to 25 transaction processing requests per windowMs
  message: {
    success: false,
    message:
      'Too many transaction processing requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Routes for integrated climate privacy system

/**
 * @route POST /api/climate-privacy-integration/process
 * @desc Process a climate transaction through the integrated privacy system
 * @access Public (with strict rate limiting)
 * @body transactionType - Type of climate transaction (weather_data, carbon_credit, climate_fund)
 * @body privacyLevel - Privacy level (basic, enhanced, maximum, selective_disclosure)
 * @body [transaction-specific fields] - Fields specific to the transaction type
 * @body [privacy configuration] - Privacy feature enablement flags
 */
(router as any).post(
  '/process',
  strictIntegrationRateLimit,
  climatePrivacyIntegrationController.processTransaction
);

/**
 * @route GET /api/climate-privacy-integration/statistics
 * @desc Get comprehensive statistics for the climate privacy integration system
 * @access Public (with rate limiting)
 */
(router as any).get(
  '/statistics',
  integrationRateLimit,
  climatePrivacyIntegrationController.getStatistics
);

/**
 * @route POST /api/climate-privacy-integration/validate-configuration
 * @desc Validate a climate privacy transaction configuration before processing
 * @access Public (with rate limiting)
 * @body transactionType - Type of climate transaction
 * @body privacyLevel - Privacy level
 * @body [configuration options] - Privacy feature configuration
 */
(router as any).post(
  '/validate-configuration',
  integrationRateLimit,
  climatePrivacyIntegrationController.validateConfiguration
);

/**
 * @route GET /api/climate-privacy-integration/recommendations
 * @desc Get optimal privacy configuration recommendations for a transaction
 * @access Public (with rate limiting)
 * @query transactionType - Type of climate transaction
 * @query regionCode - Regional code for compliance considerations (optional)
 * @query amount - Transaction amount for threshold considerations (optional)
 */
(router as any).get(
  '/recommendations',
  integrationRateLimit,
  climatePrivacyIntegrationController.getRecommendations
);

export default router;
