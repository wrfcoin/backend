import express from 'express';
import request from 'supertest';
import { createNrcsSoilIngestionRouter } from '../../server/routes/nrcs-soil-ingestion-routes.js';
import { NrcsSoilService } from '../../server/services/soil/nrcs-soil-service.js';

function scanPayload() {
  return {
    stations: [
      {
        triplet: '2057:AL:SCAN',
        stationName: 'Auburn SCAN',
        network: 'SCAN',
        latitude: 32.6012,
        longitude: -85.4881,
        elevationMeters: 214.6,
        observations: [
          {
            timestamp: '2026-03-05T12:00:00.000-06:00',
            duration: 'HOURLY',
            values: {
              'SMS:I-1': 21.8,
              'SMS:I-2': 23.4,
              'SMS:I-3': 26.1,
              'SMS:I-4': 29.9,
              'STO:I-1': 15.2,
              PREC: 1.3,
            },
          },
        ],
      },
    ],
  };
}

function snotelPayload() {
  return {
    stations: [
      {
        triplet: '304:CA:SNTL',
        stationName: 'Mammoth Pass',
        network: 'SNOTEL',
        latitude: 37.6294,
        longitude: -119.0326,
        elevationMeters: 2859,
        observations: [
          {
            dateTime: '2026-03-05T00:00:00.000-08:00',
            duration: 'DAILY',
            values: {
              WTEQ: 412,
              SNWD: 141,
              PRCP: 9.8,
              TAVG: -3.1,
            },
          },
        ],
      },
    ],
  };
}

describe('NRCS soil ingestion routes', () => {
  it('ingests SCAN environmental observations', async () => {
    const service = new NrcsSoilService({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => scanPayload(),
      }),
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createNrcsSoilIngestionRouter(service, { requireAuth: false }));

    const response = await request(app)
      .post('/api/ingestion/nrcs-soil/scan')
      .send({ stationTriplets: ['2057:AL:SCAN'] });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.observations[0].station.triplet).toBe('2057:AL:SCAN');
  });

  it('ingests SNOTEL environmental observations', async () => {
    const service = new NrcsSoilService({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => snotelPayload(),
      }),
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createNrcsSoilIngestionRouter(service, { requireAuth: false }));

    const response = await request(app)
      .post('/api/ingestion/nrcs-soil/snotel')
      .send({ stationTriplets: ['304:CA:SNTL'] });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.observations[0].network).toBe('SNOTEL');
  });

  it('returns stations metadata', async () => {
    const payload = {
      stations: [
        {
          triplet: '2057:AL:SCAN',
          stationName: 'Auburn SCAN',
          network: 'SCAN',
          latitude: 32.6012,
          longitude: -85.4881,
          elevationMeters: 214.6,
        },
      ],
    };
    const service = new NrcsSoilService({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => payload,
      }),
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createNrcsSoilIngestionRouter(service, { requireAuth: false }));

    const response = await request(app)
      .get('/api/ingestion/nrcs-soil/stations?network=SCAN&stationTriplets=2057:AL:SCAN');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.count).toBe(1);
    expect(response.body.stations[0].triplet).toBe('2057:AL:SCAN');
  });

  it('validates network query format for stations', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', createNrcsSoilIngestionRouter(undefined, { requireAuth: false }));

    const response = await request(app).get('/api/ingestion/nrcs-soil/stations?network=bad');

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });

  it('maps upstream failures to 502', async () => {
    const service = new NrcsSoilService({
      fetchFn: async () => ({
        ok: false,
        status: 503,
        json: async () => ({}),
      }),
      scanStationTriplets: ['2057:AL:SCAN'],
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createNrcsSoilIngestionRouter(service, { requireAuth: false }));

    const response = await request(app).post('/api/ingestion/nrcs-soil/scan').send({});

    expect(response.status).toBe(502);
    expect(response.body.success).toBe(false);
  });

  it('maps upstream 429 responses through for retry-aware clients', async () => {
    const service = new NrcsSoilService({
      fetchFn: async () => ({
        ok: false,
        status: 429,
        json: async () => ({}),
      }),
      scanStationTriplets: ['2057:AL:SCAN'],
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createNrcsSoilIngestionRouter(service, { requireAuth: false }));

    const response = await request(app).post('/api/ingestion/nrcs-soil/scan').send({});

    expect(response.status).toBe(429);
    expect(response.body.success).toBe(false);
  });

  it('returns ingestion metrics', async () => {
    const service = new NrcsSoilService({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => scanPayload(),
      }),
      scanStationTriplets: ['2057:AL:SCAN'],
      snotelStationTriplets: ['304:CA:SNTL'],
      scanPollIntervalMs: 111000,
      snotelPollIntervalMs: 222000,
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createNrcsSoilIngestionRouter(service, { requireAuth: false }));

    const response = await request(app).get('/api/ingestion/nrcs-soil/metrics');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.metrics.scanPollIntervalMs).toBe(111000);
    expect(response.body.metrics.configuredScanStations).toEqual(['2057:AL:SCAN']);
  });

  it('requires auth by default', async () => {
    const service = new NrcsSoilService({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => scanPayload(),
      }),
      scanStationTriplets: ['2057:AL:SCAN'],
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createNrcsSoilIngestionRouter(service, { authToken: 'soil-secret' }));

    const unauthorized = await request(app).post('/api/ingestion/nrcs-soil/scan').send({});
    expect(unauthorized.status).toBe(401);

    const authorized = await request(app)
      .post('/api/ingestion/nrcs-soil/scan')
      .set('Authorization', 'Bearer soil-secret')
      .send({});
    expect(authorized.status).toBe(201);

    const apiKeyAuthorized = await request(app)
      .post('/api/ingestion/nrcs-soil/scan')
      .set('X-API-Key', 'soil-secret')
      .send({});
    expect(apiKeyAuthorized.status).toBe(201);
  });

  it('returns 503 when auth is required but no token is configured', async () => {
    const service = new NrcsSoilService({
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => scanPayload(),
      }),
      scanStationTriplets: ['2057:AL:SCAN'],
    });

    const app = express();
    app.use(express.json());
    app.use('/api', createNrcsSoilIngestionRouter(service));

    const response = await request(app).post('/api/ingestion/nrcs-soil/scan').send({});
    expect(response.status).toBe(503);
  });
});
