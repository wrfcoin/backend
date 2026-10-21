import request from 'supertest';

process.env.NODE_ENV = 'development';
process.env.CORS_ORIGIN = 'http://localhost:3000';

const recordWeatherPayloadFormatMetricMock = jest.fn();

jest.mock('../shared/graceful-shutdown/index.js', () => ({
  GracefulShutdown: {
    getInstance: () => ({
      registerHandler: jest.fn(),
      setupSignalHandlers: jest.fn(),
    }),
  },
  createHttpServerShutdownHandler: jest.fn(() => ({
    name: 'noop',
    shutdown: async () => {},
  })),
  ShutdownPriority: {
    STOP_ACCEPTING_CONNECTIONS: 10,
    DRAIN_HTTP_CONNECTIONS: 20,
    CLOSE_WEBSOCKETS: 30,
    STOP_BACKGROUND_JOBS: 40,
    FLUSH_QUEUES: 50,
    CLOSE_DATABASE: 60,
    CLOSE_CACHE: 70,
    FLUSH_LOGS: 80,
    CLEANUP: 90,
  },
}));

jest.mock('../middleware/input-validation', () => ({
  transferValidation: [],
  weatherValidation: [],
  handleValidationErrors: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

jest.mock('../server/utils/metrics.js', () => ({
  recordWeatherPayloadFormatMetric: recordWeatherPayloadFormatMetricMock,
}));

jest.mock('../server/services/weather-submission-persistence.js', () => ({
  persistWeatherSubmission: jest.fn(async (input: Record<string, unknown>) => ({
    id: `persisted-${Date.now()}`,
    stationId: input.stationId,
    timestamp: input.timestamp,
    storedAt: new Date().toISOString(),
    source: 'mock-persistence',
  })),
}));

import app from '../server/unified_api_server.js';

describe('Weather submit wired canonical/telemetry paths', () => {
  beforeEach(() => {
    recordWeatherPayloadFormatMetricMock.mockClear();
  });

  it('returns canonical outbound payload for canonical-v1-only submit body', async () => {
    const response = await request(app)
      .post('/api/weather/submit')
      .set('Origin', 'http://localhost:3000')
      .send({
        schema_version: 'wrf.weather.observation.v1',
        station_id: 'station-submit-canonical-1',
        observed_at_unix: 1_700_200_101,
        observation: {
          humidity: 48.2,
        },
      });

    expect([200, 201]).toContain(response.status);
    expect(response.body.success).toBe(true);
    expect(response.body.data.stationId).toBe('station-submit-canonical-1');
    expect(response.body.data.canonicalPayload).toEqual({
      schema_version: 'wrf.weather.observation.v1',
      station_id: 'station-submit-canonical-1',
      observed_at_unix: 1_700_200_101,
      observation: {
        humidity: 48.2,
      },
    });
    expect(response.body.data.canonicalTelemetry).toBeUndefined();
    expect(response.body.data.sensors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'humidity',
          value: 48.2,
          unit: 'percent',
        }),
      ])
    );
    expect(recordWeatherPayloadFormatMetricMock).toHaveBeenCalledWith(
      '/api/weather/submit',
      undefined
    );
  });

  it('returns legacy-format-detected telemetry for alias-based submit body', async () => {
    const response = await request(app)
      .post('/api/weather/submit')
      .set('Origin', 'http://localhost:3000')
      .send({
        stationId: 'station-submit-legacy-1',
        timestamp: new Date().toISOString(),
        amount: 0.12,
        sensorData: [
          {
            type: 'temperature',
            value: 19.4,
            unit: 'celsius',
            status: 'active',
          },
        ],
        temp_c: 19.4,
      });

    expect([200, 201]).toContain(response.status);
    expect(response.body.success).toBe(true);
    expect(response.body.data.stationId).toBe('station-submit-legacy-1');
    expect(response.body.data.canonicalPayload.schema_version).toBe(
      'wrf.weather.observation.v1'
    );
    expect(response.body.data.canonicalTelemetry).toEqual(
      expect.objectContaining({
        event: 'legacy-format-detected',
        schemaVersion: 'wrf.weather.observation.v1',
        source: 'legacy-flat',
      })
    );
    expect(response.body.data.canonicalTelemetry.legacyKeys).toEqual(
      expect.arrayContaining(['stationId', 'temp_c'])
    );
    expect(recordWeatherPayloadFormatMetricMock).toHaveBeenCalledWith(
      '/api/weather/submit',
      expect.objectContaining({
        event: 'legacy-format-detected',
        source: 'legacy-flat',
      })
    );
  });
});
