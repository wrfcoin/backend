import express, { Router } from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import climatePrivacyController from '../controllers/climatePrivacyController.js';
import rateLimit from 'express-rate-limit';

const router: Router = express.Router();

// All climate privacy operations require authentication (#231)
router.use(authenticateJWT);

// Rate limiting for privacy operations
const privacyRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    success: false,
    message: 'Too many privacy requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict rate limiting for sensitive operations
const strictPrivacyRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Limit each IP to 20 requests per windowMs for sensitive operations
  message: {
    success: false,
    message:
      'Too many sensitive privacy requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Routes for climate privacy operations

/**
 * @route POST /api/climate-privacy/weather-data
 * @desc Submit private weather data with stealth addresses
 * @access Public (with rate limiting)
 */
(router as any).post(
  '/weather-data',
  strictPrivacyRateLimit,
  climatePrivacyController.submitPrivateWeatherData
);

/**
 * @route POST /api/climate-privacy/carbon-credits
 * @desc Create private carbon credit transfer
 * @access Public (with rate limiting)
 */
(router as any).post(
  '/carbon-credits',
  strictPrivacyRateLimit,
  climatePrivacyController.createPrivateCarbonCreditTransfer
);

/**
 * @route POST /api/climate-privacy/climate-funds
 * @desc Create private climate fund disbursement
 * @access Public (with rate limiting)
 */
(router as any).post(
  '/climate-funds',
  strictPrivacyRateLimit,
  climatePrivacyController.createPrivateClimateFundDisbursement
);

/**
 * @route POST /api/climate-privacy/stealth-address
 * @desc Register a climate stealth address
 * @access Public (with rate limiting)
 */
(router as any).post(
  '/stealth-address',
  strictPrivacyRateLimit,
  climatePrivacyController.registerClimateStealthAddress
);

/**
 * @route GET /api/climate-privacy/transactions
 * @desc Get private climate transactions (filtered for privacy)
 * @access Public (with rate limiting)
 */
(router as any).get(
  '/transactions',
  privacyRateLimit,
  climatePrivacyController.getPrivateClimateTransactions
);

/**
 * @route GET /api/climate-privacy/audit/:transactionId
 * @desc Get audit log for a specific transaction
 * @access Public (with rate limiting)
 */
(router as any).get(
  '/audit/:transactionId',
  privacyRateLimit,
  climatePrivacyController.getClimateTransactionAuditLog
);

/**
 * @route POST /api/climate-privacy/confidential-transaction
 * @desc Create confidential climate transaction with hidden amounts
 * @access Public (with strict rate limiting)
 */
(router as any).post(
  '/confidential-transaction',
  strictPrivacyRateLimit,
  climatePrivacyController.createConfidentialClimateTransaction
);

/**
 * @route POST /api/climate-privacy/validate-amounts
 * @desc Validate confidential amounts before transaction creation
 * @access Public (with rate limiting)
 */
(router as any).post(
  '/validate-amounts',
  privacyRateLimit,
  climatePrivacyController.validateConfidentialAmounts
);

/**
 * @route GET /api/climate-privacy/compliance-requirements
 * @desc Get compliance requirements for jurisdiction and transaction type
 * @access Public (with rate limiting)
 */
(router as any).get(
  '/compliance-requirements',
  privacyRateLimit,
  climatePrivacyController.getComplianceRequirements
);

/**
 * @route GET /api/climate-privacy/statistics
 * @desc Get privacy usage statistics
 * @access Public (with rate limiting)
 */
(router as any).get(
  '/statistics',
  privacyRateLimit,
  climatePrivacyController.getPrivacyStatistics
);

export default router;
