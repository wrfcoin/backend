/**
 * GraphQL Input Validation
 * Provides comprehensive input validation for GraphQL operations
 */

import { GraphQLScalarType, GraphQLError } from 'graphql';
import { validationError } from '../error-handler.js';
import { logger } from '../../utils/logger.js';

// Validation patterns
const VALIDATION_PATTERNS = {
  // Ethereum address (40 hex characters with 0x prefix)
  ETH_ADDRESS: /^0x[a-fA-F0-9]{40}$/,

  // Transaction hash (64 hex characters with 0x prefix)
  TX_HASH: /^0x[a-fA-F0-9]{64}$/,

  // Station ID (alphanumeric with hyphens)
  STATION_ID: /^[a-zA-Z0-9-_]{1,50}$/,

  // Token ID (numeric string)
  TOKEN_ID: /^\d+$/,

  // Wei amount (numeric string)
  WEI_AMOUNT: /^\d+$/,

  // ISO 8601 DateTime
  DATETIME: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/,

  // UUID v4
  UUID: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,

  // Proposal description (reasonable length)
  PROPOSAL_DESC: /^.{10,2000}$/s,

  // Weather data ranges
  TEMPERATURE: { min: -100, max: 100 },
  HUMIDITY: { min: 0, max: 100 },
  PRESSURE: { min: 800, max: 1200 },
  WIND_SPEED: { min: 0, max: 200 },
  RAINFALL: { min: 0, max: 1000 },
  CONFIDENCE: { min: 0, max: 100 },
};

// Input sanitization
export function sanitizeString(input: string): string {
  if (typeof input !== 'string') {
    throw validationError('Input must be a string');
  }

  return input
    .trim()
    .replace(/[<>]/g, '') // Remove basic HTML
    .slice(0, 1000); // Limit length
}

export function sanitizeNumber(input: any): number {
  const num = parseFloat(input);
  if (isNaN(num) || !isFinite(num)) {
    throw validationError('Input must be a valid number');
  }
  return num;
}

export function sanitizeInteger(input: any): number {
  const num = parseInt(input, 10);
  if (isNaN(num) || !isFinite(num)) {
    throw validationError('Input must be a valid integer');
  }
  return num;
}

// Validation functions
export function validateEthereumAddress(address: string): string {
  if (!VALIDATION_PATTERNS.ETH_ADDRESS.test(address)) {
    throw validationError('Invalid Ethereum address format', 'address');
  }
  return address.toLowerCase();
}

export function validateTransactionHash(hash: string): string {
  if (!VALIDATION_PATTERNS.TX_HASH.test(hash)) {
    throw validationError('Invalid transaction hash format', 'transactionHash');
  }
  return hash.toLowerCase();
}

export function validateStationId(stationId: string): string {
  if (!VALIDATION_PATTERNS.STATION_ID.test(stationId)) {
    throw validationError('Invalid station ID format', 'stationId');
  }
  return stationId;
}

export function validateTokenId(tokenId: string): string {
  if (!VALIDATION_PATTERNS.TOKEN_ID.test(tokenId)) {
    throw validationError('Invalid token ID format', 'tokenId');
  }

  // Check if it's within reasonable bounds
  const bigIntValue = BigInt(tokenId);
  if (bigIntValue < 0n || bigIntValue > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw validationError('Token ID out of valid range', 'tokenId');
  }

  return tokenId;
}

export function validateWeiAmount(amount: string): string {
  if (!VALIDATION_PATTERNS.WEI_AMOUNT.test(amount)) {
    throw validationError('Invalid wei amount format', 'amount');
  }

  // Check if it's within reasonable bounds (up to total supply)
  const bigIntValue = BigInt(amount);
  if (bigIntValue < 0n) {
    throw validationError('Amount cannot be negative', 'amount');
  }

  // Max total supply (1 billion tokens with 18 decimals)
  const maxSupply = BigInt('1000000000000000000000000000'); // 1B * 10^18
  if (bigIntValue > maxSupply) {
    throw validationError('Amount exceeds maximum supply', 'amount');
  }

  return amount;
}

export function validateDateTime(datetime: string): Date {
  if (!VALIDATION_PATTERNS.DATETIME.test(datetime)) {
    throw validationError(
      'Invalid datetime format (ISO 8601 required)',
      'datetime'
    );
  }

  const date = new Date(datetime);
  if (isNaN(date.getTime())) {
    throw validationError('Invalid datetime value', 'datetime');
  }

  // Check reasonable bounds (not too far in past or future)
  const now = new Date();
  const twoYearsAgo = new Date(
    now.getFullYear() - 2,
    now.getMonth(),
    now.getDate()
  );
  const twoYearsFromNow = new Date(
    now.getFullYear() + 2,
    now.getMonth(),
    now.getDate()
  );

  if (date < twoYearsAgo || date > twoYearsFromNow) {
    throw validationError(
      'Datetime must be within reasonable range',
      'datetime'
    );
  }

  return date;
}

