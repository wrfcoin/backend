import express from 'express';
import request from 'supertest';
import { createSatelliteIngestionRouter } from '../../server/routes/satellite-ingestion-routes.js';
import { NoaaGoesIngestionService } from '../../server/services/satellite/noaa-goes-ingestion-service.js';

function goesXmlListing(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Contents>
    <Key>ABI-L2-CMIPF/2026/064/12/OR_ABI-L2-CMIPF-M6C13_G16_s20260641200200_e20260641209508_c20260641209583.nc</Key>
    <LastModified>2026-03-05T12:09:59.000Z</LastModified>
    <ETag>"etag-1"</ETag>
    <Size>14567231</Size>
  </Contents>
</ListBucketResult>`;
}

describe('satellite ingestion routes', () => {
  it('poll endpoint ingests GOES metadata and returns normalized observations', async () => {
    const service = new NoaaGoesIngestionService({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        text: async () => goesXmlListing(),
      }),
      nowFn: () => new Date('2026-03-05T12:30:00Z'),
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createSatelliteIngestionRouter(service, { requireAuth: false }));

    const response = await request(app)
      .post('/api/ingestion/satellite-goes/poll')
      .send({ maxKeys: 10 });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.result.ingestedRecords).toBe(1);
    expect(response.body.result.observations[0].provider).toBe('NOAA');
  });

  it('backfill endpoint validates required fields', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createSatelliteIngestionRouter(undefined, { requireAuth: false }));

    const response = await request(app)
      .post('/api/ingestion/satellite-goes/backfill')
      .send({ startTime: '2026-03-05T00:00:00Z' });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  it('maps upstream polling failures to 502', async () => {
    const service = new NoaaGoesIngestionService({
      fetchFn: async () => ({
        ok: false,
        status: 503,
        text: async () => '',
      }),
      nowFn: () => new Date('2026-03-05T12:30:00Z'),
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createSatelliteIngestionRouter(service, { requireAuth: false }));

    const response = await request(app)
      .post('/api/ingestion/satellite-goes/poll')
      .send({});

    expect(response.status).toBe(502);
    expect(response.body.success).toBe(false);
  });

  it('metrics endpoint returns operational ingestion metrics', async () => {
    const service = new NoaaGoesIngestionService({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        text: async () => goesXmlListing(),
      }),
      nowFn: () => new Date('2026-03-05T12:30:00Z'),
    });

    await service.pollLatest();

    const app = express();
    app.use(express.json());
    app.use('/api', createSatelliteIngestionRouter(service, { requireAuth: false }));

    const response = await request(app).get('/api/ingestion/satellite-goes/metrics');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.metrics.pollAttempts).toBe(1);
    expect(response.body.metrics.pollSuccesses).toBe(1);
    expect(response.body.metrics.backfillAttempts).toBe(0);
  });

  it('validates extract payload bounds shape', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createSatelliteIngestionRouter(undefined, { requireAuth: false }));

    const response = await request(app)
      .post('/api/ingestion/satellite-goes/extract')
      .send({ bounds: { west: -120, east: -70 } });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  it('requires auth token by default', async () => {
    const service = new NoaaGoesIngestionService({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        text: async () => goesXmlListing(),
      }),
      nowFn: () => new Date('2026-03-05T12:30:00Z'),
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createSatelliteIngestionRouter(service, { authToken: 'sat-secret' }));

    const unauthorized = await request(app)
      .post('/api/ingestion/satellite-goes/poll')
      .send({});
    expect(unauthorized.status).toBe(401);

    const authorized = await request(app)
      .post('/api/ingestion/satellite-goes/poll')
      .set('Authorization', 'Bearer sat-secret')
      .send({});
    expect(authorized.status).toBe(201);
  });
});
