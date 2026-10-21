/**
 * Input Validation & Sanitization
 * Comprehensive validation for blockchain interactions and user inputs
 */

import { body, param, query, validationResult } from 'express-validator';
import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { securityLogger } from '../server/utils/logger.js';

const window = new JSDOM('').window;
const purify = DOMPurify(window);

// Supported blockchain networks
const SUPPORTED_CHAINS = [
  'ethereum',
  'polygon',
  'bsc',
  'avalanche',
  'arbitrum',
  'optimism',
  'fantom',
  'moonbeam',
];

const SUPPORTED_TOKENS = [
  'WRF',
  'ETH',
  'MATIC',
  'BNB',
  'AVAX',
  'ARB',
  'OP',
  'FTM',
  'GLMR',
];

const WEATHER_SCHEMA_V1 = 'wrf.weather.observation.v1';

// Address validation for blockchain interactions
const validateEthereumAddress = body('address')
  .isLength({ min: 42, max: 42 })
  .matches(/^0x[a-fA-F0-9]{40}$/)
  .withMessage('Invalid Ethereum address format')
  .customSanitizer(value => value.toLowerCase());

const validateFromAddress = body('fromAddress')
  .isLength({ min: 42, max: 42 })
  .matches(/^0x[a-fA-F0-9]{40}$/)
  .withMessage('Invalid from address format')
  .customSanitizer(value => value.toLowerCase());

const validateToAddress = body('toAddress')
  .isLength({ min: 42, max: 42 })
  .matches(/^0x[a-fA-F0-9]{40}$/)
  .withMessage('Invalid to address format')
  .customSanitizer(value => value.toLowerCase());

// Amount limits for transfers
const validateTransferAmount = body('amount')
  .isFloat({ min: 0.0001, max: 10000 })
  .withMessage('Transfer amount must be between 0.0001 and 10,000 WRF')
  .custom((value, { req }) => {
    // Additional validation based on token type
    const token = req.body.token || 'WRF';
    if (token === 'ETH' && value > 100) {
      throw new Error('ETH transfers limited to 100 ETH maximum');
    }
    if (token === 'BNB' && value > 1000) {
      throw new Error('BNB transfers limited to 1000 BNB maximum');
    }
    return true;
  });

const validateWeatherAmount = body('amount')
  .optional()
  .isFloat({ min: 0.01, max: 1.0 })
  .withMessage('Weather reward amount must be between 0.01 and 1.0 WRF');

// Chain validation for supported networks
const validateFromChain = body('fromChain')
  .isIn(SUPPORTED_CHAINS)
  .withMessage(
    `Unsupported source chain. Supported: ${SUPPORTED_CHAINS.join(', ')}`
  )
  .customSanitizer(value => value.toLowerCase());

const validateToChain = body('toChain')
  .isIn(SUPPORTED_CHAINS)
  .withMessage(
    `Unsupported target chain. Supported: ${SUPPORTED_CHAINS.join(', ')}`
  )
  .customSanitizer(value => value.toLowerCase())
  .custom((value, { req }) => {
    if (value === req.body.fromChain) {
      throw new Error('Source and target chains cannot be the same');
    }
    return true;
  });

const validateChain = body('chain')
  .isIn(SUPPORTED_CHAINS)
  .withMessage(
    `Unsupported blockchain network. Supported: ${SUPPORTED_CHAINS.join(', ')}`
  )
  .customSanitizer(value => value.toLowerCase());

// Token validation
const validateToken = body('token')
  .isIn(SUPPORTED_TOKENS)
  .withMessage(`Unsupported token. Supported: ${SUPPORTED_TOKENS.join(', ')}`)
  .customSanitizer(value => value.toUpperCase());

// Weather station validation
const validateStationId = body('stationId')
  .optional()
  .isLength({ min: 1, max: 50 })
  .matches(/^[a-zA-Z0-9\-_]+$/)
  .withMessage('Station ID must be alphanumeric with hyphens/underscores only')
  .customSanitizer(value => purify.sanitize(value));

const validateSensorData = body('sensorData')
  .optional()
  .isArray({ min: 1, max: 20 })
  .withMessage('Sensor data must be an array with 1-20 readings')
  .custom(sensorArray => {
    for (const sensor of sensorArray) {
      if (!sensor.type || !sensor.value || typeof sensor.value !== 'number') {
        throw new Error('Each sensor reading must have type and numeric value');
      }
      if (sensor.value < -100 || sensor.value > 1000) {
        throw new Error('Sensor values must be between -100 and 1000');
      }
    }
    return true;
  });

const extractCanonicalPayloadCandidate = body => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }
  if (body.canonicalPayload && typeof body.canonicalPayload === 'object') {
    return body.canonicalPayload;
  }
  if (body.data && typeof body.data === 'object') {
    return body.data;
  }
  return body;
};

const hasCanonicalObservationField = observation => {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    return false;
  }
  const canonicalFields = [
    'temperature_c',
    'humidity',
    'pressure_hpa',
    'wind_speed_ms',
    'precipitation',
    'dewpoint_c',
  ];
  return canonicalFields.some(field => {
    const value = observation[field];
    return typeof value === 'number' && Number.isFinite(value);
  });
};

