import express from 'express';
import request from 'supertest';

// Mock physics-validation before importing the router
const mockValidatePhysics = jest.fn();
const mockQualityScore = jest.fn();
jest.mock('../server/services/physics-validation.js', () => ({
  validatePhysics: mockValidatePhysics,
  qualityScore: mockQualityScore,
  DEFAULT_PHYSICS_POLICY: {
    tempMinC: -89.2, tempMaxC: 70.7,
    pressureMinHpa: 870.0, pressureMaxHpa: 1085.0,
    humidityMinPct: 0.0, humidityMaxPct: 100.0,
    windSpeedMaxMs: 113.3, tempRateMaxCPerMin: 5.0,
  },
}));

import { createSensorIngestRouter } from '../server/routes/sensor-ingest-routes.js';

type Row = Record<string, unknown>;

function makeDb(responses: { rows: Row[] }[]) {
  let call = 0;
  return {
    execute: jest.fn(async (_sql: string, _params?: unknown[]) => {
      return responses[call++] ?? { rows: [] };
    }),
  };
}

function makeApp(db: { execute: jest.Mock }) {
  const app = express();
  app.use(express.json());
  app.use('/api/sensors', createSensorIngestRouter(db as any));
  return app;
}

const VALID_ADDR   = '0xaBcD1234567890aBcD1234567890aBcD12345678';
const VALID_BODY   = {
  walletAddress:  VALID_ADDR,
  deviceId:       'device-001',
  latitude:       51.5,
  longitude:      -0.12,
  temperature:    20.5,
  pressure:       1013.25,
  humidity:       55,
  timestampUnix:  1700000000,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockValidatePhysics.mockReturnValue([]);
  mockQualityScore.mockReturnValue(100);
});

describe('POST /api/sensors/reading', () => {
  it('accepts a valid reading with no violations', async () => {
    const db = makeDb([
      { rows: [{ '?column?': 1 }] }, // social_accounts exists
      { rows: [{ id: 42 }] },         // users lookup
      { rows: [] },                   // INSERT
    ]);
    const app = makeApp(db);

    const res = await request(app).post('/api/sensors/reading').send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    expect(res.body.qualityScore).toBe(100);
    expect(res.body.violations).toEqual([]);
    expect(mockValidatePhysics).toHaveBeenCalledWith(
      expect.objectContaining({ temperatureC: 20.5, pressureHpa: 1013.25, humidityPct: 55 }),
      null,
      expect.any(Object),
    );
  });

  it('returns 403 when no social account is linked', async () => {
    const db = makeDb([{ rows: [] }]); // social_accounts empty
    const app = makeApp(db);

    const res = await request(app).post('/api/sensors/reading').send(VALID_BODY);

    expect(res.status).toBe(403);
    expect(mockValidatePhysics).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid walletAddress', async () => {
    const db = makeDb([]);
    const app = makeApp(db);

    const res = await request(app)
      .post('/api/sensors/reading')
      .send({ ...VALID_BODY, walletAddress: 'not-an-address' });

    expect(res.status).toBe(400);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('returns 400 for humidity > 100', async () => {
    const db = makeDb([]);
    const app = makeApp(db);

    const res = await request(app)
      .post('/api/sensors/reading')
      .send({ ...VALID_BODY, humidity: 105 });

    expect(res.status).toBe(400);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('accepts reading with physics violations and returns degraded quality score', async () => {
    const violation = { type: 'TemperatureOutOfRange', valueC: 100, min: -89.2, max: 70.7 };
    mockValidatePhysics.mockReturnValue([violation]);
    mockQualityScore.mockReturnValue(80);

    const db = makeDb([
      { rows: [{ '?column?': 1 }] }, // social_accounts
      { rows: [] },                   // users not found → userId = null
      { rows: [] },                   // INSERT
    ]);
    const app = makeApp(db);

    const res = await request(app)
      .post('/api/sensors/reading')
      .send({ ...VALID_BODY, temperature: 100 });

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    expect(res.body.qualityScore).toBe(80);
    expect(res.body.violations).toHaveLength(1);
    expect(res.body.violations[0].type).toBe('TemperatureOutOfRange');
  });

  it('passes previousReading to validatePhysics for rate-of-change check', async () => {
    const db = makeDb([
      { rows: [{ '?column?': 1 }] },
      { rows: [{ id: 7 }] },
      { rows: [] },
    ]);
    const app = makeApp(db);

    const prevReading = { temperature: 18, timestampUnix: 1699999940 };

    await request(app)
      .post('/api/sensors/reading')
      .send({ ...VALID_BODY, previousReading: prevReading });

    expect(mockValidatePhysics).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ temperatureC: 18, timestampUnix: 1699999940 }),
      expect.any(Object),
    );
  });

  it('proceeds without user_id when user not found in users table', async () => {
    const db = makeDb([
      { rows: [{ '?column?': 1 }] }, // social_accounts exists
      { rows: [] },                   // users not found
      { rows: [] },                   // INSERT succeeds
    ]);
    const app = makeApp(db);

    const res = await request(app).post('/api/sensors/reading').send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    // Third call (INSERT) should have null as first param (user_id)
    expect(db.execute.mock.calls[2][1]![0]).toBeNull();
  });

  it('returns 400 when required fields are missing', async () => {
    const db = makeDb([]);
    const app = makeApp(db);

    const res = await request(app)
      .post('/api/sensors/reading')
      .send({ walletAddress: VALID_ADDR }); // missing deviceId, lat, lng, timestampUnix

    expect(res.status).toBe(400);
    expect(db.execute).not.toHaveBeenCalled();
  });
});
