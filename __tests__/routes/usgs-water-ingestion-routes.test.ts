import express from 'express';
import request from 'supertest';
import { createUsgsWaterIngestionRouter } from '../../server/routes/usgs-water-ingestion-routes.js';
import { UsgsWaterService } from '../../server/services/hydrology/usgs-water-service.js';

function ivPayload() {
  return {
    value: {
      timeSeries: [
        {
          sourceInfo: {
            siteName: 'Potomac River at Point of Rocks, MD',
            siteCode: [{ value: '01646500' }],
            geoLocation: {
              geogLocation: { latitude: 39.27455, longitude: -77.5436 },
            },
          },
          variable: { variableCode: [{ value: '00060' }] },
          values: [
            {
              value: [
                {
                  value: '12300',
                  dateTime: '2026-03-05T12:00:00.000-05:00',
                  qualifiers: ['A'],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

describe('USGS water ingestion routes', () => {
  it('ingests IV hydrological observations', async () => {
    const service = new UsgsWaterService({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ivPayload(),
        text: async () => '',
      }),
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createUsgsWaterIngestionRouter(service, { requireAuth: false }));

    const response = await request(app)
      .post('/api/ingestion/usgs-water/iv')
      .send({ siteNumbers: ['01646500'] });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.observations[0].station.siteNumber).toBe('01646500');
  });

  it('validates site discovery filter requirements', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createUsgsWaterIngestionRouter(undefined, { requireAuth: false }));

    const response = await request(app).get('/api/ingestion/usgs-water/sites');

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  it('validates bbox query format for site discovery', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createUsgsWaterIngestionRouter(undefined, { requireAuth: false }));

    const response = await request(app).get('/api/ingestion/usgs-water/sites?bbox=bad-value');

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  it('maps upstream failures to 502', async () => {
    const service = new UsgsWaterService({
      fetchFn: async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
        text: async () => '',
      }),
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createUsgsWaterIngestionRouter(service, { requireAuth: false }));

    const response = await request(app)
      .post('/api/ingestion/usgs-water/iv')
      .send({ siteNumbers: ['01646500'] });

    expect(response.status).toBe(502);
    expect(response.body.success).toBe(false);
  });

  it('maps upstream 429 responses through for retry-aware clients', async () => {
    const service = new UsgsWaterService({
      fetchFn: async () => ({
        ok: false,
        status: 429,
        json: async () => ({}),
        text: async () => '',
      }),
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createUsgsWaterIngestionRouter(service, { requireAuth: false }));

    const response = await request(app)
      .post('/api/ingestion/usgs-water/iv')
      .send({ siteNumbers: ['01646500'] });

    expect(response.status).toBe(429);
    expect(response.body.success).toBe(false);
  });

  it('requires auth by default', async () => {
    const service = new UsgsWaterService({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ivPayload(),
        text: async () => '',
      }),
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createUsgsWaterIngestionRouter(service, { authToken: 'water-secret' }));

    const unauthorized = await request(app)
      .post('/api/ingestion/usgs-water/iv')
      .send({ siteNumbers: ['01646500'] });
    expect(unauthorized.status).toBe(401);

    const authorized = await request(app)
      .post('/api/ingestion/usgs-water/iv')
      .set('Authorization', 'Bearer water-secret')
      .send({ siteNumbers: ['01646500'] });
    expect(authorized.status).toBe(201);

    const apiKeyAuthorized = await request(app)
      .post('/api/ingestion/usgs-water/iv')
      .set('X-API-Key', 'water-secret')
      .send({ siteNumbers: ['01646500'] });
    expect(apiKeyAuthorized.status).toBe(201);
  });

  it('returns 503 when auth is required but no token is configured', async () => {
    const service = new UsgsWaterService({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ivPayload(),
        text: async () => '',
      }),
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createUsgsWaterIngestionRouter(service));

    const response = await request(app)
      .post('/api/ingestion/usgs-water/iv')
      .send({ siteNumbers: ['01646500'] });
    expect(response.status).toBe(503);
  });
});
