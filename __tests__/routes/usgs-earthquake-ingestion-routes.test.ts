import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { createUsgsEarthquakeIngestionRouter } from '../../server/routes/usgs-earthquake-ingestion-routes.js';
import { UsgsEarthquakeService } from '../../server/services/seismic/usgs-earthquake-service.js';

function fixture(name: string): any {
  return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/seismic', name), 'utf8'));
}

describe('USGS earthquake ingestion routes', () => {
  it('ingests earthquake feed events', async () => {
    const service = new UsgsEarthquakeService({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => fixture('usgs-all-hour-sample.json'),
      }),
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createUsgsEarthquakeIngestionRouter(service, { requireAuth: false }));

    const response = await request(app)
      .post('/api/ingestion/usgs-earthquake/feed')
      .send({ feed: 'all', window: 'hour' });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.result.ingestedEvents).toBe(2);
  });

  it('returns ingested events and honors limit query', async () => {
    const service = new UsgsEarthquakeService({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => fixture('usgs-all-hour-sample.json'),
      }),
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createUsgsEarthquakeIngestionRouter(service, { requireAuth: false }));

    await request(app).post('/api/ingestion/usgs-earthquake/feed').send({});
    const response = await request(app).get('/api/ingestion/usgs-earthquake/events?limit=1');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.events).toHaveLength(1);
  });

  it('validates events limit query', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createUsgsEarthquakeIngestionRouter(undefined, { requireAuth: false }));

    const response = await request(app).get('/api/ingestion/usgs-earthquake/events?limit=bad');

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  it('returns metrics after feed poll attempts', async () => {
    const service = new UsgsEarthquakeService({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => fixture('usgs-all-hour-sample.json'),
      }),
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createUsgsEarthquakeIngestionRouter(service, { requireAuth: false }));

    await request(app).post('/api/ingestion/usgs-earthquake/feed').send({});
    const response = await request(app).get('/api/ingestion/usgs-earthquake/metrics');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.metrics.pollAttempts).toBe(1);
    expect(response.body.metrics.pollSuccesses).toBe(1);
  });

  it('maps upstream failures to 502', async () => {
    const service = new UsgsEarthquakeService({
      fetchFn: async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
      }),
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createUsgsEarthquakeIngestionRouter(service, { requireAuth: false }));

    const response = await request(app).post('/api/ingestion/usgs-earthquake/feed').send({});

    expect(response.status).toBe(502);
    expect(response.body.success).toBe(false);
  });

  it('maps upstream 429 responses through for retry-aware clients', async () => {
    const service = new UsgsEarthquakeService({
      fetchFn: async () => ({
        ok: false,
        status: 429,
        json: async () => ({}),
      }),
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createUsgsEarthquakeIngestionRouter(service, { requireAuth: false }));

    const response = await request(app).post('/api/ingestion/usgs-earthquake/feed').send({});

    expect(response.status).toBe(429);
    expect(response.body.success).toBe(false);
  });

  it('requires auth by default', async () => {
    const service = new UsgsEarthquakeService({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => fixture('usgs-all-hour-sample.json'),
      }),
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createUsgsEarthquakeIngestionRouter(service, { authToken: 'quake-secret' }));

    const unauthorized = await request(app).post('/api/ingestion/usgs-earthquake/feed').send({});
    expect(unauthorized.status).toBe(401);

    const bearerAuthorized = await request(app)
      .post('/api/ingestion/usgs-earthquake/feed')
      .set('Authorization', 'Bearer quake-secret')
      .send({});
    expect(bearerAuthorized.status).toBe(201);

    const apiKeyAuthorized = await request(app)
      .post('/api/ingestion/usgs-earthquake/feed')
      .set('X-API-Key', 'quake-secret')
      .send({});
    expect(apiKeyAuthorized.status).toBe(201);
  });

  it('returns 503 when auth is required but no token is configured', async () => {
    const service = new UsgsEarthquakeService({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => fixture('usgs-all-hour-sample.json'),
      }),
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createUsgsEarthquakeIngestionRouter(service));

    const response = await request(app).post('/api/ingestion/usgs-earthquake/feed').send({});
    expect(response.status).toBe(503);
  });
});
