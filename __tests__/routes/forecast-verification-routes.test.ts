import express from 'express';
import request from 'supertest';
import { createForecastVerificationRouter } from '../../server/routes/forecast-verification-routes.js';
import { ForecastVerificationService } from '../../server/services/forecast/forecast-verification-service.js';

function validPayload() {
  return {
    forecastRef: { cid: 'bafyreport', model: 'WRF', runId: 'run_49' },
    validTimeRange: {
      start: '2026-03-05T12:00:00Z',
      end: '2026-03-05T13:00:00Z',
    },
    domainBounds: {
      north: 41,
      south: 39,
      west: -106,
      east: -104,
    },
    grid: {
      temperature: {
        latitudes: [40],
        longitudes: [-105],
        values: [[20]],
      },
      windSpeed: {
        latitudes: [40],
        longitudes: [-105],
        values: [[5]],
      },
      precipitation: {
        latitudes: [40],
        longitudes: [-105],
        values: [[0.1]],
      },
    },
  };
}

describe('forecast verification routes', () => {
  it('returns verification report payload for valid requests', async () => {
    const app = express();
    app.use(express.json());
    const service = new ForecastVerificationService({
      observationProvider: {
        fetchObservations: async () => [
          {
            stationId: 'STATION_A',
            latitude: 40.0,
            longitude: -105.0,
            timestamp: '2026-03-05T12:00:00Z',
            temperature: 20,
            windSpeed: 5,
            precipitation: 0.1,
          },
        ],
      },
    });
    app.use('/api', createForecastVerificationRouter(service, { requireAuth: false }));

    const response = await request(app)
      .post('/api/compute/forecast/verify')
      .send(validPayload());

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.report.forecastRef.cid).toBe('bafyreport');
    expect(response.body.report.stationCount).toBe(1);
    expect(response.body.report.reportHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns validation failure for malformed payloads', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createForecastVerificationRouter(undefined, { requireAuth: false }));

    const response = await request(app)
      .post('/api/compute/forecast/verify')
      .send({ forecastRef: { cid: '' } });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  it('maps upstream observation fetch failures to 502', async () => {
    const app = express();
    app.use(express.json());

    const service = new ForecastVerificationService({
      observationProvider: {
        fetchObservations: async () => {
          throw new Error('NOAA down');
        },
      },
    });

    app.use('/api', createForecastVerificationRouter(service, { requireAuth: false }));

    const response = await request(app)
      .post('/api/compute/forecast/verify')
      .send(validPayload());

    expect(response.status).toBe(502);
    expect(response.body.success).toBe(false);
  });

  it('rejects oversized requests based on payload size', async () => {
    const app = express();
    app.use(express.json({ limit: '10mb' }));

    const service = new ForecastVerificationService({
      observationProvider: {
        fetchObservations: async () => [],
      },
    });

    app.use('/api', createForecastVerificationRouter(service, { requireAuth: false }));

    const hugePayload = {
      ...validPayload(),
      debugBlob: 'x'.repeat(3 * 1024 * 1024),
    };

    const response = await request(app)
      .post('/api/compute/forecast/verify')
      .send(hugePayload);

    expect(response.status).toBe(413);
    expect(response.body.success).toBe(false);
  });

  it('requires an auth token by default', async () => {
    const app = express();
    app.use(express.json());
    const service = new ForecastVerificationService({
      observationProvider: {
        fetchObservations: async () => [
          {
            stationId: 'STATION_A',
            latitude: 40.0,
            longitude: -105.0,
            timestamp: '2026-03-05T12:00:00Z',
            temperature: 20,
            windSpeed: 5,
            precipitation: 0.1,
          },
        ],
      },
    });
    app.use('/api', createForecastVerificationRouter(service, { authToken: 'secret-token' }));

    const unauthorized = await request(app)
      .post('/api/compute/forecast/verify')
      .send(validPayload());
    expect(unauthorized.status).toBe(401);

    const authorized = await request(app)
      .post('/api/compute/forecast/verify')
      .set('Authorization', 'Bearer secret-token')
      .send(validPayload());
    expect(authorized.status).toBe(201);
  });
});
