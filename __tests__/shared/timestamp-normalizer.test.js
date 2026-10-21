/**
 * Tests for Timestamp Normalization Utilities
 * Task 118.4: Data Handling & Validation - Timestamp Normalization
 */

import {
  validateTimestamp,
  calculateAgeMinutes,
  calculateAgeSeconds,
  calculateAgeHours,
  isValidRealTimeTimestamp,
  normalizeToUTCString,
  createValidatedTimestamp,
  TimestampValidationError,
} from '../../shared/utils/timestamp-normalizer';

describe('timestamp-normalizer', () => {
  describe('validateTimestamp', () => {
    it('should accept a valid current timestamp', () => {
      const now = new Date();
      const result = validateTimestamp(now);
      expect(result.getTime()).toBe(now.getTime());
    });

    it('should accept a timestamp string in ISO format', () => {
      // Use a recent timestamp that won't be "too old"
      const recentDate = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago
      const isoString = recentDate.toISOString();
      const result = validateTimestamp(isoString);
      expect(result).toBeInstanceOf(Date);
      expect(result.toISOString()).toBe(isoString);
    });

    it('should accept a timestamp in milliseconds', () => {
      const now = Date.now();
      const result = validateTimestamp(now);
      expect(result.getTime()).toBe(now);
    });

    it('should accept a timestamp slightly in the future (clock drift tolerance)', () => {
      const futureMs = Date.now() + 2 * 60 * 1000; // 2 minutes in future
      const result = validateTimestamp(futureMs);
      expect(result.getTime()).toBe(futureMs);
    });

    it('should reject a timestamp too far in the future', () => {
      const farFuture = Date.now() + 10 * 60 * 1000; // 10 minutes in future
      expect(() => validateTimestamp(farFuture)).toThrow(TimestampValidationError);
      expect(() => validateTimestamp(farFuture)).toThrow('Timestamp too far in future');
    });

    it('should reject an invalid date string', () => {
      expect(() => validateTimestamp('not-a-date')).toThrow(TimestampValidationError);
      expect(() => validateTimestamp('not-a-date')).toThrow('Invalid timestamp');
    });

    it('should reject a timestamp that is too old', () => {
      const tooOld = Date.now() - 40 * 24 * 60 * 60 * 1000; // 40 days ago
      expect(() => validateTimestamp(tooOld)).toThrow(TimestampValidationError);
      expect(() => validateTimestamp(tooOld)).toThrow('Timestamp too old');
    });

    it('should return invalid Date when throwOnInvalid is false', () => {
      const result = validateTimestamp('invalid', { throwOnInvalid: false });
      expect(isNaN(result.getTime())).toBe(true);
    });

    it('should accept custom tolerance settings', () => {
      const futureMs = Date.now() + 8 * 60 * 1000; // 8 minutes in future
      // Default would reject this, but custom tolerance allows it
      const result = validateTimestamp(futureMs, { maxFutureToleranceMs: 10 * 60 * 1000 });
      expect(result.getTime()).toBe(futureMs);
    });
  });

  describe('calculateAgeMinutes', () => {
    it('should return positive age for past timestamps', () => {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
      const age = calculateAgeMinutes(fiveMinutesAgo);
      expect(age).toBeGreaterThanOrEqual(4.9);
      expect(age).toBeLessThanOrEqual(5.1);
    });

    it('should return 0 for future timestamps (never negative)', () => {
      const future = new Date(Date.now() + 5 * 60 * 1000);
      const age = calculateAgeMinutes(future);
      expect(age).toBe(0);
    });

    it('should return 0 for current timestamp', () => {
      const now = new Date();
      const age = calculateAgeMinutes(now);
      expect(age).toBeLessThan(0.1); // Allow for execution time
    });
  });

  describe('calculateAgeSeconds', () => {
    it('should return age in seconds', () => {
      const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);
      const age = calculateAgeSeconds(thirtySecondsAgo);
      expect(age).toBeGreaterThanOrEqual(29);
      expect(age).toBeLessThanOrEqual(31);
    });

    it('should return 0 for future timestamps', () => {
      const future = new Date(Date.now() + 30 * 1000);
      const age = calculateAgeSeconds(future);
      expect(age).toBe(0);
    });
  });

  describe('calculateAgeHours', () => {
    it('should return age in hours', () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const age = calculateAgeHours(twoHoursAgo);
      expect(age).toBeGreaterThanOrEqual(1.9);
      expect(age).toBeLessThanOrEqual(2.1);
    });

    it('should return 0 for future timestamps', () => {
      const future = new Date(Date.now() + 2 * 60 * 60 * 1000);
      const age = calculateAgeHours(future);
      expect(age).toBe(0);
    });
  });

  describe('isValidRealTimeTimestamp', () => {
    it('should return true for current timestamp', () => {
      expect(isValidRealTimeTimestamp(new Date())).toBe(true);
    });

    it('should return true for recent timestamp', () => {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      expect(isValidRealTimeTimestamp(tenMinutesAgo)).toBe(true);
    });

    it('should return false for timestamp too old', () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      expect(isValidRealTimeTimestamp(twoHoursAgo)).toBe(false);
    });

    it('should return false for timestamp too far in future', () => {
      const tenMinutesInFuture = new Date(Date.now() + 10 * 60 * 1000);
      expect(isValidRealTimeTimestamp(tenMinutesInFuture)).toBe(false);
    });

    it('should return true for timestamp within custom tolerance', () => {
      const ninetyMinutesAgo = new Date(Date.now() - 90 * 60 * 1000);
      expect(isValidRealTimeTimestamp(ninetyMinutesAgo, 120)).toBe(true);
    });

    it('should return false for invalid Date', () => {
      expect(isValidRealTimeTimestamp(new Date('invalid'))).toBe(false);
    });
  });

  describe('normalizeToUTCString', () => {
    it('should convert Date to ISO string', () => {
      const date = new Date('2024-01-15T10:30:00Z');
      expect(normalizeToUTCString(date)).toBe('2024-01-15T10:30:00.000Z');
    });

    it('should convert timestamp number to ISO string', () => {
      const ms = Date.parse('2024-01-15T10:30:00Z');
      expect(normalizeToUTCString(ms)).toBe('2024-01-15T10:30:00.000Z');
    });

    it('should throw for invalid timestamp', () => {
      expect(() => normalizeToUTCString('invalid')).toThrow(TimestampValidationError);
    });
  });

  describe('createValidatedTimestamp', () => {
    it('should return current time when no timestamp provided', () => {
      const before = Date.now();
      const result = createValidatedTimestamp();
      const after = Date.now();

      expect(result.getTime()).toBeGreaterThanOrEqual(before);
      expect(result.getTime()).toBeLessThanOrEqual(after);
    });

    it('should validate and return provided timestamp', () => {
      const timestamp = new Date();
      const result = createValidatedTimestamp(timestamp);
      expect(result.getTime()).toBe(timestamp.getTime());
    });

    it('should return current time for null/undefined', () => {
      const before = Date.now();
      const result1 = createValidatedTimestamp(undefined);
      const result2 = createValidatedTimestamp(null);
      const after = Date.now();

      expect(result1.getTime()).toBeGreaterThanOrEqual(before);
      expect(result1.getTime()).toBeLessThanOrEqual(after);
      expect(result2.getTime()).toBeGreaterThanOrEqual(before);
      expect(result2.getTime()).toBeLessThanOrEqual(after);
    });
  });

  describe('Edge cases - Critical bug fix verification', () => {
    it('should never return negative age for quality scoring', () => {
      // This tests the exact bug that was in weather-data-service.ts
      // The old code: (Date.now() - data.timestamp.getTime()) / (1000 * 60)
      // could return negative values for future timestamps

      const futureTimestamp = new Date(Date.now() + 60 * 60 * 1000); // 1 hour in future
      const ageMinutes = calculateAgeMinutes(futureTimestamp);

      // Critical: age must never be negative
      expect(ageMinutes).toBeGreaterThanOrEqual(0);
      expect(ageMinutes).toBe(0); // Future timestamps should be treated as age 0
    });

    it('should properly validate timestamps with timezone offsets', () => {
      // Test that ISO strings with timezone offsets are handled correctly
      // Use a recent date to avoid "too old" validation error
      const recentDate = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
      const withOffset = recentDate.toISOString().replace('Z', '+05:30');
      const result = validateTimestamp(withOffset);
      expect(result).toBeInstanceOf(Date);
    });
  });
});
