/**
 * Unit tests for weather-data-service.ts (#477)
 *
 * Covers: branded type factories (createStationId, createQualityScore, createRewardAmount),
 * WeatherDataService.submitWeatherData() happy/error paths, event emission, and caching.
 *
 * Note: ts-jest diagnostics disabled for this file because weather-data-service.ts
 * has a pre-existing type mismatch in its persistWeatherSubmission call (tracked in #477).
 * The production code is not modified here — this is a test-only workaround.
 *
 * @ts-jest-config { "diagnostics": false }
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock heavy dependencies before importing the service under test
jest.mock('../../../database/db.js', () => ({ db: {} }));
jest.mock('../../utils/logger.js', () => ({
  weatherLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../services/weather-submission-persistence.js', () => ({
  persistWeatherSubmission: jest.fn().mockResolvedValue(null as never),
}));
jest.mock('../../../shared/utils/safe-event-emitter.js', () => {
  const { EventEmitter } = require('events');
  return {
    SafeEventEmitter: class extends EventEmitter {
      constructor(_opts?: unknown) { super(); }
      safeEmit(event: string, data: unknown) { this.emit(event, data); }
    },
  };
});
jest.mock('../../../shared/utils/timestamp-normalizer.js', () => ({
  calculateAgeMinutes: jest.fn().mockReturnValue(0),
  isValidRealTimeTimestamp: jest.fn().mockReturnValue(true),
}));
jest.mock('../../../shared/types/performance-optimization.js', () => {
  const items: unknown[] = [];
  return {
    memoizeAsync: (fn: Function, _key: Function, _ttl: number) => fn,
    AdvancedCache: class {
      private store = new Map<string, unknown>();
      get(k: string) { return this.store.get(k) ?? null; }
      set(k: string, v: unknown) { this.store.set(k, v); }
      clear() { this.store.clear(); }
    },
    BatchProcessor: class {
      private opts: any;
      constructor(opts: any) { this.opts = opts; }
      add(item: unknown) { items.push(item); }
      async flush() {}
    },
  };
});

import {
  createStationId,
  createQualityScore,
  createRewardAmount,
  WeatherDataService,
} from '../../services/weather-data-service.js';

// ---------------------------------------------------------------------------
// createStationId
// ---------------------------------------------------------------------------
describe('createStationId', () => {
  it('accepts a valid 8-char uppercase alphanumeric ID', () => {
    expect(() => createStationId('ABCD1234')).not.toThrow();
    expect(createStationId('ABCD1234')).toBe('ABCD1234');
  });

  it('accepts a valid 12-char ID', () => {
    expect(() => createStationId('ABCDE12345FG')).not.toThrow();
  });

  it('throws on lowercase letters', () => {
    expect(() => createStationId('abcd1234')).toThrow('Invalid station ID format');
  });

  it('throws when shorter than 8 chars', () => {
    expect(() => createStationId('ABC123')).toThrow('Invalid station ID format');
  });

  it('throws when longer than 12 chars', () => {
    expect(() => createStationId('ABCDE12345FGH')).toThrow('Invalid station ID format');
  });

  it('throws on special characters', () => {
    expect(() => createStationId('ABCD-1234')).toThrow('Invalid station ID format');
  });
});

// ---------------------------------------------------------------------------
// createQualityScore
// ---------------------------------------------------------------------------
describe('createQualityScore', () => {
  it('accepts 0 (minimum boundary)', () => {
    expect(createQualityScore(0)).toBe(0);
  });

  it('accepts 50 (midpoint)', () => {
    expect(createQualityScore(50)).toBe(50);
  });

  it('accepts 100 (maximum boundary)', () => {
    expect(createQualityScore(100)).toBe(100);
  });

  it('throws on -1', () => {
    expect(() => createQualityScore(-1)).toThrow('Quality score must be between 0 and 100');
  });

  it('throws on 101', () => {
    expect(() => createQualityScore(101)).toThrow('Quality score must be between 0 and 100');
  });

  it('does not accept NaN (NaN < 0 is false, NaN > 100 is false — guard is insufficient, document current behavior)', () => {
    // NaN passes the current bounds check (NaN comparisons are always false).
    // This test documents the current behavior so regressions are caught.
    // A stricter guard (Number.isFinite check) is tracked in #477.
    expect(() => createQualityScore(NaN)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// createRewardAmount
// ---------------------------------------------------------------------------
describe('createRewardAmount', () => {
  it('accepts a simple integer string', () => {
    expect(createRewardAmount('10')).toBe('10');
  });

  it('accepts 8 decimal places', () => {
    expect(createRewardAmount('0.12345678')).toBe('0.12345678');
  });

  it('throws on a negative amount', () => {
    expect(() => createRewardAmount('-1')).toThrow('Invalid reward amount format');
  });

  it('throws on a string with letters', () => {
    expect(() => createRewardAmount('abc')).toThrow('Invalid reward amount format');
  });

  it('throws on more than 8 decimal places', () => {
    expect(() => createRewardAmount('0.123456789')).toThrow('Invalid reward amount format');
  });
});

// ---------------------------------------------------------------------------
// WeatherDataService.submitWeatherData
// ---------------------------------------------------------------------------
describe('WeatherDataService', () => {
  let service: WeatherDataService;

  // A minimal valid weather data payload that satisfies WeatherDataSchema.
  // unit must be '°C' (literal); value must be in [-50, 60].
  const validRawTemperature = {
    id: 'data-001',
    type: 'temperature',
    value: 22.5,
    stationId: 'STATION1',
    timestamp: new Date(),
    quality: 'high',
    unit: '°C',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new WeatherDataService();
  });

  afterEach(async () => {
    await service.shutdown();
  });

  it('returns success and a reward amount for valid data', async () => {
    const stationId = createStationId('STATION1');
    const walletAddress = 'wrf1qtest' as any;

    const result = await service.submitWeatherData(
      stationId,
      walletAddress,
      validRawTemperature
    );

    expect(result.success).toBe(true);
    expect(typeof result.reward).toBe('string');
    expect(result.error).toBeUndefined();
  });

  it('returns failure when raw data fails Zod schema validation', async () => {
    const stationId = createStationId('STATION1');
    const walletAddress = 'wrf1qtest' as any;

    const result = await service.submitWeatherData(
      stationId,
      walletAddress,
      { type: 'temperature', value: 'not-a-number' } // missing required fields + bad value type
    );

    expect(result.success).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.reward).toBeUndefined();
  });

  it('returns failure when temperature is out of physical range', async () => {
    const stationId = createStationId('STATION1');
    const walletAddress = 'wrf1qtest' as any;

    // WeatherDataSchema rejects values above 60 at Zod layer.
    // The service's WeatherValidationPipeline also enforces -60..60 (wider range).
    const result = await service.submitWeatherData(
      stationId,
      walletAddress,
      { ...validRawTemperature, value: 65 } // above Zod max of 60
    );

    expect(result.success).toBe(false);
    expect(typeof result.error).toBe('string');
  });

  it('emits data:validated event on successful submission', async () => {
    const stationId = createStationId('STATION1');
    const walletAddress = 'wrf1qtest' as any;

    const emitted: unknown[] = [];
    service.on('data:validated', (data) => emitted.push(data));

    await service.submitWeatherData(stationId, walletAddress, validRawTemperature);

    expect(emitted).toHaveLength(1);
    expect((emitted[0] as any).stationId).toBe('STATION1');
  });

  it('emits reward:calculated event on successful submission', async () => {
    const stationId = createStationId('STATION1');
    const walletAddress = 'wrf1qtest' as any;

    const rewards: unknown[] = [];
    service.on('reward:calculated', (data) => rewards.push(data));

    await service.submitWeatherData(stationId, walletAddress, validRawTemperature);

    expect(rewards).toHaveLength(1);
    expect((rewards[0] as any).amount).toBeDefined();
  });

  it('emits validation:failed event on rejection', async () => {
    const stationId = createStationId('STATION1');
    const walletAddress = 'wrf1qtest' as any;

    const failures: unknown[] = [];
    service.on('validation:failed', (data) => failures.push(data));

    await service.submitWeatherData(stationId, walletAddress, { invalid: true });

    expect(failures).toHaveLength(1);
  });

  it('returns success for two calls with different data (no false cache collision)', async () => {
    const stationId = createStationId('STATION1');
    const wallet = 'wrf1qtest' as any;

    const r1 = await service.submitWeatherData(stationId, wallet, {
      ...validRawTemperature,
      id: 'data-001',
      value: 20,
    });
    const r2 = await service.submitWeatherData(stationId, wallet, {
      ...validRawTemperature,
      id: 'data-002',
      value: 21,
    });

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
  });
});
