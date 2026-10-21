import request from 'supertest';

process.env.NODE_ENV = 'development';
process.env.CORS_ORIGIN = 'http://localhost:3000';

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
  recordWeatherPayloadFormatMetric: jest.fn(),
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

describe('Weather submit idempotency (#463)', () => {
  it('replays with X-Idempotent-Replay on second submit with same idempotency key', async () => {
    const IDEMPOTENCY_KEY = `test-idem-${Date.now()}`;
    const payload = {
      schema_version: 'wrf.weather.observation.v1',
      station_id: `station-idem-${Date.now()}`,
      observed_at_unix: 1_700_200_200,
      observation: {
        humidity: 55.0,
        temperature: 21.3,
      },
    };

    // First submission — should succeed fresh (no replay header)
    const first = await request(app)
      .post('/api/weather/submit')
      .set('Origin', 'http://localhost:3000')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send(payload);

    expect(first.status).toBeLessThan(400);
    expect(first.body.success).toBe(true);
    expect(first.headers['x-idempotent-replay']).toBeUndefined();

    // Second submission — same key, must be an idempotent replay
    const second = await request(app)
      .post('/api/weather/submit')
      .set('Origin', 'http://localhost:3000')
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send(payload);

    expect(second.status).toBeLessThan(400);
    expect(second.body.success).toBe(true);
    expect(second.headers['x-idempotent-replay']).toBe('true');
    expect(second.body.data.replayed).toBe(true);
  });
});
