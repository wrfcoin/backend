/**
 * Cache regression for the top-level weather data service lookup path.
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

jest.mock('../../database/db.js', () => ({ db: {} }));
jest.mock('../../server/utils/logger.js', () => ({
  weatherLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../shared/types/runtime-validation.js', () => ({
  WeatherDataSchema: {
    parse: (value: unknown) => value,
  },
  WeatherData: {},
  createWalletAddress: (value: unknown) => value,
  WalletAddress: {},
}));
jest.mock('../../shared/utils/safe-event-emitter.js', () => {
  const { EventEmitter } = require('events');
  return {
    SafeEventEmitter: class extends EventEmitter {
      constructor(_opts?: unknown) {
        super();
      }
      safeEmit(event: string, data: unknown) {
        this.emit(event, data);
      }
    },
  };
});
jest.mock('../../shared/utils/timestamp-normalizer.js', () => ({
  calculateAgeMinutes: jest.fn().mockReturnValue(0),
  isValidRealTimeTimestamp: jest.fn().mockReturnValue(true),
}));
jest.mock('../../shared/types/performance-optimization.js', () => {
  return {
    memoizeAsync: (fn: Function, _key: Function, _ttl: number) => fn,
    AdvancedCache: class {
      private store = new Map<string, unknown>();
      get(k: string) {
        return this.store.get(k) ?? null;
      }
      set(k: string, v: unknown) {
        this.store.set(k, v);
      }
      clear() {
        this.store.clear();
      }
    },
    BatchProcessor: class {
      constructor(_opts: unknown) {}
      async flush() {}
    },
  };
});

import {
  createStationId,
  WeatherDataService,
} from '../../services/weather/weather-data-service.js';

describe('top-level WeatherDataService cache lookups', () => {
  let service: WeatherDataService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new WeatherDataService();
  });

  afterEach(async () => {
    await service.shutdown();
  });

  it('reuses the type cache for repeated getWeatherDataByType lookups', async () => {
    const stationId = createStationId('STATION1');
    const fetchSpy = jest.spyOn(service as any, 'fetchFromDatabase');
    fetchSpy.mockResolvedValue([
      {
        id: 'data-003',
        type: 'temperature',
        value: 19.8,
        stationId: 'STATION1',
        timestamp: new Date(),
        quality: 'high',
        unit: '°C',
      },
    ]);

    const first = await service.getWeatherDataByType('temperature', stationId);
    const second = await service.getWeatherDataByType('temperature', stationId);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0].type).toBe('temperature');
  });
});