export function validateWeatherData(data: {
  temperature: number;
  humidity: number;
  pressure: number;
  windSpeed: number;
  rainfall: number;
  confidence: number;
}): void {
  const { temperature, humidity, pressure, windSpeed, rainfall, confidence } =
    data;

  if (
    temperature < VALIDATION_PATTERNS.TEMPERATURE.min ||
    temperature > VALIDATION_PATTERNS.TEMPERATURE.max
  ) {
    throw validationError(
      `Temperature must be between ${VALIDATION_PATTERNS.TEMPERATURE.min} and ${VALIDATION_PATTERNS.TEMPERATURE.max}°C`,
      'temperature'
    );
  }

  if (
    humidity < VALIDATION_PATTERNS.HUMIDITY.min ||
    humidity > VALIDATION_PATTERNS.HUMIDITY.max
  ) {
    throw validationError(
      `Humidity must be between ${VALIDATION_PATTERNS.HUMIDITY.min} and ${VALIDATION_PATTERNS.HUMIDITY.max}%`,
      'humidity'
    );
  }

  if (
    pressure < VALIDATION_PATTERNS.PRESSURE.min ||
    pressure > VALIDATION_PATTERNS.PRESSURE.max
  ) {
    throw validationError(
      `Pressure must be between ${VALIDATION_PATTERNS.PRESSURE.min} and ${VALIDATION_PATTERNS.PRESSURE.max} hPa`,
      'pressure'
    );
  }

  if (
    windSpeed < VALIDATION_PATTERNS.WIND_SPEED.min ||
    windSpeed > VALIDATION_PATTERNS.WIND_SPEED.max
  ) {
    throw validationError(
      `Wind speed must be between ${VALIDATION_PATTERNS.WIND_SPEED.min} and ${VALIDATION_PATTERNS.WIND_SPEED.max} m/s`,
      'windSpeed'
    );
  }

  if (
    rainfall < VALIDATION_PATTERNS.RAINFALL.min ||
    rainfall > VALIDATION_PATTERNS.RAINFALL.max
  ) {
    throw validationError(
      `Rainfall must be between ${VALIDATION_PATTERNS.RAINFALL.min} and ${VALIDATION_PATTERNS.RAINFALL.max} mm`,
      'rainfall'
    );
  }

  if (
    confidence < VALIDATION_PATTERNS.CONFIDENCE.min ||
    confidence > VALIDATION_PATTERNS.CONFIDENCE.max
  ) {
    throw validationError(
      `Confidence must be between ${VALIDATION_PATTERNS.CONFIDENCE.min} and ${VALIDATION_PATTERNS.CONFIDENCE.max}%`,
      'confidence'
    );
  }
}

export function validatePagination(args: { first?: number; skip?: number }): {
  first: number;
  skip: number;
} {
  const { first = 10, skip = 0 } = args;

  if (first < 1 || first > 1000) {
    throw validationError('First must be between 1 and 1000', 'first');
  }

  if (skip < 0 || skip > 100000) {
    throw validationError('Skip must be between 0 and 100000', 'skip');
  }

  return { first, skip };
}

export function validateProposalInput(input: {
  title: string;
  description: string;
  targets: string[];
  values: string[];
  calldatas: string[];
}): void {
  const { title, description, targets, values, calldatas } = input;

  if (!title || title.length < 5 || title.length > 200) {
    throw validationError(
      'Title must be between 5 and 200 characters',
      'title'
    );
  }

  if (!VALIDATION_PATTERNS.PROPOSAL_DESC.test(description)) {
    throw validationError(
      'Description must be between 10 and 2000 characters',
      'description'
    );
  }

  if (!targets || targets.length === 0 || targets.length > 10) {
    throw validationError('Must provide 1-10 target addresses', 'targets');
  }

  if (values.length !== targets.length || calldatas.length !== targets.length) {
    throw validationError(
      'Targets, values, and calldatas arrays must have same length'
    );
  }

  // Validate each target address
  targets.forEach((target, index) => {
    try {
      validateEthereumAddress(target);
    } catch (error) {
      throw validationError(
        `Invalid target address at index ${index}`,
        'targets'
      );
    }
  });

  // Validate each value
  values.forEach((value, index) => {
    try {
      validateWeiAmount(value);
    } catch (error) {
      throw validationError(`Invalid value at index ${index}`, 'values');
    }
  });
}

