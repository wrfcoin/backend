/**
 * Timestamp Normalization Utilities
 *
 * Provides safe timestamp handling with validation for future timestamps,
 * clock drift tolerance, and UTC normalization.
 *
 * Task 118.4: Data Handling & Validation - Timestamp Normalization
 */

/**
 * Custom error for timestamp validation failures
 */
export class TimestampValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimestampValidationError';
  }
}

/**
 * Configuration for timestamp validation
 */
export interface TimestampValidationConfig {
  /** Maximum allowed clock drift in milliseconds (default: 5 minutes) */
  maxFutureToleranceMs?: number;
  /** Maximum age in milliseconds (default: 30 days) */
  maxAgeMs?: number;
  /** Whether to throw on invalid timestamps or return null (default: true) */
  throwOnInvalid?: boolean;
}

const DEFAULT_CONFIG: Required<TimestampValidationConfig> = {
  maxFutureToleranceMs: 5 * 60 * 1000, // 5 minutes
  maxAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  throwOnInvalid: true,
};

/**
 * Validates and normalizes a timestamp to a Date object.
 *
 * @param timestamp - The timestamp to validate (Date, string, or number)
 * @param config - Optional configuration for validation
 * @returns A valid Date object
 * @throws TimestampValidationError if the timestamp is invalid and throwOnInvalid is true
 *
 * @example
 * ```typescript
 * const validDate = validateTimestamp(new Date());
 * const validDateFromString = validateTimestamp('2024-01-15T10:30:00Z');
 * const validDateFromMs = validateTimestamp(1705312200000);
 * ```
 */
export function validateTimestamp(
  timestamp: Date | string | number,
  config: TimestampValidationConfig = {}
): Date {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const now = Date.now();

  // Convert to Date object
  let date: Date;
  if (timestamp instanceof Date) {
    date = timestamp;
  } else if (typeof timestamp === 'string' || typeof timestamp === 'number') {
    date = new Date(timestamp);
  } else {
    if (mergedConfig.throwOnInvalid) {
      throw new TimestampValidationError('Invalid timestamp type: expected Date, string, or number');
    }
    return new Date(NaN);
  }

  // Check if the date is valid
  if (isNaN(date.getTime())) {
    if (mergedConfig.throwOnInvalid) {
      throw new TimestampValidationError('Invalid timestamp: unable to parse as date');
    }
    return date;
  }

  const timestampMs = date.getTime();

  // Check if timestamp is too far in the future (beyond clock drift tolerance)
  if (timestampMs > now + mergedConfig.maxFutureToleranceMs) {
    if (mergedConfig.throwOnInvalid) {
      const futureMs = timestampMs - now;
      throw new TimestampValidationError(
        `Timestamp too far in future: ${Math.round(futureMs / 1000)}s ahead (max tolerance: ${mergedConfig.maxFutureToleranceMs / 1000}s)`
      );
    }
    return new Date(NaN);
  }

  // Check if timestamp is too old
  if (timestampMs < now - mergedConfig.maxAgeMs) {
    if (mergedConfig.throwOnInvalid) {
      const ageMs = now - timestampMs;
      throw new TimestampValidationError(
        `Timestamp too old: ${Math.round(ageMs / (24 * 60 * 60 * 1000))} days old (max age: ${mergedConfig.maxAgeMs / (24 * 60 * 60 * 1000)} days)`
      );
    }
    return new Date(NaN);
  }

  return date;
}

/**
 * Calculates the age of a timestamp in minutes, ensuring the result is never negative.
 *
 * This function is safe against future timestamps - if a timestamp is in the future
 * (due to clock drift or invalid data), it returns 0 instead of a negative value.
 *
 * @param timestamp - The timestamp to calculate age for
 * @returns Age in minutes (always >= 0)
 *
 * @example
 * ```typescript
 * const ageMinutes = calculateAgeMinutes(someDate);
 * if (ageMinutes > 60) {
 *   // Data is older than 1 hour
 * }
 * ```
 */
export function calculateAgeMinutes(timestamp: Date): number {
  const ageMs = Date.now() - timestamp.getTime();
  // Never return negative - future timestamps are treated as age 0
  return Math.max(0, ageMs / (1000 * 60));
}

/**
 * Calculates the age of a timestamp in seconds, ensuring the result is never negative.
 *
 * @param timestamp - The timestamp to calculate age for
 * @returns Age in seconds (always >= 0)
 */
export function calculateAgeSeconds(timestamp: Date): number {
  const ageMs = Date.now() - timestamp.getTime();
  return Math.max(0, ageMs / 1000);
}

/**
 * Calculates the age of a timestamp in hours, ensuring the result is never negative.
 *
 * @param timestamp - The timestamp to calculate age for
 * @returns Age in hours (always >= 0)
 */
export function calculateAgeHours(timestamp: Date): number {
  const ageMs = Date.now() - timestamp.getTime();
  return Math.max(0, ageMs / (1000 * 60 * 60));
}

/**
 * Checks if a timestamp is within a valid range for real-time data.
 *
 * @param timestamp - The timestamp to check
 * @param maxAgeMinutes - Maximum allowed age in minutes (default: 60)
 * @param maxFutureSeconds - Maximum allowed future offset in seconds (default: 300)
 * @returns true if the timestamp is valid for real-time data
 */
export function isValidRealTimeTimestamp(
  timestamp: Date,
  maxAgeMinutes: number = 60,
  maxFutureSeconds: number = 300
): boolean {
  const now = Date.now();
  const timestampMs = timestamp.getTime();

  // Check for invalid date
  if (isNaN(timestampMs)) {
    return false;
  }

  // Check if too old
  if (timestampMs < now - maxAgeMinutes * 60 * 1000) {
    return false;
  }

  // Check if too far in future
  if (timestampMs > now + maxFutureSeconds * 1000) {
    return false;
  }

  return true;
}

/**
 * Normalizes a timestamp to UTC ISO string format.
 *
 * @param timestamp - The timestamp to normalize
 * @returns ISO 8601 UTC string
 */
export function normalizeToUTCString(timestamp: Date | string | number): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (isNaN(date.getTime())) {
    throw new TimestampValidationError('Cannot normalize invalid timestamp to UTC string');
  }
  return date.toISOString();
}

/**
 * Creates a validated timestamp for data submission.
 * Uses current time if no timestamp provided, validates if provided.
 *
 * @param timestamp - Optional timestamp to validate
 * @param config - Optional validation configuration
 * @returns A valid Date object
 */
export function createValidatedTimestamp(
  timestamp?: Date | string | number,
  config?: TimestampValidationConfig
): Date {
  if (timestamp === undefined || timestamp === null) {
    return new Date();
  }
  return validateTimestamp(timestamp, config);
}