const validateCanonicalOrLegacyWeatherPayload = body()
  .custom((_, { req }) => {
    const requestBody = req.body || {};
    const hasLegacyStationId =
      typeof requestBody.stationId === 'string' && requestBody.stationId.trim().length > 0;
    const hasLegacySensorData =
      Array.isArray(requestBody.sensorData) && requestBody.sensorData.length > 0;
    const hasLegacyPayload = hasLegacyStationId && hasLegacySensorData;

    const canonicalCandidate = extractCanonicalPayloadCandidate(requestBody);
    const hasCanonicalPayload = Boolean(
      canonicalCandidate &&
        canonicalCandidate.schema_version === WEATHER_SCHEMA_V1 &&
        typeof canonicalCandidate.station_id === 'string' &&
        canonicalCandidate.station_id.trim().length > 0 &&
        hasCanonicalObservationField(canonicalCandidate.observation)
    );

    if (hasLegacyPayload) {
      const rewardAmount = Number(requestBody.amount);
      if (!Number.isFinite(rewardAmount) || rewardAmount < 0.01 || rewardAmount > 1.0) {
        throw new Error('Legacy weather payload requires amount between 0.01 and 1.0 WRF');
      }
      return true;
    }

    if (canonicalCandidate && canonicalCandidate.schema_version === WEATHER_SCHEMA_V1) {
      if (
        typeof canonicalCandidate.station_id !== 'string' ||
        canonicalCandidate.station_id.trim().length === 0
      ) {
        throw new Error('Canonical weather payload requires station_id');
      }
      if (!hasCanonicalObservationField(canonicalCandidate.observation)) {
        throw new Error(
          'Canonical weather payload observation must include at least one canonical numeric weather field'
        );
      }
      return true;
    }

    if (!hasCanonicalPayload) {
      throw new Error(
        'Provide either legacy weather payload (stationId + sensorData + amount) or canonical v1 payload (schema_version + station_id + observation)'
      );
    }

    return true;
  });

// HTML/script sanitization
const sanitizeTextInput = fieldName => {
  return body(fieldName)
    .trim()
    .customSanitizer(value => {
      // Remove HTML tags and scripts
      return purify.sanitize(value, {
        ALLOWED_TAGS: [],
        ALLOWED_ATTR: [],
      });
    })
    .isLength({ max: 500 })
    .withMessage(`${fieldName} must be less than 500 characters`);
};

const sanitizeDescription = sanitizeTextInput('description');
const sanitizeName = sanitizeTextInput('name');
const sanitizeMessage = sanitizeTextInput('message');

// Transaction hash validation
const validateTxHash = body('txHash')
  .isLength({ min: 66, max: 66 })
  .matches(/^0x[a-fA-F0-9]{64}$/)
  .withMessage('Invalid transaction hash format')
  .customSanitizer(value => value.toLowerCase());

// Bridge protocol validation
const validateBridgeProtocol = body('bridgeProtocol')
  .isIn([
    'axelar',
    'layerzero',
    'wormhole',
    'stargate',
    'hyperlane',
    'multichain',
    'synapse',
  ])
  .withMessage('Unsupported bridge protocol')
  .customSanitizer(value => value.toLowerCase());

// Gas price validation
const validateGasPrice = body('gasPrice')
  .optional()
  .isFloat({ min: 1, max: 1000 })
  .withMessage('Gas price must be between 1 and 1000 Gwei');

// Timestamp validation
const validateTimestamp = body('timestamp')
  .optional()
  .isISO8601()
  .withMessage('Invalid timestamp format')
  .custom(value => {
    const timestamp = new Date(value);
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const fiveMinutesFromNow = new Date(now.getTime() + 5 * 60 * 1000);

    if (timestamp < fiveMinutesAgo || timestamp > fiveMinutesFromNow) {
      throw new Error('Timestamp must be within 5 minutes of current time');
    }
    return true;
  });

// Error handling middleware
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    // SECURITY: Don't echo input values back to client (prevents information disclosure)
    const safeErrorDetails = errors.array().map(error => ({
      field: error.param,
      message: error.msg,
      // value intentionally omitted - don't echo user input back
    }));

    // Log full details server-side for debugging (includes values for internal analysis)
    securityLogger.warn('Validation failed', {
      ip: req.ip,
      endpoint: req.path,
      method: req.method,
      errors: errors.array()
    });

    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: safeErrorDetails,
    });
  }
  next();
};

// Validation rule sets for different endpoints
const transferValidation = [
  validateFromAddress,
  validateToAddress,
  validateTransferAmount,
  validateFromChain,
  validateToChain,
  validateToken,
  validateBridgeProtocol,
  validateGasPrice,
  validateTimestamp,
  handleValidationErrors,
];

const weatherValidation = [
  validateStationId,
  validateSensorData,
  validateWeatherAmount,
  validateCanonicalOrLegacyWeatherPayload,
  validateTimestamp,
  handleValidationErrors,
];

const addressValidation = [validateEthereumAddress, handleValidationErrors];

const basicValidation = [
  sanitizeName,
  sanitizeDescription,
  handleValidationErrors,
];

export {
  // Individual validators
  validateEthereumAddress,
  validateFromAddress,
  validateToAddress,
  validateTransferAmount,
  validateWeatherAmount,
  validateFromChain,
  validateToChain,
  validateChain,
  validateToken,
  validateStationId,
  validateSensorData,
  validateTxHash,
  validateBridgeProtocol,
  validateGasPrice,
  validateTimestamp,

  // Sanitizers
  sanitizeTextInput,
  sanitizeDescription,
  sanitizeName,
  sanitizeMessage,

  // Validation rule sets
  transferValidation,
  weatherValidation,
  addressValidation,
  basicValidation,

  // Error handler
  handleValidationErrors,

  // Constants
  SUPPORTED_CHAINS,
  SUPPORTED_TOKENS,
};
