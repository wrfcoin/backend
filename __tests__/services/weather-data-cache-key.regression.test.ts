/**
 * Regression test for backend#634: Weather data cache key mismatch
 *
 * Verifies that getWeatherDataByType reads and writes to the same cache key,
 * ensuring cache hits work correctly and avoid unnecessary DB queries.
 */

const executeQueryMock = jest.fn();

jest.mock('../../database/index.js', () => ({
  executeQuery: executeQueryMock,
}), { virtual: true });

jest.mock('../../server/utils/logger.js', () => ({
  appLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}), { virtual: true });

describe('Weather data cache key fix (backend#634)', () => {
  let weatherService: any;

  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();

    // Import after clearing mocks
    const { createWeatherDataService } = require('../../services/weather/weather-data-service');
    weatherService = createWeatherDataService();

    // Mock database responses
    executeQueryMock.mockImplementation(async () => ({
      rows: [
        {
          id: 'wx-temp-1',
          type: 'temperature',
          value: 24.3,
          stationId: 'STATION001',
        },
        {
          id: 'wx-temp-2',
          type: 'temperature',
          value: 24.5,
          stationId: 'STATION001',
        },
      ],
    }));
  });

  it('should cache results under the same key used for reads', async () => {
    const stationId = 'STATION001';
    const type = 'temperature';

    // First call should hit database
    const firstResults = await weatherService.getWeatherDataByType(type, stationId);
    expect(firstResults).toHaveLength(2);
    expect(executeQueryMock).toHaveBeenCalledTimes(1);

    // Second call should hit cache, not database
    const secondResults = await weatherService.getWeatherDataByType(type, stationId);
    expect(secondResults).toHaveLength(2);
    expect(executeQueryMock).toHaveBeenCalledTimes(1); // Still 1, not 2

    // Verify results are identical
    expect(firstResults).toEqual(secondResults);
  });

  it('should store results as array under station:type key format', async () => {
    const stationId = 'STATION001';
    const type = 'temperature';

    await weatherService.getWeatherDataByType(type, stationId);

    // Verify the cache was populated (we can't directly inspect the cache,
    // but we can verify by checking that a second call doesn't hit the DB)
    const dbCallsBefore = executeQueryMock.mock.calls.length;
    await weatherService.getWeatherDataByType(type, stationId);
    const dbCallsAfter = executeQueryMock.mock.calls.length;

    expect(dbCallsAfter).toBe(dbCallsBefore); // No additional DB calls
  });

  it('should return cached results for subsequent identical queries', async () => {
    const stationId = 'STATION001';
    const type = 'temperature';

    // Make 3 identical queries
    const results1 = await weatherService.getWeatherDataByType(type, stationId);
    const results2 = await weatherService.getWeatherDataByType(type, stationId);
    const results3 = await weatherService.getWeatherDataByType(type, stationId);

    // All should return same results
    expect(results1).toEqual(results2);
    expect(results2).toEqual(results3);

    // But database should only be hit once
    expect(executeQueryMock).toHaveBeenCalledTimes(1);
  });

  it('should distinguish between different types for the same station', async () => {
    const stationId = 'STATION001';

    // Query two different types
    await weatherService.getWeatherDataByType('temperature', stationId);
    await weatherService.getWeatherDataByType('humidity', stationId);

    // Both should have different cache keys, hitting DB twice
    expect(executeQueryMock).toHaveBeenCalledTimes(2);

    // Repeat queries should hit cache
    await weatherService.getWeatherDataByType('temperature', stationId);
    await weatherService.getWeatherDataByType('humidity', stationId);

    // Still just 2 DB calls total
    expect(executeQueryMock).toHaveBeenCalledTimes(2);
  });
});
