const executeQueryMock = jest.fn();

jest.mock('../../database/index.js', () => ({
  executeQuery: executeQueryMock,
}), { virtual: true });

jest.mock('../../server/utils/logger.js', () => ({
  weatherLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  appLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}), { virtual: true });

import WeatherDataIngestionOrchestrator from '../../server/services/weather-data-ingestion-orchestrator.js';
import { createWeatherDataService } from '../../server/services/weather-data-service.js';

describe('Weather persistence paths', () => {
  beforeEach(() => {
    executeQueryMock.mockReset();
    executeQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM users')) {
        return { rows: [{ id: 7 }] };
      }
      if (sql.includes('INSERT INTO weather_submissions')) {
        return {
          rows: [
            {
              id: 222,
              submitted_at: '2026-03-28T15:00:00.000Z',
            },
          ],
        };
      }
      return { rows: [] };
    });
  });

  it('weather ingestion orchestrator storage persists to weather_submissions', async () => {
    const orchestrator = new (WeatherDataIngestionOrchestrator as any)();

    const result = await orchestrator.executeStorage(
      {
        metadata: {
          sourceId: 'KORD',
          provider: 'NOAA-NWS',
          timestamp: '2026-03-28T15:00:00.000Z',
        },
        location: {
          latitude: 41.98,
          longitude: -87.9,
          elevation: 205,
        },
        measurements: {
          temperature: { value: 20.5 },
          humidity: { value: 61 },
          pressure: { value: 1012.8 },
        },
      },
      { source: 'test_orchestrator' }
    );

    expect(result.completed).toBe(true);
    expect(result.result).toEqual({
      stored: true,
      recordId: 222,
      timestamp: '2026-03-28T15:00:00.000Z',
    });
    expect(executeQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO weather_submissions'),
      expect.arrayContaining([
        null,
        null,
        null,
        'KORD',
      ])
    );
  });

  it('weather data service storeInDatabase writes through the shared persistence path', async () => {
    const service = createWeatherDataService();

    await (service as any).storeInDatabase({
      type: 'temperature',
      id: 'wx-temp-1',
      stationId: 'STATION123',
      timestamp: new Date('2026-03-28T15:00:00.000Z'),
      quality: 'high',
      value: 24.3,
      unit: '°C',
      dewPoint: 12.1,
    });

    expect(executeQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO weather_submissions'),
      expect.arrayContaining([
        null,
        null,
        null,
        'STATION123',
      ])
    );
  });
});