// Task 77: Governance analytics validators
export function validateProposalId(id: unknown): boolean {
  return typeof id === 'number' && Number.isInteger(id) && id > 0;
}

export function validateVoteChoice(choice: unknown): boolean {
  return typeof choice === 'boolean';
}

export const VALID_TIMEFRAMES = ['7d', '30d', '90d', '1y'] as const;
export type AnalyticsTimeframe = typeof VALID_TIMEFRAMES[number];

export function validateTimeframe(tf: unknown): tf is AnalyticsTimeframe {
  return typeof tf === 'string' && VALID_TIMEFRAMES.includes(tf as AnalyticsTimeframe);
}

export function validateGovernanceAnalyticsInput(input: {
  timeframe?: unknown;
  proposalId?: unknown;
  voterAddress?: unknown;
}): void {
  if (input.timeframe !== undefined && !validateTimeframe(input.timeframe)) {
    throw validationError(
      `Invalid timeframe. Must be one of: ${VALID_TIMEFRAMES.join(', ')}`,
      'timeframe'
    );
  }

  if (input.proposalId !== undefined) {
    if (!validateProposalId(input.proposalId)) {
      throw validationError('Proposal ID must be a positive integer', 'proposalId');
    }
  }

  if (input.voterAddress !== undefined) {
    if (typeof input.voterAddress !== 'string') {
      throw validationError('Voter address must be a string', 'voterAddress');
    }
    validateEthereumAddress(input.voterAddress);
  }
}

export function validateSignature(signature: string): string {
  if (!signature || typeof signature !== 'string') {
    throw validationError('Signature is required', 'signature');
  }

  // Basic signature format validation (132 hex chars with 0x prefix)
  if (!/^0x[a-fA-F0-9]{130}$/.test(signature)) {
    throw validationError('Invalid signature format', 'signature');
  }

  return signature;
}

// Mutation input validation helpers
export function validateWeatherDataInput(input: any): any {
  const sanitized = {
    stationId: validateStationId(sanitizeString(input.stationId)),
    temperature: sanitizeNumber(input.temperature),
    humidity: sanitizeNumber(input.humidity),
    pressure: sanitizeNumber(input.pressure),
    windSpeed: sanitizeNumber(input.windSpeed),
    rainfall: sanitizeNumber(input.rainfall),
    confidence: sanitizeNumber(input.confidence),
    signature: validateSignature(input.signature),
  };

  validateWeatherData(sanitized);
  return sanitized;
}

export function validateVoteInput(input: any): any {
  return {
    proposalId: validateTokenId(input.proposalId),
    support: input.support, // Enum validation handled by GraphQL
    reason: input.reason ? sanitizeString(input.reason) : undefined,
    signature: validateSignature(input.signature),
  };
}

export function validateSwapInput(input: any): any {
  return {
    tokenIn: validateEthereumAddress(input.tokenIn),
    tokenOut: validateEthereumAddress(input.tokenOut),
    amountIn: validateWeiAmount(input.amountIn),
    amountOutMin: validateWeiAmount(input.amountOutMin),
    deadline: validateTokenId(input.deadline),
    slippageTolerance: sanitizeNumber(input.slippageTolerance),
  };
}

// Rate limiting validation
export function validateRateLimit(context: any, operation: string): void {
  const clientIP = context.clientIP;
  const now = Date.now();

  // Simple in-memory rate limiting (in production, use Redis)
  if (!global.rateLimitStore) {
    global.rateLimitStore = new Map();
  }

  const key = `${clientIP}:${operation}`;
  const existing = global.rateLimitStore.get(key) || {
    count: 0,
    resetTime: now + 60000,
  };

  if (now > existing.resetTime) {
    existing.count = 0;
    existing.resetTime = now + 60000;
  }

  existing.count++;
  global.rateLimitStore.set(key, existing);

  // Different limits for different operations
  const limits = {
    query: 100,
    mutation: 20,
    subscription: 10,
  };

  const limit = limits[operation] || 50;

  if (existing.count > limit) {
    logger.warn('Rate limit exceeded', {
      clientIP,
      operation,
      count: existing.count,
      limit,
    });
    throw validationError(
      `Rate limit exceeded for ${operation}. Try again later.`
    );
  }
}

// Export validation middleware
export const inputValidationMiddleware = {
  validateWeatherDataInput,
  validateVoteInput,
  validateSwapInput,
  validatePagination,
  validateProposalInput,
  validateRateLimit,
  // Task 77: Governance analytics validators
  validateProposalId,
  validateVoteChoice,
  validateTimeframe,
  validateGovernanceAnalyticsInput,
};
